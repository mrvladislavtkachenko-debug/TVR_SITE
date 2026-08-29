# CHANGELOG

Формат:里程碑-записи по мере завершения milestone'ов (PRD §40, M1–M10).

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
