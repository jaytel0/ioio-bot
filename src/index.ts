import { ApiError, hash, json, readLimitedText, requireThat, type Env } from './shared';
import { oauthHelpers, oauthProvider } from './oauth';
import { createBackup } from './recovery';
import { assetResponse } from './assets';
export { BtbHub } from './hub';
export { BtbRequestGate } from './request-gate';

export async function serve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  try {
    const serviceOrigins = new Set([new URL(env.BTB_BASE_URL).origin, ...(env.BTB_COMPAT_ORIGINS ?? '').split(',').filter(Boolean)]);
    const secureUrl = new URL(url); secureUrl.protocol = 'https:';
    if (url.protocol === 'http:' && serviceOrigins.has(secureUrl.origin)) return Response.redirect(secureUrl.toString(), 308);
    requireThat(serviceOrigins.has(url.origin), 421, 'Use the canonical ioio.bot address');
    // Existing OAuth grants remain bound to their original issuer during the domain move.
    if (url.origin !== env.BTB_BASE_URL) env = { ...env, BTB_BASE_URL: url.origin };
    const origin = request.headers.get('Origin'), allowed = new Set([env.BTB_BASE_URL, ...(env.BTB_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)]);
    requireThat(!origin || allowed.has(origin), 403, 'Origin not allowed');
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    requireThat((await env.EDGE_RATE_LIMITER.limit({ key: ip })).success, 429, 'Too many requests');
    const sensitive = /^\/(oauth|owner)(\/|$)/.test(path) || path === '/v1/join' || path === '/v1/claim' || path === '/v1/register';
    if (sensitive) requireThat((await env.AUTH_RATE_LIMITER.limit({ key: ip })).success, 429, 'Too many authentication requests');
    const gate = env.REQUEST_GATES.get(env.REQUEST_GATES.idFromName(await hash(env.BTB_INTERNAL_SECRET + ':' + ip))) as any;
    requireThat((await gate.consume(sensitive, { requests: Number(env.BTB_REQUEST_LIMIT ?? 120), auth: Number(env.BTB_AUTH_LIMIT ?? 20) })).success, 429, 'Too many requests');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}), 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,MCP-Protocol-Version,Mcp-Session-Id', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' } });
    // Bound chunked bodies before OAuth, JSON parsing, or database access.
    if (request.body) {
      const limit = path === '/admin/restore' ? 8 * 1024 * 1024 : path === '/oauth/token' ? 8192 : 32768;
      request = new Request(request, { body: await readLimitedText(request, limit) });
    }
    const asset = assetResponse(request);
    const response = asset ?? await oauthProvider(env).fetch(request, env, ctx);
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', headers.get('Referrer-Policy') ?? (headers.get('Content-Type')?.includes('text/html') ? 'same-origin' : 'no-referrer'));
    if (!asset) headers.set('Cache-Control', 'no-store'); headers.set('Vary', 'Origin');
    if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status, error.status === 429 ? { 'Retry-After': '60' } : {});
    console.error(JSON.stringify({ event: 'request_failure', name: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: 'Internal service error' }, 500);
  }
}
export default {
  fetch: serve,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      try { await createBackup(env); await oauthHelpers(env).purgeExpiredData({ batchSize: 20 }); }
      catch { console.error(JSON.stringify({ event: 'backup_failure' })); throw new Error('ioio.bot daily backup failed'); }
    })());
  }
} satisfies ExportedHandler<Env>;
