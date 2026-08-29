# Architecture Notes — отклонения от PRD v1.0

Здесь фиксируются все отклонения от `docs/PRD_Pinterest_Telegram_System.md` с обоснованием.
Источники отклонений: эррата владельца (Э1–Э9, приоритет над PRD) и решения по milestone'ам.

## AN-1..AN-9 — Эррата владельца (2026-08-29)

Приоритетнее текста PRD. Реализуются в своих milestone'ах, здесь — реестр:

| # | Отклонение от PRD | Суть | Milestone реализации |
|---|---|---|---|
| Э1 | §15.2 `attributions UNIQUE(user_id, touch)` | Убрать unique-пару: ровно один `first_touch` на user; актуальный `last_touch` помечается `is_current`; вся история касаний — в `events` | M2 |
| Э2 | §15.4 `messages_outbox` | Добавить поле `broadcast_id` (bigint, FK, NULL) | M2 |
| Э3 | §15.2 таблица `link_visits` | В MVP отсутствует; все переходы — события в `events` (properties: `referer_host`, `ip_hash`, `ua_class`, `session_id`) | M2/M3 |
| Э4 | §28.3 матчинг по Левенштейну | Не реализуется: битый `/start`-payload → атрибуция `unknown` + алерт; без fuzzy-матчинга | M5 |
| Э5 | §20/§38 структура репо | Монорепо pnpm workspaces: `apps/api`, `apps/bot`, `apps/web`, `apps/worker`, `packages/shared` (zod-схемы, типы, таксономия событий) | M1 ✅ |
| Э6 | §39.14 env: `ADMIN_EMAIL/ADMIN_PASSWORD_HASH/ADMIN_TOTP_SECRET_ENCRYPTED` | Исключены из env; добавлен `ENCRYPTION_KEY` (AES-256-GCM для TOTP-секретов); админ-пользователь создаётся seed-CLI | M1 (env) / M2 (seed) |
| Э7 | §7.2/§17 воронка моста | Воронка моста считается `link_click → telegram_start`; `telegram_click` — вспомогательный beacon-сигнал (может теряться, ретро-достраивания нет) | M3/M8 |
| Э8 | §16 events insert | Батч-инсерты с `ON CONFLICT (dedup_key) DO NOTHING` | M3+ |
| Э9 | §15.5 `orders.usd_equiv` | `usd_equiv = stars_amount × STAR_USD_RATE` (env, дефолт 0.013) | M2/M7 |

## AN-10 — apps/bot как отдельный сервис :4100 (2026-08-29, утверждено владельцем)

**Отклонение от:** PRD §21.1 (топология: `/webhook/telegram` проксируется на app:4000, bot — часть приложения api).

**Решение:** по Э5 `apps/bot` — отдельный Fastify-сервис на `BOT_PORT=4100`.

**Условия (зафиксированы владельцем):**
- наружу в prod торчит только 443;
- Caddy маршрутизирует `/webhook/telegram` → `bot:4100` внутри docker-сети, остальное → `api:4000` / `web:3000`;
- `BOT_PORT` не публиковать в `infra/compose.prod.yml` (M10);
- env `BOT_PORT` валидируется только zod-схемой `apps/bot`.

**Почему:** строгое следование Э5 (разделение процессов api/bot), независимый деплой и рестарт бота; прод-инвариант «один наружный порт» сохраняется.

## AN-11 — админ-пользователь через seed-CLI (2026-08-29)

**Отклонение от:** §39.14 (env `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `ADMIN_TOTP_SECRET_ENCRYPTED`).

**Решение:** по Э6 переменные исключены из `.env.example`; учётка владельца создаётся CLI-командой seed в M2 (`pnpm --filter @tas/api seed:admin`), TOTP-секрет шифруется `ENCRYPTION_KEY`. Пароль/секрет не живут в env вовсе.

## AN-12 — email без citext (2026-08-29, M2)

**Отклонение от:** PRD §15 (упоминание citext для email).

**Решение:** `@db.Text` + нормализация в lower-case на прикладном уровне (zod-трансформ в API, `.toLowerCase()` в seed-CLI). Уникальность — обычный unique-индекс по нормализованному значению.

**Почему:** citext — PG-расширение (не везде доступно в managed-Postgres), не поддерживается Prisma-схемой декларативно; нормализация в одном месте даёт тот же инвариант без расширений.

## AN-13 — структурные решения @tas/db (2026-08-29, M2, утверждено владельцем)

- Prisma-схема/клиент/seed живут в `packages/db` (`@tas/db`); депы prisma/@prisma/client — только в этом пакете; apps зависят от `@tas/db`.
- Клиент не коммитится (генерация в postinstall), миграции коммитятся.
- `dbEnvSchema` (NODE_ENV, DATABASE_URL) и `adminSeedEnvSchema` (+ENCRYPTION_KEY) в `@tas/shared`: seed/CLI не требуют Telegram/S3/LLM ключей.
- Крипто-утилиты (AES-256-GCM) и обёртка argon2id (OWASP m=19456,t=2,p=1) — в `@tas/db/src`: используются seed-CLI админа и (в M4) API авторизации.
- Генератор стандартный `prisma-client-js`, без preview-фич (queryCompiler не используется — прод-стабильность важнее удобства песочницы).

## AN-14 — миграция 0_init написана вручную + raw-SQL секция (2026-08-29, M2)

**Контекст:** в среде разработки недоступен binaries.prisma.sh → `prisma migrate diff/dev` не выполняются; артефакты при этом обязаны быть стандартными.

**Решение:** `prisma/migrations/20260829164000_init/migration.sql` написан вручную в точном DDL-стиле Prisma (перечисление: 20 enum'ов, 24 таблицы, 34 индекса Prisma-именования, 22 FK) + raw-SQL секция по контракту M2:
- `attributions_one_first_touch` — UNIQUE (user_id) WHERE touch='first' (Э1);
- `attributions_one_current_last_touch` — UNIQUE (user_id) WHERE touch='last' AND is_current (следствие Э1: «актуальная» last_touch ровно одна; история касаний — строками is_current=false);
- `events_properties_gin` — GIN (properties).

**Верификация:** применена к живой БД через pg-драйвер; инварианты Э1/Э8 проверены живыми INSERT (duplicate → 23505), GIN-Containment-запрос работает. Эквивалентность схеме на машине с полным доступом: `pnpm --filter @tas/db exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-url "$DATABASE_URL" --script` → пустой вывод.

## AN-15 — bridge: динамический лёгкий рендер вместо чистой статики/ISR (2026-08-29, M3)

**Отклонение от:** контракт M3 «bridge на Next.js (ISR/статика)» в части статики.

**Почему:** PRD §9.4 требует серверный лог `link_click`/`bridge_view` на каждом заходе (Э7: link_click — база воронки моста). Полностью статичная страница не видит сервером заходы — события остались бы только клиентскими beacon'ами (Pinterest in-app webview, блокировки JS → потеря начала воронки). Решение: динамический server component с кэшем резолва 60s (Redis) и батч-записью 2 событий одним INSERT; HTML без клиентского фреймворка и внешних ассетов — LCP-бюджет 1.5s держится (страница < 10KB в прод-сборке). Деградация: при недоступности БД/Redis страница рендерится с generic-CTA — атрибуция достроится по telegram_start (authoritative, M5).

## AN-16 — web пишет события напрямую через @tas/db, beacon — на /api (2026-08-29, M3)

Серверные события моста (link_click, bridge_view) web пишет сам через SQL-executor (@tas/db/services) — без self-HTTP к api (меньше задержка и точек отказа на hot path). Клиентский telegram_click идёт beacon'ом на `POST /api/v1/events` того же origin (в prod Caddy роутит /api/* на api:4000; в dev — прямой порт).

## AN-17 — подключение Prisma в web: createRequire + subpath exports (2026-08-29, M3)

**Проблема:** Next webpack бандлит `@prisma/client` из transitive-импорта TS-пакета (serverExternalPackages не сработал) — в бандле генерация `.prisma/client` недоступна. Кроме того, полный barrel @tas/db тянет нативный argon2 в бандл web.

**Решение:**
1. `createPrisma` подключает клиент через runtime `createRequire` (типы — статически, type-only import).
2. `@tas/db` получил subpath-экспорты: `./client` (только PrismaClient) и `./services` (SQL-сервисы без argon2/otplib/prisma) — web импортирует только их.
3. `@prisma/client` объявлен прямой зависимостью apps/web — резолв runtime-require из node_modules (иначе pnpm-строгость его скрывает).

**Проверено:** прод-сборка web проходит, bridge вживую рендерится с CTA-deep-link (см. CHANGELOG M3).

## AN-18 — HS256 JWT собственными средствами (без jsonwebtoken), 2026-08-29, M4

**Контекст:** правило «новые пакеты — только с одобрения»; для HS256+exp достаточно node:crypto.

**Решение:** ~60 строк: alg зафиксирован HS256 (подмена alg=none отклоняется), exp обязателен, подпись сравнивается timingSafeEqual. TD-007: при желании заменяется на jsonwebtoken без изменения вызовов (signJwt/verifyJwt).

## AN-19 — харднинг публичного events-эндпоинта и соли (2026-08-29, M4)

1. `POST /api/v1/events` публично принимает **только** `telegram_click`; `link_click`/`bridge_view` → 403 FORBIDDEN (пишутся исключительно сервером — защита воронки от pollution, xарднинг M4-1).
2. `IP_HASH_SALT` — отдельный env (не ENCRYPTION_KEY): ротация ключа шифрования TOTP не меняет хэши IP (харднинг M4-3).
3. Dev-прокси: `next.config.ts` rewrite `/api/v1/:path*` → `API_ORIGIN` (только dev; в prod — Caddy, харднинг M4-2).

## AN-20 — объём admin-API в M4 (2026-08-29)

В M4 реализованы: auth/login, me, tracking-links (POST/GET), pins (GET/POST/PATCH), users (GET/GET/:id), openapi.json. Эндпоинты analytics/flows/broadcasts/products/orders/ai появляются в своих milestone'ах (M6–M9) вместе с функциями — API-слой (envelope, RBAC, audit, idempotency, zod) готов к расширению.

## AN-21 — бот M5: webhook ACK-первым, фоновый конвейер, идемпотентность (2026-08-29)

`POST /webhook/telegram` (apps/bot :4100, Э5/AN-10 — несмотря на §37.8, где webhook
нарисован на app:4000): проверка `X-Telegram-Bot-Api-Secret-Token` constant-time
(SHA-256-дайджесты + timingSafeEqual), затем `INSERT telegram_updates ON CONFLICT
(update_id) DO NOTHING` и мгновенный ACK 200 (§28.9/28.12, NFR-1). Обработка —
`bot.handleUpdate` в `UpdatePipeline` (конкурентность 5, сглаживание бёрстов §22;
полные rate-limits — M6) с последующим `processed_at`. Дубликат доставки — `{ok:true,
duplicate:true}` без обработки. Ошибка БД → 500 (Telegram повторит, §28.14);
ошибка обработки не рушит ACK — update остаётся с `processed_at IS NULL` (кандидат
на replay, cron M6). Известное ограничение: конвейер обрабатывает update
параллельно, т.е. быстрые подряд идущие клики одного пользователя могут
обработаться вне порядка (FSM-роутер относится к вне-шаговым кнопкам толерантно —
stale-ветка без смены состояния).

## AN-22 — материализация /stop и разблокировки (2026-08-29)

Отписка хранится членством в статическом сегменте `unsubscribed` (user_segments,
origin=manual): M6-guard'ы (`cancel_if: ['unsubscribed']` §13.1) проверяют его
перед отправкой; отдельной колонки в схеме нет (PRD §12.1 не требует).
`/stop` гасит flow_runs (active→cancelled) и pending/sending outbox
kind flow|broadcast → skipped; транзакционный ответ подтверждения доставляется.
Повторный /start снимает членство (resubscribe). Разблокировка §28.5: любое
входящее от is_blocked-пользователя снимает флаг + lifecycle blocked→reactivated
(`user_state_changed`). 403 при отправке: каскад — is_blocked, lifecycle,
flow_runs, ВЕСЬ outbox (skipAllOutboxForUser), событие bot_blocked.

## AN-23 — лид-магнит: sendDocument по HTTPS-URL из S3 (2026-08-29, вопрос владельцу)

Файл лид-магнита лежит в S3-совместимом хранилище (§20) и доступен боту по
публичному HTTPS-URL (публичный бакет/кастомный домен R2/B2): Telegram сам
скачивает файл при `sendDocument(url)` — код прост, ноль новых зависимостей,
нулевая пропускная способность нашего VPS. env: `LEAD_MAGNET_URL` +
`LEAD_MAGNET_FILENAME`. Событие `lead_magnet_delivered{delivery_kind:'file'}`
эмитится отправителем на фактическую отправку.
**Требует решения владельца:** приватные бакеты потребуют скачивания ботом
(@aws-sdk/client-s3, пакет вне §20 — нужно явное одобрение) — см. TD-010.

## AN-24 — recordStartTouch: два стейтмента вместо одного CTE (2026-08-29)

Частичный уникальный индекс `attributions_one_current_last_touch` (M2, Э1)
проверяется немедленно, а PG не гарантирует порядок data-modifying CTE — очистка
is_current и вставка нового last в одном стейтменте дают violation (поймано
live-прогоном M5 против реального PG). Решение: стейтмент 1 — снятие is_current
с чужого текущего last; стейтмент 2 — CTE с вставками first/last
(`ON CONFLICT DO NOTHING`). Гонка разных токенов одного юзера: проигравший
гасится DO NOTHING (побеждает первый writer; история — в events).
