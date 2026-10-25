# Контрольные точки

## Этап 2 — 25.10.2026

- Рабочая ветка: feature/zdorovyakov-mvp.
- Коммит ядра: 38634d80cd777e5baf47dff92f9ea57a3e2dbd9d.
- `git push origin feature/zdorovyakov-mvp`: exit 0.
- Удалённый SHA рабочей ветки совпал с локальным (git ls-remote).
- main неизменна: eb2ee90abc56155e8bf4e5af2ac5fda42d3bdfb2, слияния не было.
- npm test: PASS, 11 unit + 10 integration на PostgreSQL 18.4, без skips.
- TypeScript strict, build, git diff --check и staged diff --check: PASS.
- Секреты и данные реальных покупателей не публиковались.
- Remote CI ядра запущен: https://github.com/Diamondberg/zdorovyakov/actions/runs/40169452185;
  при первичной проверке in_progress. Локальный PASS не заменяет Actions.
- Следующая задача: этап 3, серверная авторизация администратора и API управления;
  перед вёрсткой — нарисованный макет и согласование владельца.

Документационная квитанция сохраняется следующим коммитом; текущий последний
SHA определять `git rev-parse HEAD` и сверять с удалённой рабочей веткой.

## Этап 1

Дата: 24.10.2026, Asia/Tomsk.

- Рабочая ветка: feature/zdorovyakov-mvp.
- Коммит результатов этапа: c0ab0b28057bfe156a6f87b8f7e11c45910542c3.
- Пустой baseline main: eb2ee90abc56155e8bf4e5af2ac5fda42d3bdfb2.
- `git push --atomic -u origin main feature/zdorovyakov-mvp`: exit 0, обе ветки созданы.
- `git ls-remote origin refs/heads/main refs/heads/feature/zdorovyakov-mvp`:
  оба SHA совпали с локальными; доступ на запись подтверждён.
- После публикации результатов рабочая папка была чистой.
- npm ci, npm test, audit:local, node --check и staged diff --check: PASS.
- Индекс проверен: .env/ключей/дампов/данных покупателей нет; только пустой .env.example.
- Remote CI не проверен; не считать workflow прошедшим по локальному результату.

Этот файл — квитанция об уже выполненной публикации; он сохраняется следующим
документационным коммитом. Его собственный SHA не может содержаться в его содержимом.
Текущий последний коммит после получения ветки определить через `git rev-parse HEAD`;
сверить с `git ls-remote origin refs/heads/feature/zdorovyakov-mvp`.

Следующая задача: этап 2 — PostgreSQL, исполняемые миграции, реальные интеграционные
тесты БД и затем центральное API. Не начинать все этапы одновременно.
Перед вёрсткой сначала нарисовать и согласовать визуальный макет с владельцем.
Production-аудит остаётся ограниченным отсутствием доступа; TLS требует проверки.
