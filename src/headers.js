// Security headers for every response, with a stricter set for /admin and /api.

export function isPrivatePath(pathname) {
  return pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/');
}

export function applySecurityHeaders(response, pathname, env) {
  const h = new Headers(response.headers);
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'SAMEORIGIN');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (isPrivatePath(pathname)) {
    const media = (env.MEDIA_URL || '').replace(/\/$/, '');
    h.set('X-Robots-Tag', 'noindex, nofollow');
    h.set('Cache-Control', 'no-store');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('X-Frame-Options', 'DENY');
    h.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      `img-src 'self' data: blob:${media ? ' ' + media : ''}`,
      "connect-src 'self'",
      'frame-src https://challenges.cloudflare.com',
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'"
    ].join('; '));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
