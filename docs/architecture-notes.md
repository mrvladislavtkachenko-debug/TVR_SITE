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
