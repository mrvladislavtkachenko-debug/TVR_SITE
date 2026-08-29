# TVR_SITE — TAS

Pinterest → Telegram Traffic Acquisition System.
Архитектурная истина: [`docs/PRD_Pinterest_Telegram_System.md`](docs/PRD_Pinterest_Telegram_System.md) (v1.0)
+ эррата владельца и отклонения: [`docs/architecture-notes.md`](docs/architecture-notes.md).

## Структура (Э5)

```
apps/
  api/      Fastify :4000        — REST API, bridge-события (M3+), admin API (M4+)
  bot/      Fastify :4100        — Telegram webhook (M5); в prod наружу не публикуется (AN-10)
  web/      Next.js :3000        — bridge /m/:slug (M3), admin (M8)
  worker/   BullMQ (M6)          — flows, outbox sender
packages/
  shared/   zod env-схемы, таксономия событий, error envelope, утилиты токена
infra/
  compose.base.yml               — postgres:16 + redis:7 (dev)
```

## Быстрый старт

```bash
corepack enable && pnpm -v          # pnpm@10 (см. packageManager)
pnpm install
docker compose -f infra/compose.base.yml up -d   # postgres + redis
cp .env.example .env                # заполнить секреты (в .env.example — подсказки)

pnpm lint && pnpm typecheck && pnpm test

pnpm --filter @tas/api dev          # http://localhost:4000/health
pnpm --filter @tas/bot dev          # http://localhost:4100/health
pnpm --filter @tas/web dev          # http://localhost:3000
```

## Milestone'ы

Текущий статус и записи — [`CHANGELOG.md`](CHANGELOG.md); долги — [`TECH_DEBT.md`](TECH_DEBT.md).
