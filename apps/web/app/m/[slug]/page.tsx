import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  buildDedupKey,
  classifyUaClass,
  epochMinuteOf,
  isTrackingToken,
  telegramDeepLink,
} from '@tas/shared';
import {
  ipHash,
  recordEvents,
  resolveTrackingLink,
  type TrackingLinkRow,
} from '@tas/db/services';
import { getServerConfig } from '@/src/server/config';
import { getServerDeps } from '@/src/server/deps';

/**
 * Bridge-страница (PRD §9.4, AN-15): динамический лёгкий рендер —
 * серверный лог link_click/bridge_view + кэш резолва 60s; HTML < 10KB,
 * без клиентского фреймворка (LCP-бюджет 1.5s, mobile-first).
 * При недоступности БД/Redis страница всё равно рендерится (деградация):
 * атрибуция достроится по telegram_start (authoritative, M5).
 */

export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

interface LandingContent {
  headline: string;
  bullets: string[];
  ctaText: string;
}

/**
 * JSON для встраивания в inline-<script>: JSON.stringify НЕ экранирует `<`,
 * поэтому `</script>` внутри значения рвёт тег (XSS). Экранируем `<` и U+2028/9.
 */
function jsonForScript(value: string | null | undefined): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const FALLBACK_CONTENT: LandingContent = {
  headline: 'Get your checklist in Telegram',
  bullets: ['The exact step-by-step checklist from this pin', 'Free — takes 10 seconds', 'No spam, unsubscribe anytime'],
  ctaText: 'Open in Telegram',
};

interface BridgeModel {
  headline: string;
  bullets: string[];
  ctaText: string;
  ctaHref: string;
  slug: string;
  token: string | null;
  sessionId: string | null;
  beaconScript: string;
}

async function fetchLanding(executor: ReturnType<typeof getServerDeps>['executor'], slug: string): Promise<LandingContent | null> {
  try {
    const rows = (
      await executor.query(
        'SELECT headline, bullets, cta_text FROM landing_pages WHERE slug = $1 AND is_active',
        [slug],
      )
    ).rows as { headline: string; bullets: unknown; cta_text: string }[];
    const row = rows[0];
    if (!row) return null;
    const bullets = Array.isArray(row.bullets) ? row.bullets.filter((b): b is string => typeof b === 'string') : [];
    return { headline: row.headline, bullets: bullets.length > 0 ? bullets : FALLBACK_CONTENT.bullets, ctaText: row.cta_text };
  } catch {
    return null; // деградация: БД недоступна
  }
}

export default async function BridgePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  // Безопасность: slug из URL попадает в SQL-lookup и inline-скрипт beacon.
  // Строгий формат (как у landing_pages.slug) — прочее 404; исключает
  // path-traversal и XSS через `</script>` в slug (reflected XSS на bridge).
  if (!/^[a-z0-9](?:[a-z0-9-]{0,95})$/.test(slug)) {
    notFound();
  }
  const sp = await searchParams;
  const tRaw = Array.isArray(sp.t) ? sp.t[0] : sp.t;
  const token = typeof tRaw === 'string' ? tRaw.trim() : '';

  const cfg = getServerConfig();
  const deps = getServerDeps();
  const tokenValid = isTrackingToken(token, cfg.tokenFormat);

  let link: TrackingLinkRow | null = null;
  let sessionId: string | null = null;

  if (tokenValid) {
    // резолв + события — best-effort: ошибки не роняют страницу
    try {
      link = await resolveTrackingLink(deps, token, cfg.tokenFormat);
    } catch {
      link = null;
    }
    try {
      sessionId = (await cookies()).get('bsid')?.value ?? null;
    } catch {
      sessionId = null;
    }

    const h = await headers();
    const ua = h.get('user-agent') ?? undefined;
    const referer = h.get('referer');
    const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0';
    const minute = epochMinuteOf();
    const bucketKey = sessionId ?? ipHash(ip, cfg.encryptionKey);
    const common = { token, slug, session_id: sessionId ?? undefined, ua_class: classifyUaClass(ua) };
    try {
      await recordEvents(deps, [
        {
          name: 'link_click',
          trackingLinkId: link?.id ?? null,
          properties: {
            ...common,
            referer_host: referer ? new URL(referer).hostname : undefined,
            ip_hash: ipHash(ip, cfg.encryptionKey),
          },
          dedupKey: buildDedupKey('link_click', token, bucketKey, minute),
        },
        {
          name: 'bridge_view',
          trackingLinkId: link?.id ?? null,
          properties: common,
          dedupKey: buildDedupKey('bridge_view', token, bucketKey, minute),
        },
      ]);
    } catch {
      // события — аналитика, не блокируют конверсию
    }
  }

  const landingSlug = link?.landing_slug ?? slug;
  const content = (await fetchLanding(deps.executor, landingSlug)) ?? FALLBACK_CONTENT;
  const ctaHref = tokenValid
    ? telegramDeepLink(cfg.botUsername, token)
    : `https://t.me/${cfg.botUsername}`;

  const beaconScript = tokenValid
    ? `var d=document,s=d.getElementById('cta');s&&s.addEventListener('click',function(){var p=JSON.stringify({name:'telegram_click',properties:{slug:${jsonForScript(slug)},token:${jsonForScript(token)},session_id:${jsonForScript(sessionId)}})});try{if(navigator.sendBeacon)navigator.sendBeacon('/api/v1/events',new Blob([p],{type:'application/json'}));else fetch('/api/v1/events',{method:'POST',headers:{'Content-Type':'application/json'},body:p,keepalive:true});}catch(e){}});`
    : '';

  const model: BridgeModel = {
    headline: content.headline,
    bullets: content.bullets,
    ctaText: content.ctaText,
    ctaHref,
    slug,
    token: tokenValid ? token : null,
    sessionId,
    beaconScript,
  };

  return (
    <main style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#faf9f7', color: '#1a1a1a', margin: 0, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ maxWidth: '420px', width: '100%', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.6rem', lineHeight: 1.25, margin: '0 0 16px' }}>{model.headline}</h1>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px', color: '#444', fontSize: '1rem', lineHeight: 1.6 }}>
          {model.bullets.map((b) => (
            <li key={b} style={{ marginBottom: '8px' }}>✓ {b}</li>
          ))}
        </ul>
        <a
          id="cta"
          href={model.ctaHref}
          style={{ display: 'block', background: '#2aa15a', color: '#fff', textDecoration: 'none', fontWeight: 700, fontSize: '1.1rem', padding: '16px 24px', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}
        >
          {model.ctaText} →
        </a>
        <p style={{ color: '#777', fontSize: '0.85rem', marginTop: '12px' }}>Free · Opens Telegram · Takes 10 seconds</p>
        <p style={{ color: '#999', fontSize: '0.75rem', marginTop: '24px' }}>
          <a href="/privacy" style={{ color: '#888' }}>Privacy</a>
        </p>
      </div>
      {model.beaconScript ? <script dangerouslySetInnerHTML={{ __html: model.beaconScript }} /> : null}
    </main>
  );
}
