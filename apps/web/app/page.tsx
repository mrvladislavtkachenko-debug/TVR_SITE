export default function Home() {
  // TD-003: заглушка M1. Bridge /m/[slug] — M3, admin — M8.
  return (
    <main style={{ fontFamily: 'system-ui', padding: '4rem 2rem', textAlign: 'center' }}>
      <h1>TAS</h1>
      <p>Pinterest → Telegram Traffic Acquisition System</p>
      <p style={{ opacity: 0.6 }}>
        Scaffold placeholder (M1). Bridge pages <code>/m/:slug</code> arrive in M3.
      </p>
    </main>
  );
}
