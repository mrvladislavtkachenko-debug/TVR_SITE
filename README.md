# TVR_SITE

Pinterest → Telegram Traffic Acquisition System (TAS).

## Документация

- [`docs/PRD_Pinterest_Telegram_System.md`](docs/PRD_Pinterest_Telegram_System.md) — полный PRD + System Design + Technical Specification (v1.0). Основа для будущего `MASTER PROMPT FOR AI CODING AGENT` (структура — раздел 40 документа).

## Суть системы

```
Pinterest (organic) → Bridge Landing (свой домен, атрибуция)
  → Telegram Bot (onboarding → сегментация → value)
    → Activation → Conversion (Telegram Stars) → Retention/Revenue
```

Ключевые решения зафиксированы в §38 документа (стек: TypeScript monorepo, Fastify, grammY, Next.js, PostgreSQL, Redis/BullMQ, Docker Compose на VPS).
