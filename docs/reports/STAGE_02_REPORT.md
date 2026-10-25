# Этап 2 — центральное ядро

Дата: 25.10.2026, Asia/Tomsk. Ветка: feature/zdorovyakov-mvp.
Статус: реализация и локальные проверки завершены; публикация контрольной точки.

## Реализовано

- TypeScript/Fastify API: live/ready, витрина, публичный каталог, серверный quote.
- PostgreSQL 18: схема всех основных сущностей, две SQL-миграции, runner с SHA256,
  общей транзакцией и advisory lock. Начальные товар и витрина из ТЗ.
- Несколько товаров, количества 1–999, копейки/BigInt rounding, акции с реальными
  датами и проверкой конфликтов. В seed акция отсутствует, доставка неизвестна.
- Внутреннее создание заказа: подтверждённый email как trusted input, +7 телефон,
  клиент, источник, снимки цен/адреса, независимые статусы, order event и outbox.
- Конкурентная идемпотентность; исторические строки и event logs защищены триггерами.
- Публичные DTO без закупочной цены; schema validation, CORS allowlist, rate limit,
  лимит тела, безопасные ошибки и отсутствие автоматического request logging.
- Native dev PostgreSQL без службы/изменения прав; случайные credentials в tmp/,
  короткие пути Windows для устранения ошибки кириллицы initdb.
- CI с PostgreSQL service, документация API/запуска и обновлённые HANDOFF/PROGRESS.

Основные файлы: apps/api/src/, db/migrate.ts, db/migrations/001_core.sql,
002_initial_catalog.sql, packages/contracts/src/public.ts, tests/*.test.ts,
scripts/postgres-cluster.ts, scripts/local-db.ts и docs/project/API.md.

## Проверки

- TypeScript strict: PASS; build: PASS.
- 11 unit-проверок: 1/3/5/6/8/9/10, границы дат/активность, округление,
  ошибочные значения и нормализация телефона: PASS.
- 10 интеграционных сценариев на настоящем PostgreSQL 18.4: PASS.
  Миграции repeat/concurrency/checksum/rollback, DTO/CORS/SQL injection input,
  недоступные товары, валидация цены/количества, сроки/конфликт акций,
  многотоварная корзина, 5 конкурентных повторов заказа, идентификация email,
  отсутствие объединения по телефону, snapshots, outbox rollback, CHECK/триггеры,
  readiness, rate limit и настоящий HTTP listener на loopback.
- Финальный npm test: PASS, 11 unit + 10 integration, без skips.
- npm run build: PASS; git diff --check: PASS; секретные пути исключены.
- Проверка изменений: нет реальных credentials/ПДн; CI-пароль относится только
  к одноразовой локальной БД job, runtime-пароль генерируется и не публикуется.
- Результаты публикации и remote CI — CHECKPOINT.md.
- Первоначальный initdb упал на UTF8 кириллического пути; исправлено короткими
  путями без изменения системной локали. npm lifecycle scripts одобрены штатно.

## Ограничения

Нет админки/авторизации (этап 3), витрины (4), публичного оформления и email-кода (5),
почтового worker/отправки (6), готовой аналитики/экспорта (7) и production (8).
Внутренний verifiedEmail нельзя принимать из HTTP body; публичного POST orders нет.
Global limiter пока на процесс; production DB-роли и backup/restore не настроены.
Серверный доступ, HTTPS и прочие ограничения этапа 1 сохраняются в ISSUES.md.
Скидки тестируются на fixtures, реальные даты акции не выдуманы.

## Git и продолжение

SHA и результат push фиксируются в CHECKPOINT.md после публикации.
Следующая задача: этап 3 — серверные сессии администратора, права и API управления.
Перед любой вёрсткой нарисовать макет и согласовать с владельцем.
Слияние в main и публичный deployment не выполнялись.
