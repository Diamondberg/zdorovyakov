# Этап 1 — аудит инфраструктуры

Дата: 24.10.2026 (Asia/Tomsk).
Статус: этап 1 завершён в доступном объёме; production-аудит ограничен отсутствием доступа.

## Фактические результаты

| Область | Наблюдение |
|---|---|
| GitHub | git ls-remote с разрешённым сетевым доступом: exit 0, refs отсутствуют; репозиторий пуст |
| Рабочая папка | Только .git, нет коммитов/remote/кода и AGENTS.md; исходная unborn ветка master |
| Git | 2.56.0.windows.3, автор коммитов настроен; данные автора отдельно в документацию не копируются |
| Ветки | Создан baseline eb2ee90abc56155e8bf4e5af2ac5fda42d3bdfb2 без файлов; main указывает на baseline; разработка feature/zdorovyakov-mvp |
| Локальная ОС | Windows 10.0.19045, не production-сервер |
| Технологии | node 24.18.1, npm 12.0.2; команды pnpm, Python launcher и ssh найдены; Python-runtime не проверялся |
| БД / веб-сервер локально | docker/psql/nginx/caddy не найдены в PATH; сервисы и слушатели не удалось достоверно обследовать |
| Домен | водный-прополис.рф → xn----ctbgrdnlgeajblt4l.xn--p1ai → A 217.29.53.65; NS не подтверждены |
| Публичный HTTP | HEAD: 200 OK, Server nginx, Content-Type text/html, Content-Length 195; содержимое не аудировалось |
| HTTPS | curl exit 60, SEC_E_UNTRUSTED_ROOT; доверие цепочке не установлено, причину на сервере ещё нужно проверить |
| Production | Доступ/ресурсы/другие проекты/конфиги/БД/SMTP/backup не предоставлены и не проверены |

При DNS-проверке сначала был использован ошибочный вручную записанный punycode;
он не относится к целевому домену. Итоговая запись выше получена через IdnMapping
из исходного имени, именно она использована для HTTP/HTTPS.

## Что подготовлено

- MASTER_SPEC.md (исходное ТЗ), ARCHITECTURE.md, DATABASE.md, DECISIONS.md.
- PROGRESS/HANDOFF, BACKLOG/ISSUES/CHANGELOG и каталоги приложений/миграций.
- Безопасный .env.example, .gitignore, npm scripts, lockfile и CI workflow.
- Решение: модульный Node/TypeScript/Fastify backend, PostgreSQL, React UI, outbox.
- Требование владельца: сначала нарисованный макет и согласование, затем вёрстка.

## Проверки

- npm ci --ignore-scripts --no-audit --no-fund: PASS, runtime-зависимостей нет.
- npm test: PASS, 23 обязательных файла, безопасные env defaults и ignore rules.
- npm run audit:local: PASS, read-only инвентаризация команд.
- node --check scripts/audit-local.mjs и scripts/check-project.mjs: PASS.
- git diff --check: PASS. При staged-проверке обнаружены исходные Markdown
  hard breaks в ТЗ; для этого файла задан whitespace attribute, оригинал сохранён.
  Staged diff дополнительно проверяется перед commit.
- git check-ignore: .env, .env.local и backups/test.dump исключены.
- SHA256 исходного ТЗ и MASTER_SPEC.md совпадает:
  99B7A5870EB092795182DAAA6D8DC8418806E8FDC85621D57F4FD0709DE01D7A.

Это проверки каркаса; API/БД/E2E отсутствуют. Состав индекса проверяется перед commit.
Workflow добавлен, удалённое выполнение не подтверждено.

## Git и продолжение

Коммит результатов: c0ab0b28057bfe156a6f87b8f7e11c45910542c3.
Push: успешен (exit 0), удалённые main и feature сверены через ls-remote.
main содержит только пустой baseline; слияния не было.
Состав индекса проверен: секретных файлов и ПДн покупателей нет.
Подробная квитанция: CHECKPOINT.md; она сохраняется отдельным документационным
коммитом после коммита результатов. Актуальный HEAD смотреть в Git.
Следующая задача: этап 2, PostgreSQL + миграции и их интеграционные тесты.
Известные ограничения: ISSUES.md. Нужен безопасный доступ к production для полного
серверного аудита, проверка TLS, реальные данные поставщика/SMTP/доставки/акции.
Это не блокирует локальную разработку ядра. Публичный запуск требует разрешения.
