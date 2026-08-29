.PHONY: up down dev lint typecheck test compose-validate

up: ## postgres + redis (dev)
	docker compose -f infra/compose.base.yml up -d

down:
	docker compose -f infra/compose.base.yml down

dev: ## все apps в watch-режиме
	pnpm dev

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

compose-validate: ## синтаксис compose (как в CI)
	docker compose -f infra/compose.base.yml config -q
