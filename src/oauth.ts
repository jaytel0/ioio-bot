import { z } from 'zod';
import type { BtbHub } from './hub';
import { ApiError, body, equal, hash, idSchema, json, now, randomCode, randomToken, requireThat, type Row } from './shared';

export class OAuth {
  constructor(private hub: BtbHub) {}
  private resource(request: Request) { return this.hub.base(request) + '/mcp'; }
  async approve(owner: Row, input: unknown) {
    const { code, agent_id } = z.object({ code: z.string().regex(/^\d{8}$/), agent_id: idSchema }).strict().parse(input);
    this.hub.owns(owner, agent_id);
    requireThat(!this.hub.agent(agent_id).revoked, 403, 'Agent revoked');
    const flow = this.hub.db.one('SELECT * FROM oauth_flows WHERE verification_hash = ? AND expires_at > ? AND consumed = 0', await hash(code), Date.now());
    requireThat(flow && !flow.agent_id, 400, 'Invalid, expired, or already approved code');
    this.hub.db.run('UPDATE oauth_flows SET agent_id = ? WHERE id = ?', agent_id, flow.id);
    return { approved: true, agent_id, client_id: flow.client_id, redirect_uri: flow.redirect_uri };
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url), base = this.hub.base(request), resource = this.resource(request);
    if (request.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource, authorization_servers: [base], scopes_supported: ['btb'], resource_documentation: base + '/docs' });
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: base + '/oauth/authorize', token_endpoint: base + '/oauth/token', registration_endpoint: base + '/oauth/register', revocation_endpoint: base + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: ['btb'], authorization_response_iss_parameter_supported: true });
    if (request.method === 'POST' && url.pathname === '/oauth/register') {
      this.hub.rate('oauth-register-global', 1000, 86400000);
      this.hub.rate(`oauth-register:${request.headers.get('CF-Connecting-IP') ?? 'local'}`, 10, 60000);
      const input = z.object({ redirect_uris: z.array(z.string().url()).min(1).max(8), token_endpoint_auth_method: z.literal('none').optional() }).passthrough().parse(await body(request));
      for (const uri of input.redirect_uris) { const u = new URL(uri); requireThat(!u.hash && !u.username && !u.password && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))), 400, 'Redirect must use HTTPS or loopback HTTP, without fragments or credentials'); }
      const id = randomToken('client_');
      this.hub.db.run('INSERT INTO oauth_clients VALUES (?, ?, ?)', id, JSON.stringify(input.redirect_uris), now());
      return json({ client_id: id, redirect_uris: input.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
    }
    if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
      this.hub.rate('oauth-authorize-global', 1000, 86400000);
      this.hub.rate(`oauth-authorize:${request.headers.get('CF-Connecting-IP') ?? 'local'}`, 10, 60000);
      const q = Object.fromEntries(url.searchParams);
      requireThat(q.response_type === 'code' && q.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? ''), 400, 'Authorization code with S256 PKCE required');
      requireThat(q.resource === resource, 400, 'Resource does not match this MCP endpoint');
      requireThat(!q.scope || q.scope.split(' ').every(s => s === 'btb'), 400, 'Unsupported scope');
      const client = this.hub.db.one('SELECT * FROM oauth_clients WHERE id = ?', q.client_id ?? '');
      requireThat(client && JSON.parse(client.redirect_uris).includes(q.redirect_uri), 400, 'Unregistered client or redirect URI');
      const id = randomToken('flow_'); let code: string, digest: string;
      do { code = randomCode(); digest = await hash(code); } while (this.hub.db.one('SELECT 1 FROM oauth_flows WHERE verification_hash = ?', digest));
      this.hub.db.run('INSERT INTO oauth_flows (id, verification_hash, display_code, client_id, redirect_uri, challenge, state, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, digest, code, q.client_id, q.redirect_uri, q.code_challenge, q.state ?? '', resource, Date.now() + 10 * 60000);
      return new Response(null, { status: 303, headers: { Location: base + '/oauth/wait/' + id, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/oauth/wait/')) {
      const flow = this.hub.db.one('SELECT * FROM oauth_flows WHERE id = ?', url.pathname.slice('/oauth/wait/'.length));
      requireThat(flow && flow.expires_at > Date.now() && !flow.consumed, 400, 'Authorization request expired or completed. Reconnect to start again.');
      if (!flow.agent_id) return new Response(`BTB one-time connection approval\n\nVerification code: ${flow.display_code}\nClient callback: ${flow.redirect_uri}\n\nOn the owner's computer, run:\n  btb oauth-approve ${flow.display_code} --agent <BTB agent number>\n\nKeep this tab open. It will redirect after approval. No app interface is required.\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8', Refresh: '3', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } });
      const code = randomToken('code_'), digest = await hash(code);
      this.hub.tx(() => { const active = this.hub.db.one('SELECT consumed FROM oauth_flows WHERE id = ?', flow.id); requireThat(active && !active.consumed, 400, 'Authorization request completed'); this.hub.db.run('UPDATE oauth_flows SET consumed = 1 WHERE id = ?', flow.id); this.hub.db.run('INSERT INTO oauth_codes VALUES (?, ?, ?)', digest, flow.id, Date.now() + 60000); });
      const redirect = new URL(flow.redirect_uri); redirect.searchParams.set('code', code); redirect.searchParams.set('state', flow.state); redirect.searchParams.set('iss', base);
      return new Response(null, { status: 303, headers: { Location: redirect.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    if (request.method === 'POST' && (url.pathname === '/oauth/token' || url.pathname === '/oauth/revoke')) {
      requireThat(Number(request.headers.get('Content-Length') ?? 0) <= 8192, 413, 'OAuth request too large');
      const text = await request.text(); requireThat(text.length <= 8192, 413, 'OAuth request too large');
      const input = Object.fromEntries(new URLSearchParams(text));
      if (url.pathname === '/oauth/revoke') { const found = this.hub.db.one('SELECT * FROM tokens WHERE hash = ?', await hash(input.token ?? '')); if (found && found.client_id === input.client_id) this.hub.db.run('DELETE FROM tokens WHERE family = ?', found.family); return json({}); }
      this.hub.rate(`oauth-token:${request.headers.get('CF-Connecting-IP') ?? 'local'}`, 60, 60000);
      try { return json(await this.token(input, resource)); } catch (error) { if (error instanceof ApiError) return json({ error: 'invalid_grant', error_description: error.message }, 400); throw error; }
    }
    throw new ApiError(404, 'Unknown authorization endpoint');
  }
  private async token(input: Row, resource: string) {
    requireThat(input.resource === resource && typeof input.client_id === 'string', 400, 'Client and matching resource required');
    const access = randomToken(), refresh = randomToken('btb_refresh_');
    const accessHash = await hash(access), refreshHash = await hash(refresh);
    let lookup: string, challenge = '';
    if (input.grant_type === 'authorization_code') {
      requireThat(/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier ?? ''), 400, 'Valid PKCE verifier required');
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.code_verifier)));
      challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      lookup = await hash(input.code ?? '');
    } else { requireThat(input.grant_type === 'refresh_token', 400, 'Unsupported grant'); lookup = await hash(input.refresh_token ?? ''); }
    // Replay revocation must survive rejection, so it is deliberately outside the
    // transaction that creates new credentials.
    if (input.grant_type === 'refresh_token') {
      const replay = this.hub.db.one('SELECT * FROM tokens WHERE hash = ?', lookup);
      if (replay?.used && replay.client_id === input.client_id && replay.resource === resource) { this.hub.db.run('DELETE FROM tokens WHERE family = ?', replay.family); throw new ApiError(400, 'Refresh token replay detected; grant revoked'); }
    }
    this.hub.tx(() => {
      let agentId: string, family: string;
      if (input.grant_type === 'authorization_code') {
        const code = this.hub.db.one('SELECT * FROM oauth_codes WHERE hash = ?', lookup);
        requireThat(code && code.expires_at > Date.now(), 400, 'Code is invalid, expired, or consumed');
        const flow = this.hub.db.one('SELECT * FROM oauth_flows WHERE id = ?', code.flow_id)!;
        requireThat(flow.agent_id && flow.client_id === input.client_id && flow.redirect_uri === input.redirect_uri && flow.resource === resource && equal(flow.challenge, challenge), 400, 'Authorization grant mismatch');
        agentId = flow.agent_id; family = crypto.randomUUID();
        this.hub.db.run('DELETE FROM oauth_codes WHERE hash = ?', lookup);
      } else {
        const prior = this.hub.db.one("SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh' AND used = 0", lookup);
        requireThat(prior && prior.client_id === input.client_id && prior.resource === resource, 400, 'Refresh grant mismatch');
        agentId = prior.agent_id; family = prior.family;
        this.hub.db.run('UPDATE tokens SET used = 1 WHERE hash = ?', lookup);
      }
      const agent = this.hub.agent(agentId); requireThat(!agent.revoked, 400, 'Agent revoked');
      this.hub.db.run("INSERT INTO tokens (hash, agent_id, owner_id, kind, expires_at, client_id, resource, family) VALUES (?, ?, ?, 'oauth', ?, ?, ?, ?), (?, ?, ?, 'refresh', NULL, ?, ?, ?)", accessHash, agentId, agent.owner_id, Date.now() + 3600000, input.client_id, resource, family, refreshHash, agentId, agent.owner_id, input.client_id, resource, family);
    });
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'btb' };
  }
}
