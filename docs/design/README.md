# Макеты и согласование

25.10.2026. Это нарисованные концепты, а не скриншоты работающей витрины.

- admin-concept-v1.png — просмотрен владельцем; даны правки и реализованы на этапе 3:
  сводка, выдвижная карточка, настоящая история статусов, owner-подтверждение оплаты,
  мобильные поиск/фильтры и взаимоисключающие table/empty состояния.
- storefront-concept-v1.png — ранний макет с условным флаконом, НЕ согласован.
- storefront-concept-v3.png — оригинальное фото и множители ×1/×3/×6/×9.
  Ответ владельца: «Нужны ещё правки». Вёрстку витрины не начинать по этой версии.
- storefront-concept-v4-rejected.png — тёмный вариант монопродукта. Отклонён:
  слишком кричащий, кнопки-капсулы не подходят. Это история, не дизайн для реализации.
- storefront-first-screen-v5.png — спокойный светлый первый экран, оригинальная
  упаковка, прямоугольные кнопки и единый контроль количества. Согласование ожидается.
  Prompt и источник — PROMPT_FIRST_SCREEN.md. Вёрстку не начинать без согласования.

Оригинал товара: assets/products/zhiva-propolis-100ml-original.png.
Генерация макета может искажать мелкие детали этикетки; при реализации использовать
исходный файл фотографии, а не вырезанный флакон из сгенерированного макета.

Built-in ImageGen, навык imagegen; CLI/API key не использовались.
Ключевой финальный prompt (сохранённое описание задания):

> Edit target UI design board with two required corrections. Use the final original
> product photograph: opaque white bottle, tall ribbed white cap, actual pale grey
> honeycomb label, gold/yellow patch with green circular stamp, small hexagon at left,
> blue and green bands, narrow black Cyrillic Вода ПРОПОЛИСНАЯ 100 мл. Preserve photo
> identity and label, do not redesign. In every desktop and mobile bundle card show
> exactly one bottle with a large multiplier ×1, ×3, ×6, ×9. Keep cream/forest green
> direction, base prices 470/1410/2820/4230 ₽ and titles На пробу / Мне на месяц /
> Нас двое / Мы семья. No active discounts, countdown, medicinal claims, reviews or
> certificates. This is a concept for owner review before website implementation.
