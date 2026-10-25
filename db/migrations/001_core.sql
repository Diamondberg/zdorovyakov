CREATE TABLE storefronts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  domain text NOT NULL UNIQUE,
  name text NOT NULL,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  retail_price_minor bigint NOT NULL CHECK(retail_price_minor BETWEEN 0 AND 100000000),
  purchase_price_minor bigint NOT NULL CHECK(purchase_price_minor BETWEEN 0 AND 100000000),
  currency text NOT NULL DEFAULT 'RUB' CHECK(currency = 'RUB'),
  volume_ml integer CHECK(volume_ml > 0),
  weight_g integer CHECK(weight_g > 0),
  dimensions_mm jsonb,
  packaging jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE storefront_products (
  storefront_id uuid NOT NULL REFERENCES storefronts(id),
  product_id uuid NOT NULL REFERENCES products(id),
  PRIMARY KEY(storefront_id, product_id)
);
CREATE INDEX storefront_products_product_idx ON storefront_products(product_id);
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL,
  last_name text NOT NULL,
  acquired_storefront_id uuid NOT NULL REFERENCES storefronts(id),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_storefront_idx ON customers(acquired_storefront_id);
CREATE TABLE customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  kind text NOT NULL CHECK(kind IN ('email','phone')),
  normalized_value text NOT NULL,
  verified_at timestamptz,
  CHECK(kind <> 'email' OR normalized_value = lower(btrim(normalized_value)))
);
CREATE UNIQUE INDEX verified_customer_email_idx ON customer_contacts(normalized_value)
  WHERE kind = 'email' AND verified_at IS NOT NULL;
CREATE INDEX customer_contacts_customer_idx ON customer_contacts(customer_id);
CREATE INDEX customer_contacts_value_idx ON customer_contacts(kind, normalized_value);
CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  country text NOT NULL, region text, city text NOT NULL, postal_code text,
  address text, pickup_point text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses(customer_id);
CREATE TABLE customer_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  purpose text NOT NULL CHECK(purpose IN ('order_processing','marketing')),
  granted boolean NOT NULL,
  document_version text NOT NULL,
  source text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_consents_customer_idx ON customer_consents(customer_id);
CREATE TABLE carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storefront_id uuid NOT NULL REFERENCES storefronts(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX carts_storefront_idx ON carts(storefront_id);
CREATE TABLE cart_items (
  cart_id uuid NOT NULL REFERENCES carts(id),
  product_id uuid NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 999),
  PRIMARY KEY(cart_id, product_id)
);
CREATE INDEX cart_items_product_idx ON cart_items(product_id);
CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  CHECK(ends_at > starts_at)
);
CREATE TABLE promotion_products (
  promotion_id uuid NOT NULL REFERENCES promotions(id),
  product_id uuid NOT NULL REFERENCES products(id),
  PRIMARY KEY(promotion_id, product_id)
);
CREATE INDEX promotion_products_product_idx ON promotion_products(product_id);
CREATE TABLE promotion_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES promotions(id),
  min_quantity integer NOT NULL CHECK(min_quantity BETWEEN 1 AND 999),
  discount_bps integer NOT NULL CHECK(discount_bps BETWEEN 0 AND 10000),
  UNIQUE(promotion_id, min_quantity)
);
CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','manager')),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions(admin_id);
CREATE SEQUENCE order_number_seq;
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE DEFAULT ('Z-' || lpad(nextval('order_number_seq')::text, 10, '0')),
  customer_id uuid NOT NULL REFERENCES customers(id),
  storefront_id uuid NOT NULL REFERENCES storefronts(id),
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  processing_status text NOT NULL DEFAULT 'new' CHECK(processing_status IN ('new','confirmed','assembling','assembled','cancelled')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid','refund_pending','refunded')),
  delivery_status text NOT NULL DEFAULT 'not_shipped' CHECK(delivery_status IN ('not_shipped','prepared','shipped','in_transit','pickup_ready','delivered','returned')),
  items_subtotal_minor bigint NOT NULL CHECK(items_subtotal_minor >= 0),
  discount_minor bigint NOT NULL CHECK(discount_minor >= 0 AND discount_minor <= items_subtotal_minor),
  items_total_minor bigint NOT NULL CHECK(items_total_minor = items_subtotal_minor - discount_minor),
  shipping_minor bigint CHECK(shipping_minor >= 0),
  total_minor bigint,
  currency text NOT NULL DEFAULT 'RUB' CHECK(currency = 'RUB'),
  recipient_snapshot jsonb NOT NULL,
  shipping_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((shipping_minor IS NULL AND total_minor IS NULL) OR
    (shipping_minor IS NOT NULL AND total_minor IS NOT NULL AND total_minor = items_total_minor + shipping_minor))
);
CREATE INDEX orders_customer_idx ON orders(customer_id, created_at);
CREATE INDEX orders_storefront_idx ON orders(storefront_id, created_at);
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  sku text NOT NULL, name text NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 999),
  list_unit_price_minor bigint NOT NULL CHECK(list_unit_price_minor >= 0),
  sale_unit_price_minor bigint NOT NULL CHECK(sale_unit_price_minor BETWEEN 0 AND list_unit_price_minor),
  purchase_unit_price_minor bigint NOT NULL CHECK(purchase_unit_price_minor >= 0),
  discount_minor bigint NOT NULL CHECK(discount_minor = (list_unit_price_minor - sale_unit_price_minor) * quantity),
  line_total_minor bigint NOT NULL CHECK(line_total_minor = sale_unit_price_minor * quantity),
  promotion_snapshot jsonb,
  bundle_code text,
  UNIQUE(order_id, product_id)
);
CREATE INDEX order_items_product_idx ON order_items(product_id);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  kind text NOT NULL CHECK(kind IN ('payment','refund')),
  state text NOT NULL CHECK(state IN ('pending','confirmed','failed')),
  amount_minor bigint NOT NULL CHECK(amount_minor > 0),
  confirmed_at timestamptz,
  recorded_by uuid NOT NULL REFERENCES admin_users(id)
);
CREATE INDEX payments_order_idx ON payments(order_id);
CREATE INDEX payments_admin_idx ON payments(recorded_by);
CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  carrier text, tracking_number text,
  delivery_status text NOT NULL DEFAULT 'not_shipped' CHECK(delivery_status IN ('not_shipped','prepared','shipped','in_transit','pickup_ready','delivered','returned')),
  recipient_snapshot jsonb NOT NULL,
  address_snapshot jsonb NOT NULL,
  shipped_at timestamptz, delivered_at timestamptz
);
CREATE INDEX shipments_order_idx ON shipments(order_id);
CREATE TABLE notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id),
  customer_id uuid REFERENCES customers(id),
  event_type text NOT NULL,
  dedup_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, sent_at timestamptz, last_error text
);
CREATE INDEX notification_events_queue_idx ON notification_events(state, next_attempt_at);
CREATE INDEX notification_events_order_idx ON notification_events(order_id);
CREATE INDEX notification_events_customer_idx ON notification_events(customer_id);
CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES notification_events(id),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL, provider_message_id text, sanitized_error text
);
CREATE INDEX notification_attempts_event_idx ON notification_attempts(event_id);
CREATE TABLE order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  event_type text NOT NULL, from_status text, to_status text,
  actor_id uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events(order_id, created_at);
CREATE INDEX order_events_actor_idx ON order_events(actor_id);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES admin_users(id),
  action text NOT NULL, entity_type text NOT NULL, entity_id uuid,
  redacted_changes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_admin_idx ON audit_logs(admin_id);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id, created_at);
CREATE FUNCTION reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Event logs are append-only'; END;
$$;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE TRIGGER order_events_immutable BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE FUNCTION protect_order_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.customer_id IS DISTINCT FROM NEW.customer_id OR OLD.storefront_id IS DISTINCT FROM NEW.storefront_id
    OR OLD.items_total_minor IS DISTINCT FROM NEW.items_total_minor OR OLD.discount_minor IS DISTINCT FROM NEW.discount_minor
    OR OLD.items_subtotal_minor IS DISTINCT FROM NEW.items_subtotal_minor OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
    OR OLD.number IS DISTINCT FROM NEW.number THEN RAISE EXCEPTION 'Order history is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_history BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_history();
CREATE TRIGGER order_items_immutable BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE FUNCTION protect_shipped_address() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.shipped_at IS NOT NULL AND (OLD.recipient_snapshot IS DISTINCT FROM NEW.recipient_snapshot
    OR OLD.address_snapshot IS DISTINCT FROM NEW.address_snapshot OR OLD.shipped_at IS DISTINCT FROM NEW.shipped_at)
    THEN RAISE EXCEPTION 'Shipped address is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shipments_history BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION protect_shipped_address();
CREATE TABLE email_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL, code_hmac text NOT NULL, expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0), resend_at timestamptz NOT NULL,
  consumed_at timestamptz, session_binding text NOT NULL
);
CREATE INDEX email_challenges_email_idx ON email_challenges(email, expires_at);
CREATE TABLE order_amendment_tokens (
  token_hash text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  allowed_fields text[] NOT NULL,
  expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE INDEX order_amendment_order_idx ON order_amendment_tokens(order_id);
CREATE TABLE rate_limit_buckets (
  scope text NOT NULL, key_hash text NOT NULL, window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK(count >= 0), expires_at timestamptz NOT NULL,
  PRIMARY KEY(scope, key_hash, window_start)
);
