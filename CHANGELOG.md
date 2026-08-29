# CHANGELOG

Формат: milestone-записи по мере завершения milestone'ов (PRD §40, M1–M10).

## M1 — Scaffold (2026-08-29)

### Что сделано
- Монорепо pnpm workspaces по Э5: `apps/api` (Fastify :4000), `apps/bot` (Fastify :4100),
  `apps/web` (Next.js 15, заглушка), `apps/worker` (заглушка до M6), `packages/shared`
  (zod env-схемы: базовая + пер-апп, таксономия событий §16.2, error envelope §19,
  утилиты tracking-токена).
- `infra/compose.base.yml`: postgres:16 + redis:7 (AOF), healthchecks, named volumes;
  порты опубликованы только на 127.0.0.1 (dev). Prod-оверлей — M10 (BOT_PORT наружу не публикуется).
- `/health` в api и bot: `{status, db, queue}`; 503 при деградации; db — tcp-check
  (см. TECH_DEBT TD-001), queue — redis PING.
- CI (GitHub Actions): pnpm@10 + Node 22 → lint → typecheck → test → `docker compose config -q`.
- `.env.example` по §39.14 + дельта Э6 (ENCRYPTION_KEY; без ADMIN_*) и Э9 (STAR_USD_RATE).
- `docs/architecture-notes.md`: зафиксированы отклонения Э1–Э9 и bot-сервис :4100 (AN-10).

### Как проверить
`pnpm install && pnpm lint && pnpm typecheck && pnpm test`;
`docker compose -f infra/compose.base.yml up -d`;
`cp .env.example .env` (заполнить) → `pnpm --filter @tas/api dev` → `curl localhost:4000/health`;
`pnpm --filter @tas/bot dev` → `curl localhost:4100/health`.

### Дальше
M2 — Prisma schema по §15 с эрратой, миграции, seed.

## M2 — Database (2026-08-29)

### Что сделано
- `packages/db` (@tas/db): prisma-схема (24 таблицы = §15 MVP минус link_visits по Э3),
  миграции коммитятся, клиент генерируется в postinstall; депы prisma — только в этом пакете.
- Эррата в схеме: Э1 — attributions БЕЗ UNIQUE(user_id,touch), +is_current, инварианты
  «один first_touch»/«одна текущая last_touch» — частичные unique-индексы raw-SQL;
  Э2 — messages_outbox.broadcast_id (FK, NULL); Э3 — link_visits отсутствует.
- Составные PK: pin_metrics_daily(pin_id,date), user_segments(user_id,segment_id).
  timestamptz(3) на всех temporal-колонках (проверено: 35 колонок, 0 без tz). email —
  @db.Text + lower-case нормализация (AN-12, без citext).
- Миграция `0_init` написана вручную в DDL-стиле Prisma (среда разработки без доступа к
  binaries.prisma.sh — TD-005), применена к БД и верифицирована: 24 таблицы, 20 enum'ов,
  22 FK, 60 индексов; Э1/Э8 проверены живыми INSERT (23505), GIN-запрос работает.
- Идемпотентный seed: sources (3), сегменты S1–S4, 3 флоу §13.2 (welcome_series_v1,
  checkout_abandonment_v1, winback_v1, active), 8 en-шаблонов, продукт planner_pack.
- seed-CLI админа (Э6/AN-11): argon2id OWASP (m=19456,t=2,p=1, константа) + TOTP-секрет
  AES-256-GCM (ENCRYPTION_KEY), otpauth-URI печатается один раз, self-check расшифровки.
- TD-001 закрыт: /health в api и bot делает SELECT 1 через Prisma ($disconnect в shutdown).
- Новые env-схемы: dbEnvSchema / adminSeedEnvSchema (seed не требует Telegram/S3/LLM).

### Как проверить (машина с полным сетевым доступом)
```
pnpm install && pnpm db:migrate:deploy && pnpm db:seed
pnpm db:seed:admin -- --email owner@example.com --password 'S3cure!pass'
# drift-чек схемы (должен быть пустым):
pnpm --filter @tas/db exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-url "$DATABASE_URL" --script
```

### Дальше
M3 — атрибуция: tracking_links (t1+nanoid(10)), резолв с кэшем 60s, bridge /m/:slug, события link_click/bridge_view.

## M3 — Attribution + Bridge (2026-08-29)

### Что сделано
- **Токен** (shared/ids): генерация `t1+nanoid(10)` (base64url, формат из env — инвариант),
  publicTrackingUrl/telegramDeepLink; генератор с исключением занятых + retry.
- **Сервисы @tas/db** (инъектируемый SqlExecutor: Prisma в проде, pg в верификации):
  `issueTrackingLink` (INSERT ON CONFLICT + retry), `resolveTrackingLink` (формат-чек →
  кэш Redis 60s позитивный+негативный → SELECT is_active), `recordEvents`
  (батч-INSERT `ON CONFLICT (dedup_key) DO NOTHING` — Э8), `ipHash` (salted SHA-256).
- **Per-event zod-схемы** (shared/bridgeEvents): link_click/bridge_view/telegram_click
  со свойствами по Э3/Э7; classifyUaClass (pinterest_app/bot/mobile/desktop/other);
  buildDedupKey (минутный бакет, ≤128).
- **API**: `POST /api/v1/events` — 60 req/мин/IP (Redis fixed-window), серверное обогащение
  (ip_hash, ua_class, referer_host), best-effort 202 (Э7); 400/429 в error envelope.
- **Bridge** (apps/web): `/m/[slug]?t=` — динамический лёгкий рендер (AN-15), серверный лог
  link_click+bridge_view одним батчем, CTA `t.me/BOT?start={token}`, beacon telegram_click,
  middleware `bsid`-cookie (30д, httpOnly), `/privacy` (draft), graceful-деградация при
  недоступности БД/Redis (CTA без start → атрибуция unknown в M5).
- **Инфраструктура пакетов** (AN-17): subpath-экспорты `@tas/db/client` и `@tas/db/services`;
  createPrisma через createRequire; `@prisma/client` — прямая зависимость web.

### Как проверено
- 77/77 тестов (gen/резолв/кэш/дедуп/маршрут/лимиты/обогащение/best-effort).
- Живой прогон (реальные PG+Redis, pg-исполнитель): issue → PIN URL → resolve miss/hit
  (redis TTL 60s) → негативный кэш → батч 2 событий → дубль по dedup_key вставлен 0 строк.
- Bridge вживую (dev): 200 + CTA `t.me/TASDevBot?start={token}` + beacon + privacy + bsid;
  битый токен → CTA без start; без токена → 200; /privacy → 200; прод-сборка web зелёная.
- Beacon на api вживую: 202 (валидный/битый referer/битый токен), 400 на мусор.

### Известные ограничения среды
- В песочнице нет prisma-движков (TD-005): живые записи в БД из приложений идут через
  заглушку → health показывает db:down, события best-effort 202; SQL-слой верифицирован
  pg-исполнителем; полный прогон — CI/машина владельца.

### Дальше
M4 — API: контракты §19 (admin-эндпоинты), zod-валидация, Idempotency-Key, RBAC + audit.
