-- Commercial facts supplied by owner; no unverified manufacturer claims or campaign dates.
INSERT INTO storefronts (slug, domain, name, allowed_origins)
VALUES ('vodny-propolis', 'xn----ctbgrdnlgeajblt4l.xn--p1ai', 'Водный прополис',
  ARRAY['https://xn----ctbgrdnlgeajblt4l.xn--p1ai']);
INSERT INTO products (sku, name, retail_price_minor, purchase_price_minor, volume_ml)
VALUES ('ZHIVA-PROPOLIS-30-100', 'Вода прополисная «ЖИВА» 30%, 100 мл', 47000, 27500, 100);
INSERT INTO storefront_products (storefront_id, product_id)
SELECT s.id, p.id FROM storefronts s CROSS JOIN products p
WHERE s.slug = 'vodny-propolis' AND p.sku = 'ZHIVA-PROPOLIS-30-100';
-- Promotions deliberately absent: real dates have not been approved.
