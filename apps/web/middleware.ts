import { NextResponse, type NextRequest } from 'next/server';

/**
 * bsid — first-party session-cookie моста (30 дней, random UUID; §9.4/§23:
 * строго функциональная, не PII). Выдаётся на /m/*, пробрасывается в тот же
 * запрос через заголовок cookie, чтобы server component видел её сразу.
 */
export function middleware(request: NextRequest) {
  const existing = request.cookies.get('bsid')?.value;
  if (existing && /^[0-9a-f]{32}$/.test(existing)) {
    return NextResponse.next();
  }
  const bsid = crypto.randomUUID().replace(/-/g, '');
  const headers = new Headers(request.headers);
  const cookieHeader = request.headers.get('cookie');
  headers.set('cookie', cookieHeader ? `${cookieHeader}; bsid=${bsid}` : `bsid=${bsid}`);
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set('bsid', bsid, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
  return response;
}

export const config = {
  matcher: ['/m/:path*'],
};
