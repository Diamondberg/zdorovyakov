ALTER TABLE customers ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE promotions ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE TABLE customer_email_changes (
  customer_id uuid PRIMARY KEY REFERENCES customers(id),
  pending_email text NOT NULL,
  requested_by uuid NOT NULL REFERENCES admin_users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  CHECK(pending_email=lower(btrim(pending_email)))
);
CREATE TABLE order_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  admin_id uuid NOT NULL REFERENCES admin_users(id),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_comments_order_idx ON order_comments(order_id,created_at);
CREATE INDEX order_comments_admin_idx ON order_comments(admin_id);
CREATE TRIGGER order_comments_immutable BEFORE UPDATE OR DELETE ON order_comments FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
