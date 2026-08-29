-- TAS 0_init: 24 таблицы (PRD §15 минус link_visits по Э3).
-- DDL в стиле Prisma migrate; raw-SQL дополнения (частичные unique-индексы
-- attributions по Э1 и GIN на events.properties) — в конце файла.
-- Сгенерировано вручную (в среде разработки недоступен binaries.prisma.sh);
-- эквивалентность схеме проверяется: prisma migrate diff --from-schema-datamodel
-- prisma/schema.prisma --to-url $DATABASE_URL --script  → пустой вывод.

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('admin', 'system', 'ai');
CREATE TYPE "AdminRole" AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE "AttributionTouch" AS ENUM ('first', 'last');
CREATE TYPE "BroadcastStatus" AS ENUM ('draft', 'queued', 'sending', 'done', 'cancelled');
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'active', 'paused', 'done');
CREATE TYPE "ClusterStatus" AS ENUM ('active', 'paused');
CREATE TYPE "DeliveryKind" AS ENUM ('file', 'link', 'text');
CREATE TYPE "FlowRunStatus" AS ENUM ('active', 'completed', 'cancelled', 'failed');
CREATE TYPE "FlowStatus" AS ENUM ('draft', 'active', 'archived');
CREATE TYPE "KeywordIntent" AS ENUM ('info', 'template', 'buyer');
CREATE TYPE "KeywordStatus" AS ENUM ('active', 'paused');
CREATE TYPE "LifecycleState" AS ENUM ('new', 'onboarded', 'activated', 'engaged', 'lead', 'customer', 'at_risk', 'churned', 'reactivated', 'blocked');
CREATE TYPE "MessageFrequency" AS ENUM ('normal', 'low');
CREATE TYPE "MessageOutboxKind" AS ENUM ('flow', 'broadcast', 'transactional');
CREATE TYPE "MessageOutboxStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'skipped');
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'paid', 'refunded', 'failed');
CREATE TYPE "PinMetricSource" AS ENUM ('api', 'csv');
CREATE TYPE "PinStatus" AS ENUM ('idea', 'approved', 'scheduled', 'published', 'paused');
CREATE TYPE "SegmentKind" AS ENUM ('static', 'dynamic');
CREATE TYPE "SegmentOrigin" AS ENUM ('onboarding', 'rule', 'manual');

-- CreateTable
CREATE TABLE "sources" (
    "code" VARCHAR(32) NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_clusters" (
    "id" BIGSERIAL NOT NULL,
    "slug" VARCHAR(96) NOT NULL,
    "name" TEXT NOT NULL,
    "board_name" VARCHAR(128),
    "locale" VARCHAR(8) NOT NULL DEFAULT 'en',
    "status" "ClusterStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keywords" (
    "id" BIGSERIAL NOT NULL,
    "cluster_id" BIGINT NOT NULL,
    "phrase" VARCHAR(255) NOT NULL,
    "intent" "KeywordIntent" NOT NULL,
    "est_volume" INTEGER,
    "status" "KeywordStatus" NOT NULL DEFAULT 'active',

    CONSTRAINT "keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pins" (
    "id" BIGSERIAL NOT NULL,
    "cluster_id" BIGINT NOT NULL,
    "keyword_id" BIGINT,
    "campaign_id" BIGINT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "creative_variants" JSONB,
    "image_url" TEXT,
    "pin_id_pinterest" VARCHAR(32),
    "board" VARCHAR(128),
    "status" "PinStatus" NOT NULL DEFAULT 'idea',
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landing_pages" (
    "id" BIGSERIAL NOT NULL,
    "slug" VARCHAR(96) NOT NULL,
    "cluster_id" BIGINT NOT NULL,
    "headline" TEXT NOT NULL,
    "bullets" JSONB,
    "cta_text" TEXT NOT NULL,
    "template" VARCHAR(32) NOT NULL DEFAULT 'default',
    "variant" VARCHAR(8) NOT NULL DEFAULT 'A',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "landing_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_links" (
    "id" BIGSERIAL NOT NULL,
    "short_code" VARCHAR(16) NOT NULL,
    "source_id" VARCHAR(32) NOT NULL,
    "campaign_id" BIGINT,
    "cluster_id" BIGINT,
    "keyword_id" BIGINT,
    "pin_id" BIGINT,
    "landing_slug" VARCHAR(96),
    "creative_variant" VARCHAR(8),
    "landing_variant" VARCHAR(8),
    "placement" VARCHAR(128),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attributions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "touch" "AttributionTouch" NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "tracking_link_id" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pin_metrics_daily" (
    "pin_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "saves" INTEGER NOT NULL DEFAULT 0,
    "outbound_clicks" INTEGER NOT NULL DEFAULT 0,
    "source" "PinMetricSource" NOT NULL DEFAULT 'csv',

    CONSTRAINT "pin_metrics_daily_pkey" PRIMARY KEY ("pin_id","date")
);

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" VARCHAR(64),
    "first_name" TEXT,
    "locale" VARCHAR(8),
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "blocked_at" TIMESTAMPTZ(3),
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" BIGINT NOT NULL,
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'new',
    "fsm_state" JSONB,
    "interest_segment_id" BIGINT,
    "message_frequency" "MessageFrequency" NOT NULL DEFAULT 'normal',
    "email" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "timezone" VARCHAR(64),
    "onboarding_completed_at" TIMESTAMPTZ(3),
    "activated_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SegmentKind" NOT NULL DEFAULT 'static',
    "rule_json" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_segments" (
    "user_id" BIGINT NOT NULL,
    "segment_id" BIGINT NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "origin" "SegmentOrigin" NOT NULL DEFAULT 'onboarding',

    CONSTRAINT "user_segments_pkey" PRIMARY KEY ("user_id","segment_id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "user_id" BIGINT,
    "tracking_link_id" BIGINT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "properties" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "dedup_key" VARCHAR(128),

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_flows" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "status" "FlowStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_runs" (
    "id" BIGSERIAL NOT NULL,
    "flow_id" BIGINT NOT NULL,
    "flow_version" INTEGER NOT NULL,
    "user_id" BIGINT NOT NULL,
    "status" "FlowRunStatus" NOT NULL DEFAULT 'active',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "context" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "flow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "locale" VARCHAR(8) NOT NULL DEFAULT 'en',
    "body" TEXT NOT NULL,
    "buttons" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "segment_codes" JSONB NOT NULL,
    "template_code" VARCHAR(64) NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3),
    "status" "BroadcastStatus" NOT NULL DEFAULT 'draft',
    "stats" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages_outbox" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "kind" "MessageOutboxKind" NOT NULL,
    "template_code" VARCHAR(64),
    "payload" JSONB,
    "status" "MessageOutboxStatus" NOT NULL DEFAULT 'pending',
    "telegram_message_id" BIGINT,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "dedup_key" VARCHAR(128),
    "broadcast_id" BIGINT,

    CONSTRAINT "messages_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_updates" (
    "id" BIGSERIAL NOT NULL,
    "update_id" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "telegram_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_stars" INTEGER NOT NULL,
    "price_usd" DECIMAL(8,2) NOT NULL,
    "delivery_kind" "DeliveryKind" NOT NULL,
    "delivery_payload" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "stars_amount" INTEGER NOT NULL,
    "usd_equiv" DECIMAL(8,2),
    "telegram_payment_charge_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" BIGSERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret_encrypted" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'owner',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" VARCHAR(64),
    "action" VARCHAR(64) NOT NULL,
    "entity" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(64),
    "meta" JSONB,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_code_key" ON "campaigns"("code");
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");
CREATE UNIQUE INDEX "content_clusters_slug_key" ON "content_clusters"("slug");
CREATE INDEX "keywords_cluster_id_idx" ON "keywords"("cluster_id");
CREATE UNIQUE INDEX "pins_pin_id_pinterest_key" ON "pins"("pin_id_pinterest");
CREATE INDEX "pins_cluster_id_idx" ON "pins"("cluster_id");
CREATE INDEX "pins_status_idx" ON "pins"("status");
CREATE UNIQUE INDEX "landing_pages_slug_key" ON "landing_pages"("slug");
CREATE UNIQUE INDEX "tracking_links_short_code_key" ON "tracking_links"("short_code");
CREATE INDEX "tracking_links_pin_id_idx" ON "tracking_links"("pin_id");
CREATE INDEX "tracking_links_campaign_id_idx" ON "tracking_links"("campaign_id");
CREATE INDEX "attributions_user_id_idx" ON "attributions"("user_id");
CREATE INDEX "attributions_tracking_link_id_idx" ON "attributions"("tracking_link_id");
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");
CREATE INDEX "user_segments_segment_id_removed_at_idx" ON "user_segments"("segment_id", "removed_at");
CREATE UNIQUE INDEX "events_dedup_key_key" ON "events"("dedup_key");
CREATE INDEX "events_name_occurred_at_idx" ON "events"("name", "occurred_at");
CREATE INDEX "events_user_id_occurred_at_idx" ON "events"("user_id", "occurred_at");
CREATE UNIQUE INDEX "automation_flows_code_version_key" ON "automation_flows"("code", "version");
CREATE INDEX "flow_runs_user_id_status_idx" ON "flow_runs"("user_id", "status");
CREATE UNIQUE INDEX "message_templates_code_locale_version_key" ON "message_templates"("code", "locale", "version");
CREATE UNIQUE INDEX "broadcasts_code_key" ON "broadcasts"("code");
CREATE UNIQUE INDEX "segments_code_key" ON "segments"("code");
CREATE UNIQUE INDEX "messages_outbox_dedup_key_key" ON "messages_outbox"("dedup_key");
CREATE INDEX "messages_outbox_status_scheduled_at_idx" ON "messages_outbox"("status", "scheduled_at");
CREATE INDEX "messages_outbox_user_id_idx" ON "messages_outbox"("user_id");
CREATE UNIQUE INDEX "telegram_updates_update_id_key" ON "telegram_updates"("update_id");
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");
CREATE UNIQUE INDEX "orders_telegram_payment_charge_id_key" ON "orders"("telegram_payment_charge_id");
CREATE INDEX "orders_user_id_idx" ON "orders"("user_id");
CREATE INDEX "orders_product_id_paid_at_idx" ON "orders"("product_id", "paid_at");
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");
CREATE INDEX "audit_logs_entity_entity_id_idx" ON "audit_logs"("entity", "entity_id");
CREATE INDEX "audit_logs_ts_idx" ON "audit_logs"("ts");

-- AddForeignKey
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "content_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pins" ADD CONSTRAINT "pins_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "content_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pins" ADD CONSTRAINT "pins_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pins" ADD CONSTRAINT "pins_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "content_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "content_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_pin_id_fkey" FOREIGN KEY ("pin_id") REFERENCES "pins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_tracking_link_id_fkey" FOREIGN KEY ("tracking_link_id") REFERENCES "tracking_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pin_metrics_daily" ADD CONSTRAINT "pin_metrics_daily_pin_id_fkey" FOREIGN KEY ("pin_id") REFERENCES "pins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_tracking_link_id_fkey" FOREIGN KEY ("tracking_link_id") REFERENCES "tracking_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "automation_flows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "messages_outbox" ADD CONSTRAINT "messages_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "messages_outbox" ADD CONSTRAINT "messages_outbox_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Raw-SQL дополнения (невыразимы в Prisma-схеме — контракт M2)
-- ============================================================================

-- Э1: ровно один first_touch на пользователя.
CREATE UNIQUE INDEX "attributions_one_first_touch" ON "attributions"("user_id") WHERE "touch" = 'first';

-- Э1 (следствие): ровно одна АКТУАЛЬНАЯ last_touch (is_current = true);
-- история прошлых касаний остаётся строками с is_current = false.
CREATE UNIQUE INDEX "attributions_one_current_last_touch" ON "attributions"("user_id") WHERE "touch" = 'last' AND "is_current" = true;

-- GIN для поиска по properties (§15.4, аналитика events).
CREATE INDEX "events_properties_gin" ON "events" USING GIN ("properties");
