// A tiny method + path-pattern router. Patterns use :name segments; the
// matched params are passed as ctx.params. Handlers return a Response.

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
    return this;
  }
  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }

  /** Returns a Response or null when no route matched. */
  async handle(ctx) {
    const { request, url } = ctx;
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== request.method) continue;
      ctx.params = {};
      r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      // Middleware chain: each handler may return a Response to short-circuit.
      for (const h of r.handlers) {
        const res = await h(ctx);
        if (res instanceof Response) return res;
      }
      return new Response('No response', { status: 500 });
    }
    if (pathMatched) return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    return null;
  }
}
