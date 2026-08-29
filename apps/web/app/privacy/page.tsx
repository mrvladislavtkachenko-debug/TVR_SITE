import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
};

/**
 * Черновик privacy-страницы (PRD §23). Финальный текст — владелец/юрист
 * до деплоя (помечено в PRD: не юридическая консультация).
 */
export default function PrivacyPage() {
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: '640px', margin: '0 auto', padding: '32px 24px', color: '#222', lineHeight: 1.6 }}>
      <h1>Privacy Policy (Draft)</h1>
      <p style={{ color: '#a00', fontSize: '0.85rem' }}>
        DRAFT — финальная редакция публикуется владельцем до продакшн-деплоя.
      </p>
      <h2>What we collect</h2>
      <ul>
        <li>Bridge visit metadata: hashed IP, user-agent class, referer host, random session id (cookie <code>bsid</code>, 30 days).</li>
        <li>Telegram data provided by Telegram Bot API: id, username, first name, language.</li>
        <li>Your interactions with the bot (events: buttons clicked, content viewed, purchases).</li>
        <li>Email — only if you type it yourself.</li>
      </ul>
      <h2>What we do NOT collect</h2>
      <ul>
        <li>Raw IP addresses, geolocation, contacts, chat content beyond 7 days of technical logs.</li>
      </ul>
      <h2>Purpose &amp; retention</h2>
      <ul>
        <li>Attribution and product analytics; retention: events 12 months, raw updates 7 days.</li>
      </ul>
      <h2>Your rights</h2>
      <ul>
        <li>Unsubscribe: /stop in the bot (one command, no dark patterns).</li>
        <li>Data export/deletion: contact the owner via the bot (/support).</li>
      </ul>
    </main>
  );
}
