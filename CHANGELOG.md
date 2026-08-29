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

## M4 — Admin API + Security (2026-08-29)

### Что сделано
- **XSS-фикс 12aa9d5 (владелец) извлечён**: `jsonForScript` → `@tas/shared` (экранирование `<`,
  U+2028/2029) + юнит-тесты; bridge использует общий хелпер.
- **Харднинг**: (1) `POST /api/v1/events` публично принимает только `telegram_click`
  (link_click/bridge_view → 403, AN-19); (2) dev-rewrite `/api/v1/*` → API_ORIGIN в next.config;
  (3) `IP_HASH_SALT` отдельным env (ротация ENCRYPTION_KEY не меняет хэши IP).
- **Auth (§22)**: HS256 JWT (15 мин, свой impl — AN-18/TD-007), login: argon2id + TOTP
  (AES-GCM расшифровка), lockout 5×15мин/email, rate limit 20×15мин/IP, единый 401 без
  enumerate, audit admin_login/admin_login_failed.
- **RBAC owner/editor/viewer**: preHandler на роутере + assertRole в сервисном слое (в глубину).
- **Эндпоинты**: login, me, tracking-links POST (издатель ссылок: short_code + pin-URL + tg-deep-link;
  Idempotency-Key → replay с заголовком) / GET (со счётчиками link_click/starts), pins GET/POST/PATCH
  (переходы idea→approved→scheduled→published, paused↔published), users GET/GET/:id (карточка:
  атрибуция/сегменты/события), openapi.json. Скоуп M4 — AN-20 (analytics/flows/broadcasts — M6+).
- **Audit** на каждое действие; **zod** на всех входах; единый error envelope.
- **OpenAPI 3.1** `apps/api/openapi.json` + GET /api/v1/openapi.json + drift-тест (paths ⊆ app).

### Как проверено
- 116/116 тестов (jwt tamper/exp/alg-none, lockout, idempotency replay, login-флоу с реальными
  argon2/AES-GCM на fake-БД, RBAC 401/403, переходы статусов, 403 events, openapi drift).
- Живой прогон против реального PG: login 401/200 → /me → tracking-links 201 → replay (same
  short_code, Idempotency-Replayed:true) → GET → pins 201/422/200 → users list/card → openapi
  (9 путей) → audit-след (5 действий) → RBAC viewer 403.

### Дальше
M5 — бот: webhook + secret_token, идемпотентность update_id, upsert users, онбординг-FSM §11.4, лид-магнит, меню, /stop, обработка блокировки.

## M5 — Telegram Bot (2026-08-29)

### Что сделано
- **Webhook** (`apps/bot` :4100, grammY §20): `X-Telegram-Bot-Api-Secret-Token`
  constant-time (SHA-256 + timingSafeEqual); ACK 200 сразу после записи update,
  обработка в фоне (`UpdatePipeline`, конкурентность 5); идемпотентность по
  `update_id` (telegram_updates, повторная доставка → duplicate без обработки);
  ошибки БД → 500 для ретрая Telegram (§28.12/14); processed_at после обработки.
- **/start**: payload резолвится ДО любой реакции (§11.1); битый → unknown +
  alert, без payload → direct (Э4, без Левенштейна); first_touch ровно один раз,
  last_touch переключение is_current (Э1, AN-24 — два стейтмента из-за частичного
  уникального индекса); повторный /start — «с возвращением», is_returning;
  upsert users + обновление username из update (§28.4); resubscribe после /stop.
- **FSM-онбординг §11.4** (`user_profiles.fsm_state`): лид-магнит ДО опроса —
  sendDocument(S3 URL) + caption-шаблон; 1 вопрос 4 кнопки `q1:S1..S4` (≤64 байт);
  quick-win сегмента + вопрос частоты `q2:normal|low`; завершение →
  onboarding_completed_at, lifecycle new→onboarded, меню. §28.16: подсказка
  «выберите кнопку» ×2, затем игнор.
- **Команды §11.2**: /menu (§11.3 inline), /help, /support, /settings
  (setfreq → settings_changed), /stop — сегмент unsubscribed, гашение flow_runs
  и flow/broadcast-outbox, событие unsubscribe.
- **Блокировка §28.5**: 403 при отправке → is_blocked, lifecycle blocked,
  user_state_changed, отмена flow_runs и ВСЕГО outbox, bot_blocked; возврат
  пользователя → unblock + reactivated.
- **Outbox-отправитель** (M5: прямой, лимиты BullMQ — M6): claim due-строк
  FOR UPDATE SKIP LOCKED, ≤1 сообщение/сек на чат, 429 → retry_after-пауза,
  5xx/сеть → 3 попытки с отсрочкой, lead_magnet_delivered на фактическую отправку.
- **Все ответы из шаблонов** (§39.7): seed += 18 bot_*-шаблонов + сегмент
  unsubscribed; рендер {{var}}; кнопки с валидацией callback_data ≤64.
- **Privacy §16.3**: содержимое переписки не логируется (тест-шпион логгера;
  message_received хранит только length_bucket); сырые update — только в
  telegram_updates (TTL 7 дней, cron — M6).
- **CLI**: `pnpm --filter @tas/bot set-webhook` (runbook §39.13).

### Как проверено
- 156/156 тестов (+40 к M4): webhook (секрет/дедуп/ACK-до-обработки/полная
  HTTP-цепочка через мок Bot API), /start-сценарии (Э1/Э4/§28.x), FSM, команды,
  отправитель (пейсинг/403/429/ретраи/dedup), privacy.
- Живой прогон против реального PG + HTTP-мок Telegram: 401/200/duplicate,
  sendDocument+sendMessage по HTTP, атрибуция first/last с переключением
  is_current под реальным индексом, полный онбординг, welcome-back, /stop-каскад,
  privacy. Поймал и закрыл AN-24 (CTE vs частичный индекс).

### Дальше
M6 — автоматизация: BullMQ (outbox-sender с лимитами 25/s + cap/день, delayed
jobs), интерпретатор automation_flows §13.1 (welcome/abandonment/win-back), TTL
telegram_updates, cron-пересчёт lifecycle/сегментов.

## M6 — Automation: BullMQ-воркер, интерпретатор флоу §13.1, lifecycle/cron (2026-08-29)

### Что сделано
- **`apps/worker` (новый, §20 Redis-стек — bullmq/ioredis из контракта M6):**
  - Очередь `tas-outbox`: сканер (500ms) выбирает pending-строки по
    scheduled_at → джобы `ob-{outbox_id}` (limiter **25/s глобально**,
    concurrency 5, attempts 3 / backoff 5s). Отправка — fetch-транспорт,
    senderCore без изменений семантики (AN-25).
  - **Пейсинг 1 msg/s на чат** без BullMQ groups (AN-26): джоба кладётся в
    очередь с delay = max(now, last_sent_at(chat)+1s).
  - Очередь `tas-flows`: джобы `fr-{run}-{step}` (attempts 3 / backoff 10s);
    delayed-шаги (delay-экшен, межшаговые паузы) живут в Redis.
  - **Rehydrate при старте** (контракт M6): 'sending'-строки outbox → pending,
    активные flow_runs → перепланирование текущего шага по context.next_fire_at
    (идемпотентно по jobId).
  - **Интерпретатор §13.1** (`flowEngine.ts`): trigger (event/segment_entered/
    state_changed/schedule/manual), conditions (профиль/сегменты/счётчики
    событий за период), actions (send_message, add/remove_segment,
    set_profile_field, delay, branch goto(CODE), notify_admin, cancel_flow),
    guard `cancel_if` (user_blocked/unsubscribed/purchased_product) —
    проверяется на КАЖДОМ шаге; дедуп шага `{flow_run}:{step}`; версии флоу —
    code+version, ровно одна active. Repeat-guard флоу (AN-27).
  - **Лимиты (контракт):** `DAILY_MSG_CAP_PER_USER` (UTC-сутки, только
    kind=flow/broadcast; превышение → pending + scheduled_at=следующая
    UTC-полночь); **429 retry_after** → retryOutboxAt(+retry_after+1s) +
    worker.rateLimit; **403** → blocked-каскад (markUserBlocked +
    cancelActiveFlowRuns + skipAllOutboxForUser).
  - **EventPoller** (1s): events → триггеры флоу + мгновенные lifecycle-
    переходы (activated по button_clicked / 2×content_viewed и т.д.); watermark
    — история при старте не проигрывается.
  - **Cron (часовой):** TTL telegram_updates 7d; lifecycle-пересчёт
    (new→churned 7d, →at_risk 14d, at_risk→churned 30d, →engaged); dynamic
    segments (intent_high, cold) из rule_json, membership origin='rule'.
  - Метрики очереди (depth/processed/failed) — в лог + /health (WORKER_PORT).
- **Миграция sender bot → worker (AN-25):** из бота удалены outboxSender.ts и
  emit.ts (бот — webhook-only); TD-011 (два Bot API-клиента) задокументирован;
  TD-007 закрыт (verifyJwt zod-role — решение при приёмке M5).
- **Seed:** 3 флоу на реальных триггерах — welcome_series
  (onboarding_completed, guard purchased_product, branch), abandonment
  (checkout_opened без покупки 48h), winback (at_risk, repeat_days 30);
  динамические сегменты intent_high/cold.

### Как проверено
- 192/192 тестов (+36 к M5, 28 файлов): интерпретатор (триггеры/условия/guard
  на каждом шаге/branch goto/дедуп/версии/repeat-guard), отправитель, rehydrate,
  cron (TTL/lifecycle/сегменты), poller (watermark/мгновенные переходы);
  3 теста на РЕАЛЬНОМ Redis+BullMQ (delayed-джоба переживает close воркера и
  исполняется вторым ровно 1 раз; идемпотентность scheduleStep/rehydrate).
- Живой прогон против реального PG + Redis + HTTP-мока Bot API: poll → flow_run
  → шаги → outbox → HTTP-отправка; daily cap (pending до полуночи); 429 →
  ретрай; close воркеров → rehydrate → delayed-шаг доходит до outbox; TTL.
  Пойманы и исправлены 2 рантайм-дефекта: BullMQ запрещает ':' в имени очереди
  и в custom jobId (`tas:*` → `tas-*`, `ob:*`/`fr:*:*` → `ob-*`/`fr-*-*`).
- lint ✅, typecheck 6/6 ✅.

### Дальше
M7 — Stars-платежи (диджитал-товары, XTR; условие приёмки M5: non-guessable
per-product capability-ключи, URL лид-магнита не переиспользовать).
