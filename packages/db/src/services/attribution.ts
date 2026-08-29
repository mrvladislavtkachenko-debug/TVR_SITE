import {
  DEFAULT_TOKEN_FORMAT,
  generateTrackingTokenExcluding,
  isTrackingToken,
  type TokenFormat,
} from '@tas/shared';
import type { SqlExecutor } from './sql.js';
import { TRACKING_LINK_TTL_SEC, trackingLinkCacheKey, type KvCache } from './cache.js';

/**
 * Атрибуция (PRD §10): issue — генерация tracking_links с retry при коллизии;
 * resolve — по short_code с кэшем 60s (позитивным и негативным).
 * Формат токена зафиксирован env (ATTRIBUTION_TOKEN_PREFIX/NANOID_LEN) — менять нельзя.
 */

export interface TrackingLinkRow {
  id: string;
  short_code: string;
  source_id: string;
  campaign_id: string | null;
  cluster_id: string | null;
  keyword_id: string | null;
  pin_id: string | null;
  landing_slug: string | null;
  creative_variant: string | null;
  landing_variant: string | null;
  placement: string | null;
}

const SELECT_COLUMNS =
  'id, short_code, source_id, campaign_id, cluster_id, keyword_id, pin_id, landing_slug, creative_variant, landing_variant, placement';

interface RawRow {
  id: string | bigint;
  short_code: string;
  source_id: string;
  campaign_id: string | bigint | null;
  cluster_id: string | bigint | null;
  keyword_id: string | bigint | null;
  pin_id: string | bigint | null;
  landing_slug: string | null;
  creative_variant: string | null;
  landing_variant: string | null;
  placement: string | null;
}

function normalize(row: RawRow): TrackingLinkRow {
  return {
    id: String(row.id),
    short_code: row.short_code,
    source_id: row.source_id,
    campaign_id: row.campaign_id === null ? null : String(row.campaign_id),
    cluster_id: row.cluster_id === null ? null : String(row.cluster_id),
    keyword_id: row.keyword_id === null ? null : String(row.keyword_id),
    pin_id: row.pin_id === null ? null : String(row.pin_id),
    landing_slug: row.landing_slug,
    creative_variant: row.creative_variant,
    landing_variant: row.landing_variant,
    placement: row.placement,
  };
}

export interface IssueTrackingLinkInput {
  sourceId: string;
  campaignId?: string | null;
  clusterId?: string | null;
  keywordId?: string | null;
  pinId?: string | null;
  landingSlug?: string | null;
  creativeVariant?: string | null;
  landingVariant?: string | null;
  placement?: string | null;
}

/**
 * Создать tracking_link: токен t1+nanoid(10) (формат из env), INSERT с
 * ON CONFLICT (short_code) DO NOTHING + retry при коллизии (вероятность ~0,
 * защита детерминированная; без чтения таблицы — коллизию ловит БД).
 */
export async function issueTrackingLink(
  deps: { executor: SqlExecutor; cache?: KvCache },
  input: IssueTrackingLinkInput,
  format: TokenFormat = DEFAULT_TOKEN_FORMAT,
): Promise<TrackingLinkRow> {
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateTrackingTokenExcluding(tried, format);
    const result = await deps.executor.query(
      `INSERT INTO tracking_links
         (short_code, source_id, campaign_id, cluster_id, keyword_id, pin_id,
          landing_slug, creative_variant, landing_variant, placement)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (short_code) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        token,
        input.sourceId,
        input.campaignId ?? null,
        input.clusterId ?? null,
        input.keywordId ?? null,
        input.pinId ?? null,
        input.landingSlug ?? null,
        input.creativeVariant ?? null,
        input.landingVariant ?? null,
        input.placement ?? null,
      ],
    );
    const rawRow = result.rows[0] as RawRow | undefined;
    if (rawRow) {
      const normalized = normalize(rawRow);
      await deps.cache?.set(
        trackingLinkCacheKey(normalized.short_code),
        JSON.stringify(normalized),
        TRACKING_LINK_TTL_SEC,
      );
      return normalized;
    }
    tried.add(token);
  }
  throw new Error('issueTrackingLink: не удалось занять уникальный short_code');
}

/**
 * Резолв токена: формат-чек → кэш (60s, вкл. негативный) → БД (только is_active).
 * Возвращает null для неизвестного/неактивного/битого токена.
 */
export async function resolveTrackingLink(
  deps: { executor: SqlExecutor; cache?: KvCache },
  token: string,
  format: TokenFormat = DEFAULT_TOKEN_FORMAT,
): Promise<TrackingLinkRow | null> {
  if (!isTrackingToken(token, format)) return null;

  const cacheKey = trackingLinkCacheKey(token);
  const cached = await deps.cache?.get(cacheKey);
  if (cached !== undefined && cached !== null) {
    const parsed: unknown = JSON.parse(cached);
    return parsed === null ? null : (parsed as TrackingLinkRow);
  }

  const result = await deps.executor.query(
    `SELECT ${SELECT_COLUMNS} FROM tracking_links WHERE short_code = $1 AND is_active`,
    [token],
  );
  const rawRow = result.rows[0] as RawRow | undefined;
  const row = rawRow ? normalize(rawRow) : null;
  await deps.cache?.set(cacheKey, JSON.stringify(row), TRACKING_LINK_TTL_SEC);
  return row;
}
