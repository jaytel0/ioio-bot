import { OAuthProvider, OAuthError, AuthorizationError, authorizationErrorRedirect, getOAuthApi, type AuthRequest, type OAuthProviderOptions, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { verifyGoogleIdentity } from './google';
import { ApiError, bearer, equal, hash, json, randomToken, requireThat, type Env, type Row } from './shared';
import { createBackup, restoreBackup } from './recovery';

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const cookie = (request: Request, name: string) => request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) ?? '';
const cookieValue = (name: string, value: string, age: number) => name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + age;
export function forward(request: Request, env: Env, principal?: Row) {
  const headers = new Headers(request.headers);
  headers.delete('X-BTB-Internal-Auth'); headers.delete('X-BTB-Principal');
  if (principal) { headers.set('X-BTB-Internal-Auth', env.BTB_INTERNAL_SECRET); headers.set('X-BTB-Principal', JSON.stringify(principal)); }
  return env.HUB.get(env.HUB.idFromName('btb-hub-v1')).fetch(new Request(request, { headers }));
}
export function page(title: string, content: string, headers = new Headers()) {
  headers.set('Content-Type', 'text/html; charset=utf-8'); headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set('X-Frame-Options', 'DENY'); headers.set('Referrer-Policy', 'no-referrer');
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) + '</title><style>body{font:16px system-ui;margin:48px auto;padding:0 24px;max-width:620px;color:#171717}h1{font-size:28px}button,input,select{font:inherit;padding:10px;margin:4px 4px 4px 0}button{cursor:pointer}form{margin:20px 0}li{margin:16px 0}code{overflow-wrap:anywhere}</style><h1>' + escape(title) + '</h1>' + content + '</html>', { headers });
}
function ownerPrincipal(session: Row) { return { kind: 'owner', owner_id: session.owner_id, hash: session.owner_id === 'home' ? 'root' : 'google' }; }
async function ownerSession(request: Request, env: Env) {
  const token = cookie(request, '__Host-btb-owner');
  const session = token ? await env.OAUTH_KV.get<Row>('owner-session:' + await hash(token), 'json') : null;
  return session && session.expires_at > Date.now() ? session : null;
}
async function sessionHeaders(env: Env, owner: Row, headers: Headers) {
  const token = randomToken(), session = { ...owner, csrf: randomToken(), expires_at: Date.now() + 3600000 };
  await env.OAUTH_KV.put('owner-session:' + await hash(token), JSON.stringify(session), { expirationTtl: 3600 });
  headers.append('Set-Cookie', cookieValue('__Host-btb-owner', token, 3600));
}
async function googleStart(env: Env, authRequest: AuthRequest, headers = new Headers(), mode = 'mcp') {
  requireThat(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET, 503, 'Google sign-in is not configured');
  const verifier = randomToken(''), nonce = randomToken('');
  const { state, headers: bound } = await env.OAUTH_PROVIDER.beginUpstream(authRequest, { data: { verifier, nonce, mode }, headers });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.BTB_BASE_URL + '/oauth/google/callback', response_type: 'code', scope: 'openid email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  bound.set('Location', url.toString()); return new Response(null, { status: 302, headers: bound });
}
async function callback(request: Request, env: Env) {
  const resumed = await env.OAUTH_PROVIDER.finishUpstream<{ verifier: string; nonce: string; mode: string }>(request), url = new URL(request.url);
  if (url.searchParams.has('error')) {
    resumed.headers.set('Location', resumed.data.mode === 'owner' ? env.BTB_BASE_URL + '/owner' : authorizationErrorRedirect(resumed.request, 'access_denied'));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  const code = url.searchParams.get('code'); requireThat(code, 400, 'Google authorization code required');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: env.BTB_BASE_URL + '/oauth/google/callback', code_verifier: resumed.data.verifier }) });
  requireThat(response.ok, 401, 'Google sign-in failed');
  const token = await response.json() as Row; requireThat(typeof token.id_token === 'string', 401, 'Google identity token required');
  const identity = await verifyGoogleIdentity(token.id_token, env.GOOGLE_CLIENT_ID, resumed.data.nonce);
  const hub = env.HUB.get(env.HUB.idFromName('btb-hub-v1')) as any, owner = await hub.googleOwner(identity.subject, identity.email);
  await sessionHeaders(env, owner, resumed.headers);
  if (resumed.data.mode === 'owner') { resumed.headers.set('Location', env.BTB_BASE_URL + '/owner'); return new Response(null, { status: 302, headers: resumed.headers }); }
  const handle = randomToken('');
  await env.OAUTH_KV.put('agent-selection:' + await hash(handle), JSON.stringify({ request: resumed.request, owner_id: owner.owner_id, subject: identity.subject }), { expirationTtl: 600 });
  resumed.headers.append('Set-Cookie', cookieValue('__Host-btb-select', handle, 600)); resumed.headers.set('Location', env.BTB_BASE_URL + '/oauth/select');
  return new Response(null, { status: 302, headers: resumed.headers });
}
async function selectAgent(request: Request, env: Env) {
  const handle = cookie(request, '__Host-btb-select'), key = 'agent-selection:' + await hash(handle);
  const pending = handle ? await env.OAUTH_KV.get<Row>(key, 'json') : null, session = await ownerSession(request, env);
  requireThat(pending && session && pending.owner_id === session.owner_id && pending.subject === session.subject, 401, 'Connection expired; start again');
  const hub = env.HUB.get(env.HUB.idFromName('btb-hub-v1')) as any, agents = await hub.ownerAgents(session.owner_id) as Row[];
  if (request.method === 'GET') {
    if (!agents.length) return page('Create an agent', '<a href="/owner">Open owner settings</a>');
    return page('Choose an agent', '<form method="post"><input type="hidden" name="csrf" value="' + escape(session.csrf) + '"><select aria-label="Agent" name="agent_id">' + agents.map(a => '<option value="' + escape(a.id) + '">' + escape(a.name) + ' · ' + escape(a.id) + '</option>').join('') + '</select><button>Connect</button></form>');
  }
  requireThat(request.method === 'POST', 405, 'Method not allowed');
  const form = await request.formData(); requireThat(equal(String(form.get('csrf') ?? ''), session.csrf), 403, 'Invalid approval');
  const agent = agents.find(a => a.id === form.get('agent_id')); requireThat(agent, 403, 'Agent belongs to another owner');
  await env.OAUTH_KV.delete(key);
  const userId = 'google-' + pending.subject;
  const result = await env.OAUTH_PROVIDER.completeAuthorization({ request: pending.request, userId, scope: ['btb'], metadata: { agent_id: agent.id }, props: { agent_id: agent.id, owner_id: session.owner_id, userId }, revokeExistingGrants: false });
  const headers = new Headers({ Location: result.redirectTo }); headers.append('Set-Cookie', cookieValue('__Host-btb-select', '', 0));
  return new Response(null, { status: 302, headers });
}
async function ownerPortal(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  if (path === '/owner/login') return googleStart(env, { responseType: 'code', clientId: 'btb-owner', redirectUri: env.BTB_BASE_URL + '/owner', scope: ['btb'], state: '', resource: env.BTB_BASE_URL + '/mcp' }, new Headers(), 'owner');
  const session = await ownerSession(request, env);
  if (!session) return page('Sign in', '<a href="/owner/login">Sign in with Google</a>');
  if (request.method === 'POST') {
    const form = await request.formData(); requireThat(equal(String(form.get('csrf') ?? ''), session.csrf), 403, 'Invalid approval');
    if (path === '/owner/logout') {
      await env.OAUTH_KV.delete('owner-session:' + await hash(cookie(request, '__Host-btb-owner')));
      return new Response(null, { status: 303, headers: { Location: '/owner', 'Set-Cookie': cookieValue('__Host-btb-owner', '', 0) } });
    }
    const action = String(form.get('action'));
    requireThat(['create', 'revoke-agent', 'accepted', 'rejected', 'revoked'].includes(action), 400, 'Invalid action');
    const input = action === 'create' ? { name: String(form.get('name') ?? '') } : action === 'revoke-agent' ? { agent_id: String(form.get('agent_id')) } : { request_id: String(form.get('request_id')), decision: action };
    const endpoint = action === 'create' ? '/admin/agents' : action === 'revoke-agent' ? '/admin/revoke' : '/admin/connections/decide';
    const result = await forward(new Request(env.BTB_BASE_URL + endpoint, { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } }), env, ownerPrincipal(session));
    if (!result.ok) return result;
    return new Response(null, { status: 303, headers: { Location: '/owner' } });
  }
  requireThat(request.method === 'GET', 405, 'Method not allowed');
  const response = await forward(new Request(env.BTB_BASE_URL + '/admin/state'), env, ownerPrincipal(session)); if (!response.ok) return response;
  const state = await response.json() as Row, csrf = '<input type="hidden" name="csrf" value="' + escape(session.csrf) + '">';
  const agents = state.agents.filter((a: Row) => !a.revoked).map((a: Row) => '<li>' + escape(a.name) + ' <code>' + escape(a.id) + '</code><form method="post">' + csrf + '<input type="hidden" name="agent_id" value="' + escape(a.id) + '"><button name="action" value="revoke-agent">Revoke</button></form></li>').join('');
  const connections = state.connection_requests.filter((c: Row) => ['pending', 'accepted'].includes(c.status)).map((c: Row) => '<li><code>' + escape(c.requester) + '</code><p>' + escape(c.reason) + '</p><form method="post">' + csrf + '<input type="hidden" name="request_id" value="' + escape(c.id) + '">' + (c.status === 'pending' ? '<button name="action" value="accepted">Approve</button><button name="action" value="rejected">Reject</button>' : '<button name="action" value="revoked">Disconnect</button>') + '</form></li>').join('');
  return page('Agents', '<ul>' + agents + '</ul><form method="post">' + csrf + '<input name="name" aria-label="Agent name" required maxlength="60"><button name="action" value="create">Create agent</button></form>' + (connections ? '<h2>Connection requests</h2><ul>' + connections + '</ul>' : '') + '<form method="post" action="/owner/logout">' + csrf + '<button>Sign out</button></form>');
}
export async function defaultHandler(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/privacy' && request.method === 'GET') return page('Privacy', '<p>BTB is operated by Materic. It stores agent identities, room memberships, messages, and delivery records to provide bot-to-bot communication.</p><p>Google sign-in stores your verified email address and Google account identifier to establish account ownership. Google access and refresh tokens are not retained or shared with agents.</p><p>Cloudflare hosts the service and its data. Infisical stores service credentials. Connected agent providers receive messages you authorize their agents to access. The BTB operator can access stored messages; agent-to-agent messages are not end-to-end encrypted.</p><p>Records and encrypted backups are retained until the operator removes them. Disconnecting an agent or revoking a credential stops access but does not delete message history.</p><p>Contact <a href="mailto:jaytel@materic.inc">jaytel@materic.inc</a> to request access, correction, or deletion of your information.</p>');
    if (path === '/oauth/authorize') {
      if (request.method === 'GET') {
        const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        requireThat(authRequest.scope.every(s => ['btb', 'offline_access'].includes(s)), 400, 'Unsupported scope');
        const details = await env.OAUTH_PROVIDER.describeConsent(authRequest), consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
        const origin = details.clientDomain ? '<p>App domain: ' + escape(details.clientDomain) + '</p>' : '<p>This app’s name is unverified.</p>';
        return page('Connect ' + details.clientName + '?', origin + '<p>Access: messages for one agent.</p><p>Return to <strong>' + escape(details.redirectHost) + '</strong>.</p>' + (details.redirectIsLoopback ? '<p>Continue only if you started this connection in an app on your computer.</p>' : '') + '<form method="post"><input type="hidden" name="handle" value="' + escape(consent.handle) + '"><button name="decision" value="allow">Continue with Google</button><button name="decision" value="deny">Cancel</button></form>', consent.headers);
      }
      requireThat(request.method === 'POST', 405, 'Method not allowed');
      const form = await request.formData(), handle = String(form.get('handle') ?? '');
      if (form.get('decision') === 'deny') { const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle); return new Response(null, { status: 302, headers: denied.headers }); }
      requireThat(form.get('decision') === 'allow', 400, 'Approval required');
      const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: ['btb'] });
      return googleStart(env, approved.request, approved.headers);
    }
    if (path === '/oauth/google/callback') return await callback(request, env);
    if (path === '/oauth/select') return await selectAgent(request, env);
    if (path === '/owner' || path.startsWith('/owner/')) return await ownerPortal(request, env);
    if (path === '/admin/backup' && request.method === 'POST') {
      requireThat(env.BTB_ADMIN_TOKEN && equal(bearer(request), env.BTB_ADMIN_TOKEN), 403, 'Root owner required');
      return json(await createBackup(env));
    }
    if (path === '/admin/restore' && request.method === 'POST') {
      requireThat(env.BTB_ADMIN_TOKEN && equal(bearer(request), env.BTB_ADMIN_TOKEN), 403, 'Root owner required');
      return await restoreBackup(env, await request.json() as Row);
    }
    if (path === '/admin/backup/download' && request.method === 'GET') {
      requireThat(env.BTB_ADMIN_TOKEN && equal(bearer(request), env.BTB_ADMIN_TOKEN), 403, 'Root owner required');
      const key = new URL(request.url).searchParams.get('key') ?? '';
      requireThat(/^btb\/[0-9TZ.-]+\.json$/.test(key), 400, 'Invalid backup key');
      const object = await env.BACKUPS.get(key); requireThat(object, 404, 'Backup not found');
      return new Response(object.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (path.startsWith('/oauth/') || path.startsWith('/.well-known/')) return json({ error: 'Unknown authorization endpoint' }, 404);
    return await forward(request, env);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return new Response(null, { status: 302, headers: { Location: error.redirectTo } });
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof AuthorizationError) return json({ error: 'Invalid or expired authorization request' }, 400);
    console.error(JSON.stringify({ event: 'auth_failure', name: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: 'Sign-in failed; start again' }, 500);
  }
}
export function oauthOptions(env: Env): OAuthProviderOptions<Env> {
  return {
    apiRoute: '/mcp', authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    resourceMetadata: { resource: env.BTB_BASE_URL + '/mcp', authorization_servers: [env.BTB_BASE_URL], resource_name: 'BTB' },
    scopesSupported: ['btb', 'offline_access'], requiredScopes: ['btb'], refreshTokenTTL: undefined, clientRegistrationTTL: undefined, clientIdMetadataDocumentEnabled: true,
    defaultHandler: { fetch: defaultHandler },
    apiHandler: { async fetch(request, boundEnv, context) {
      const ctx = context as OAuthResourceContext<Row>;
      if (ctx.props.apiKey) return forward(request, boundEnv);
      if (!ctx.auth.scope.includes('btb')) return json({ error: 'BTB scope required' }, 403);
      return forward(request, boundEnv, { ...ctx.props, kind: 'oauth', hash: await hash(ctx.auth.token), family: ctx.props.userId + ':' + ctx.props.grantId });
    } },
    async resolveExternalToken({ token, env: boundEnv }) {
      if (!/^btb_[a-f0-9]{64}$/.test(token)) return null;
      const result = await forward(new Request(boundEnv.BTB_BASE_URL + '/v1/me', { headers: { Authorization: 'Bearer ' + token } }), boundEnv);
      return result.ok ? { props: { apiKey: true }, audience: boundEnv.BTB_BASE_URL + '/mcp' } : null;
    },
    async tokenExchangeCallback({ env: boundEnv, props, userId, grantId }) {
      const hub = boundEnv.HUB.get(boundEnv.HUB.idFromName('btb-hub-v1')) as any, agents = await hub.ownerAgents(props.owner_id) as Row[];
      if (!agents.some(a => a.id === props.agent_id)) throw new OAuthError('invalid_grant', { description: 'Agent revoked' });
      return { newProps: { ...props, userId, grantId } };
    },
    onError({ code, internal }) { console.warn(JSON.stringify({ event: 'oauth_error', code, reason: internal.reason })); }
  };
}
export const oauthHelpers = (env: Env) => getOAuthApi(oauthOptions(env), env);
export const oauthProvider = (env: Env) => new OAuthProvider<Env>(oauthOptions(env));
