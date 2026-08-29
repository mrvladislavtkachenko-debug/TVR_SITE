/**
 * Идемпотентный seed MVP (контракт M2): sources, S1–S4, 3 флоу §13.2,
 * 1 продукт + минимальные en-шаблоны для этих флоу.
 * Запуск: pnpm --filter @tas/db seed
 * Требует только DATABASE_URL (dbEnvSchema) — без Telegram/S3/LLM ключей.
 */
import { dbEnvSchema, loadRootEnv, parseEnv } from '@tas/shared';
import { createPrisma } from '../src/client.js';
import { SEED_FLOWS as FLOWS } from './flowDefinitions.js';

loadRootEnv();
const env = parseEnv(dbEnvSchema);
const prisma = createPrisma(env.DATABASE_URL);

// --- 1. sources ------------------------------------------------------------
const SOURCES = [
  { code: 'pinterest', name: 'Pinterest (organic)' },
  { code: 'direct', name: 'Direct / unknown' },
  { code: 'telegram_organic', name: 'Telegram (поиск/шеринг)' },
];

// --- 2. сегменты S1–S4 (§6.2) + служебные/динамические (M5/M6) -----------
const SEGMENTS: {
  code: string;
  name: string;
  kind?: 'static' | 'dynamic';
  rule_json?: unknown;
}[] = [
  { code: 'S1', name: 'Планировщица — рутины и порядок' },
  { code: 'S2', name: 'Начинающая самостоятельная — переходы/первый опыт' },
  { code: 'S3', name: 'Микро-предприниматель — шаблоны и процессы' },
  { code: 'S4', name: 'Саморазвитие — привычки и мотивация' },
  // M5 (§11.2 /stop, §13.1 guard 'unsubscribed'): материализация отписки
  { code: 'unsubscribed', name: 'Отписался (/stop) — не писать первым' },
  // M6 (§12.2): динамические правила — cron-пересчёт раз в час (apps/worker)
  {
    code: 'intent_high',
    name: 'Открыл checkout, не купил 48h',
    kind: 'dynamic',
    rule_json: {
      match: 'all',
      rules: [
        { event: 'checkout_opened', op: 'gte', count: 1, within_hours: 48 },
        { event: 'purchase_completed', op: 'lte', count: 0, within_hours: 48 },
      ],
    },
  },
  {
    code: 'cold',
    name: '0 content_viewed за 7 дней',
    kind: 'dynamic',
    rule_json: {
      match: 'all',
      rules: [{ event: 'content_viewed', op: 'lte', count: 0, within_hours: 168 }],
    },
  },
];

// --- 3. флоу: определения в ./flowDefinitions.ts (общие с тестами) -----
// --- 4. en-шаблоны для флоу (message_templates) ------------------------------
const MENU_BUTTONS = [
  { text: '📚 Получить чек-лист', type: 'callback', data: 'lm:again' },
  { text: '🎯 Мой план', type: 'callback', data: 'plan:show' },
  { text: '🛍 Products', type: 'callback', data: 'products:list' },
  { text: '💬 Оценить бота', type: 'callback', data: 'feedback:ask' },
  { text: '⚙️ Settings', type: 'callback', data: 'settings:open' },
];

const TEMPLATES: { code: string; body: string; buttons?: unknown }[] = [
  { code: 'ws_value_1', body: 'Совет №1 по твоей теме: начни день с одного главного действия. Хочешь пример? [Дальше]' },
  { code: 'ws_value_2', body: 'Совет №2: план на неделю умещается в 20 минут. Покажу как.' },
  { code: 'ws_offer_planner', body: 'Planner Pack: всё, что мы разбирали, в готовых шаблонах.' },
  { code: 'ca_objection_1', body: 'Вопросы по Planner Pack? Вот что внутри и как он экономит вечер.' },
  { code: 'ca_bonus_2', body: 'Держи бонус до конца недели: чек-лист «утро без хаоса» в комплекте.' },
  { code: 'wb_reengage', body: 'Продолжим? Один короткий совет в день — и система вернётся на место.' },
  { code: 'pp_thanks_1', body: 'Спасибо за покупку! Planner Pack ниже. Как использовать — 3 шага.' },
  { code: 'pp_feedback_1', body: 'Как тебе Planner Pack? Один клик: 👍 / 👎' },
  // --- M5: шаблоны бота (§11.2–11.4, §39.7 — все ответы из шаблонов) --------
  {
    code: 'bot_welcome_doc',
    body: 'Привет, {{first_name}}! 👋 Твой чек-лист «Утро без хаоса» — в файле ниже. Сохрани его, пригодится!',
  },
  {
    code: 'bot_q1',
    body: 'Что для тебя актуальнее всего прямо сейчас?',
    buttons: [
      { text: 'Рутины и порядок', type: 'callback', data: 'q1:S1' },
      { text: 'Самостоятельность', type: 'callback', data: 'q1:S2' },
      { text: 'Шаблоны и процессы', type: 'callback', data: 'q1:S3' },
      { text: 'Привычки и мотивация', type: 'callback', data: 'q1:S4' },
    ],
  },
  {
    code: 'bot_qw_s1',
    body: 'Понял! Вот 3 шага, с которых стоит начать:\n1. Вечером — 5 минут на план завтрашнего дня.\n2. Утро начинается не с телефона, а с одного главного действия.\n3. Одна рутина за раз: закрепи — потом добавляй следующую.',
  },
  {
    code: 'bot_qw_s2',
    body: 'Понял! Вот 3 шага, с которых стоит начать:\n1. Выбери одно дело недели — только одно.\n2. Разбей его на шаги по 15 минут.\n3. Отмечай сделанное — прогресс мотивирует лучше планов.',
  },
  {
    code: 'bot_qw_s3',
    body: 'Понял! Вот 3 шага, с которых стоит начать:\n1. Опиши один повторяющийся процесс текстом.\n2. Преврати его в шаблон-чек-лист.\n3. Проверь шаблон на реальной задаче и упрости.',
  },
  {
    code: 'bot_qw_s4',
    body: 'Понял! Вот 3 шага, с которых стоит начать:\n1. Привяжи новую привычку к существующему действию.\n2. Начни с 2 минут в день — минимум.\n3. Трекай цепочку дней, а не «идеальность».',
  },
  {
    code: 'bot_q2',
    body: 'Я буду присылать короткие советы 2–3 раза в неделю. Ок?',
    buttons: [
      { text: 'Отлично 👍', type: 'callback', data: 'q2:normal' },
      { text: 'Реже, пожалуйста', type: 'callback', data: 'q2:low' },
    ],
  },
  { code: 'bot_menu', body: 'Главное меню — выбирай:', buttons: MENU_BUTTONS },
  {
    code: 'bot_welcome_back',
    body: 'С возвращением, {{first_name}}! 👋 Всё под рукой:',
    buttons: MENU_BUTTONS,
  },
  { code: 'bot_lm_again', body: 'Держи чек-лист ещё раз 📄' },
  { code: 'bot_plan_no_segment', body: 'Сначала выбери тему — нажми /start, это 30 секунд.' },
  { code: 'bot_products_soon', body: 'Каталог продуктов скоро появится. Пока — твои шаги в «Мой план» ✨' },
  {
    code: 'bot_feedback',
    body: 'Как тебе бот? Один клик:',
    buttons: [
      { text: '👍', type: 'callback', data: 'fb:good' },
      { text: '👎', type: 'callback', data: 'fb:bad' },
    ],
  },
  { code: 'bot_feedback_thanks', body: 'Спасибо за оценку!' },
  {
    code: 'bot_settings',
    body: 'Как часто присылать советы?',
    buttons: [
      { text: 'Нормально (2–3 в неделю)', type: 'callback', data: 'setfreq:normal' },
      { text: 'Реже (1 в неделю)', type: 'callback', data: 'setfreq:low' },
    ],
  },
  { code: 'bot_settings_done', body: 'Готово: частота {{frequency}} ✅' },
  {
    code: 'bot_stop',
    body: 'Готово — все автоматические цепочки выключены, я больше не пишу первой.\nВернуться в любой момент: /start',
  },
  {
    code: 'bot_help',
    body: 'Что я умею:\n• /menu — главное меню\n• /settings — частота советов\n• /support — связаться с владельцем\n\nОстановить подсказки: /stop\nУдалить свои данные (GDPR): напиши владельцу через /support — удалим в течение 72 часов.',
  },
  { code: 'bot_support', body: 'Напиши свой вопрос прямо в чат — владелец читает. Либо FAQ: главный вопрос обычно решается кнопкой «Мой план» в /menu.' },
  { code: 'bot_fsm_hint', body: 'Пожалуйста, выбери вариант кнопкой ниже 👇' },
];

// --- 5. продукт (§5.2: digital product $9–19 через Stars) --------------------
const PRODUCT = {
  code: 'planner_pack',
  name: 'Planner Pack',
  description: 'Набор шаблонов планирования (PDF): день/неделя/месяц + чек-листы.',
  price_stars: 500,
  price_usd: 12.0,
  delivery_kind: 'file' as const,
  delivery_payload: { file_key: 'products/planner_pack.pdf' },
};

async function main(): Promise<void> {
  for (const s of SOURCES) {
    await prisma.sources.upsert({ where: { code: s.code }, update: s, create: s });
  }
  console.log(`sources: ${SOURCES.length} ok`);

  for (const seg of SEGMENTS) {
    await prisma.segments.upsert({
      where: { code: seg.code },
      update: {
        name: seg.name,
        ...(seg.kind === 'dynamic' ? { rule_json: seg.rule_json as never } : {}),
      },
      create: {
        code: seg.code,
        name: seg.name,
        kind: seg.kind ?? 'static',
        ...(seg.kind === 'dynamic' ? { rule_json: seg.rule_json as never } : {}),
      },
    });
  }
  console.log(`segments: ${SEGMENTS.length} ok`);

  for (const t of TEMPLATES) {
    await prisma.message_templates.upsert({
      where: { code_locale_version: { code: t.code, locale: 'en', version: 1 } },
      update: { body: t.body, buttons: (t.buttons ?? null) as never },
      create: { code: t.code, locale: 'en', body: t.body, buttons: (t.buttons ?? null) as never },
    });
  }
  console.log(`message_templates: ${TEMPLATES.length} ok`);

  for (const flow of FLOWS) {
    await prisma.automation_flows.upsert({
      where: { code_version: { code: flow.code, version: 1 } },
      update: { definition: flow.definition as never, status: 'active' },
      create: {
        code: flow.code,
        version: 1,
        definition: flow.definition as never,
        status: 'active',
      },
    });
  }
  console.log(`automation_flows: ${FLOWS.length} ok`);

  await prisma.products.upsert({
    where: { code: PRODUCT.code },
    update: PRODUCT,
    create: PRODUCT,
  });
  console.log('products: 1 ok');
}

main()
  .then(() => prisma.$disconnect())
  .then(() => {
    console.log('Seed completed (idempotent).');
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('Seed failed:', err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
