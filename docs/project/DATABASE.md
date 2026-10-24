# Концептуальная схема БД

Этап 1. Схема спроектирована; таблицы и исполняемые миграции будут на этапе 2.
PostgreSQL, UUID для внутренних ID, timestamptz UTC, денежные значения bigint
в копейках (в API безопасные целые числа с проверкой диапазона), валюта RUB.
Все FK индексируются по фактическим запросам; каскадное удаление заказов запрещено.

| Сущность | Ключевые данные и связи |
|---|---|
| Storefronts | id, slug UNIQUE, domain UNIQUE, allowed_origins, active |
| Products | id, sku UNIQUE, name, retail_price_minor, purchase_price_minor, currency, active, weight_g, dimensions_mm, packaging; неподтверждённые размеры NULL |
| Customers | id, first_name, last_name, acquired_storefront_id FK, notes, created_at; не регистрируем аккаунт покупателя |
| CustomerContacts | id, customer_id FK, kind email/phone, normalized_value, verified_at; UNIQUE(kind, normalized_value) WHERE email verified; телефон не уникальный идентификатор |
| CustomerAddresses | id, customer_id FK, country, region, city, postal_code, address, pickup_point; отдельные изменяемые адреса |
| CustomerConsents | id, customer_id FK, purpose, granted, document_version, recorded_at, source; маркетинг отдельно и необязателен |
| Carts | id, storefront_id FK, expires_at; клиент не источник цены |
| CartItems | cart_id FK, product_id FK, quantity > 0; UNIQUE(cart_id, product_id) |
| Orders | id, number UNIQUE, customer_id FK, storefront_id FK, idempotency_key UNIQUE, request_hash, processing_status, payment_status, delivery_status, items_total_minor, discount_minor, shipping_minor NULL, total_minor NULL, currency, recipient_snapshot, shipping_snapshot, created_at |
| OrderItems | id, order_id FK, product_id FK, sku/name snapshot, quantity, list_unit_price_minor, sale_unit_price_minor, purchase_unit_price_minor (внутренний снимок), discount_minor, line_total_minor, promotion snapshot, bundle_code |
| Promotions | id, name, starts_at, ends_at, active; CHECK ends_at > starts_at |
| PromotionProducts | promotion_id FK, product_id FK; составной PK |
| PromotionRules | id, promotion_id FK, min_quantity, discount_bps; UNIQUE(promotion_id, min_quantity); 0 <= discount_bps <= 10000 |
| Payments | id, order_id FK, amount_minor, kind payment/refund, state, confirmed_at, recorded_by FK AdminUsers; только учёт внешней оплаты |
| Shipments | id, order_id FK, carrier, tracking_number, delivery_status, recipient/address snapshot, shipped_at, delivered_at; снимок отправленной посылки неизменяем |
| NotificationEvents | id, order_id FK nullable, customer_id FK nullable, event_type, dedup_key UNIQUE, payload, state, attempts, next_attempt_at, lease_until, sent_at, last_error sanitized |
| NotificationAttempts | id, event_id FK, attempted_at, outcome, provider_message_id, sanitized_error; принятие SMTP не равно прочтению |
| OrderEvents | id, order_id FK, event_type, from/to status, actor_id, created_at; append-only |
| AdminUsers | id, email UNIQUE, password_hash, role, active; нет публичной регистрации |
| AdminSessions | id/hash UNIQUE, admin_id FK, expires_at, revoked_at; сырой токен не хранится |
| AuditLogs | id, admin_id FK nullable, action, entity_type/id, redacted_changes, created_at; append-only, ограниченный доступ |
| EmailChallenges | id, email normalized, code_hmac, expires_at, attempts, resend_at, consumed_at, session_binding; лимиты отправки/попыток |
| OrderAmendmentTokens | id, order_id FK, token_hash UNIQUE, allowed_fields, expires_at, used_at; одноразовое уточнение (этап 6) |
| RateLimitBuckets | scope, key_hash, window_start, count, expires_at; ограничение конкурентных запросов |

## Связи

Storefronts 1:N Orders/Carts/Customers (источник привлечения); Customers 1:N
Contacts/Addresses/Consents/Orders; Orders 1:N OrderItems/Payments/Shipments/
OrderEvents/NotificationEvents; Products M:N Promotions через PromotionProducts.

## Ограничения и инварианты

- Обработка: new, confirmed, assembling, assembled, cancelled.
- Оплата: unpaid, paid, refund_pending, refunded.
- Доставка: not_shipped, prepared, shipped, in_transit, pickup_ready, delivered, returned.
- Три статуса независимы, допустимые переходы проверяются сервером с аудитом.
- Заказ создаётся unpaid. Заявка не увеличивает выручку.
- Количество — положительное целое с верхней границей в API; цена >= 0,
  скидка не превышает исходную стоимость; итоги проверяются в транзакции.
- Неизвестная доставка — NULL, не 0; итог с доставкой остаётся NULL до тарифа.
- Исторические цены/скидки/получатель не вычисляются заново по каталогу/клиенту.
- Конкурентная проверка email и идентификация клиента транзакционны;
  совпадение неподтверждённого телефона не объединяет карточки.
- Смена email оставляет прежний подтверждённый контакт до проверки нового.
- Связь заказа с витриной и источником неизменяема после создания.
- Акции с пересечениями для одного товара в MVP не активируются; проверка
  выполняется под блокировкой, не только в UI.
- Outbox записывается с заказом/изменением статуса в одной транзакции.
- Коммерческие данные и ПДн не передаются в публичных DTO и не входят в Git.
- Не удалять клиента вместе с историей продаж; срок хранения и обезличивание
  определить отдельно после проверки применимых требований.

Миграции должны тестировать FK, уникальность, CHECK, снимки, идемпотентность и
конкуренцию. Здесь нет утверждения, что эти ограничения уже реализованы.
Бонусные балансы и реферальные таблицы в MVP не вводятся.
