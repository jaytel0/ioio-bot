import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { Store } from './store';
import { ApiError, bearer, body, readLimitedText, canonical, equal, hash, idSchema, inviteSchema, json, now, randomCode, randomToken, requireThat, sendSchema, type Env, type Row } from './shared';
import { oauthHelpers } from './oauth';
import { mcp } from './mcp';
import { Events } from './events';

export class BtbHub extends DurableObject<Env> {
  readonly db: Store;
  readonly events: Events;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Store(ctx.storage.sql);
    this.events = new Events(this);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  get storage() { return this.ctx.storage; }
  background(promise: Promise<unknown>) { this.ctx.waitUntil(promise); }
  base(request: Request) { return this.env.BTB_BASE_URL || new URL(request.url).origin; }
  tx<T>(fn: () => T) { return this.storage.transactionSync(fn); }
  rate(key: string, max = 120, interval = 60000) {
    const time = Date.now();
    const row = this.db.one('SELECT * FROM limits WHERE key = ?', key);
    if (row && row.reset_at > time) {
      requireThat(row.count < max, 429, 'Rate limit reached; retry later');
      this.db.run('UPDATE limits SET count = count + 1 WHERE key = ?', key);
    } else this.db.run('INSERT OR REPLACE INTO limits VALUES (?, 1, ?)', key, time + interval);
  }
  async auth(request: Request, owner = false): Promise<Row> {
    if (this.env.BTB_INTERNAL_SECRET && equal(request.headers.get('X-BTB-Internal-Auth') ?? '', this.env.BTB_INTERNAL_SECRET)) {
      const principal = JSON.parse(request.headers.get('X-BTB-Principal') ?? 'null');
      requireThat(principal && typeof principal.owner_id === 'string', 401, 'Invalid internal identity');
      if (owner) requireThat(principal.kind === 'owner', 403, 'Human owner required');
      else { const agent = this.agent(principal.agent_id); requireThat(!agent.revoked && agent.owner_id === principal.owner_id && principal.kind === 'oauth', 403, 'Agent unavailable'); }
      this.rate(`internal:${principal.owner_id}:${principal.agent_id ?? 'owner'}`);
      return principal;
    }
    const token = bearer(request);
    requireThat(token, 401, 'Authentication required');
    if (this.env.BTB_ADMIN_TOKEN && equal(token, this.env.BTB_ADMIN_TOKEN)) { requireThat(owner, 403, 'Use an agent credential for agent tools'); this.rate('root-owner'); return { owner_id: 'home', kind: 'owner', hash: 'root' }; }
    const row = this.db.one('SELECT * FROM tokens WHERE hash = ?', await hash(token));
    requireThat(row && !row.used && row.kind !== 'refresh' && (!row.expires_at || row.expires_at > Date.now()), 401, 'Invalid or revoked credential');
    if (row.kind === 'oauth') requireThat(row.resource === this.base(request) + '/mcp', 401, 'Token audience mismatch');
    if (row.agent_id) requireThat(!this.agent(row.agent_id).revoked, 401, 'Agent revoked');
    if (owner) requireThat(row.kind === 'owner', 403, 'This action requires the human owner’s credential');
    else requireThat(row.kind !== 'owner', 403, 'Use an agent credential for agent tools');
    this.rate(`auth:${row.hash}`);
    return row;
  }
  agent(id: string): Row { const agent = this.db.one('SELECT * FROM agents WHERE id = ?', id); requireThat(agent, 404, 'Agent not found'); return agent; }
  profile(agent: Row) { return { id: agent.id, name: agent.name, capabilities: JSON.parse(agent.capabilities), created_at: agent.created_at }; }
  googleOwner(subject: string, email: string) {
    requireThat(subject.length > 0 && subject.length <= 256 && email.length <= 320, 400, 'Invalid Google identity');
    return this.tx(() => {
      let owner = this.db.one('SELECT * FROM google_owners WHERE subject = ?', subject);
      if (!owner) {
        const owner_id = email === this.env.BTB_OWNER_EMAIL ? 'home' : crypto.randomUUID();
        requireThat(!this.db.one('SELECT 1 FROM google_owners WHERE owner_id = ?', owner_id), 403, 'Owner identity already bound');
        this.db.run('INSERT INTO google_owners VALUES (?, ?, ?)', subject, owner_id, email);
        owner = { subject, owner_id, email };
        if (owner_id !== 'home') this.createAgent(owner_id, email.split('@')[0] + ' agent');
      }
      return owner;
    });
  }
  ownerAgents(owner_id: string) { return this.db.all('SELECT * FROM agents WHERE owner_id = ? AND revoked = 0', owner_id).map(a => this.profile(a)); }
  checkpointRestore(digest: string, start: number, end: number, complete: boolean) {
    this.tx(() => {
      requireThat(this.db.one("SELECT value FROM recovery_state WHERE key = 'digest'")?.value === digest, 409, 'Restore checkpoint mismatch');
      requireThat(Number(this.db.one("SELECT value FROM recovery_state WHERE key = 'cursor'")?.value) === start, 409, 'Another restore is in progress');
      this.db.run("UPDATE recovery_state SET value = ? WHERE key = 'cursor'", String(end));
      this.db.run("UPDATE recovery_state SET value = ? WHERE key = 'status'", complete ? 'complete' : 'restoring');
    });
  }
  async grantActive(family: string) {
    const at = family.indexOf(':'); if (at < 0) return false;
    const userId = family.slice(0, at), grantId = family.slice(at + 1);
    let cursor: string | undefined;
    do { const page = await oauthHelpers(this.env).listUserGrants(userId, { limit: 100, cursor });
      const grant = page.items.find(g => g.id === grantId); if (grant) return !grant.expiresAt || grant.expiresAt > Date.now() / 1000;
      cursor = page.cursor;
    } while (cursor);
    return false;
  }
  agentId() { let id: string; do { const digits = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000).padStart(9, '0'); id = `A-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`; } while (this.db.one('SELECT 1 FROM agents WHERE id = ?', id)); return id; }
  createAgent(owner: string, name: string, capabilities: string[] = []) {
    requireThat(this.db.one('SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?', owner)!.n < (owner === 'home' ? 1000 : 10), 507, 'Owner agent quota reached');
    const id = this.agentId();
    this.db.run('INSERT INTO agents (id, name, owner_id, capabilities, created_at) VALUES (?, ?, ?, ?, ?)', id, name, owner, JSON.stringify(capabilities), now());
    if (owner === 'home') this.db.run("INSERT INTO members VALUES ('home', ?)", id);
    return this.agent(id);
  }
  owns(owner: Row, agentId: string) { requireThat(this.agent(agentId).owner_id === owner.owner_id, 403, 'Agent belongs to another owner'); }
  linked(a: string, b: string) {
    return a === b || this.agent(a).owner_id === this.agent(b).owner_id || Boolean(this.db.one("SELECT 1 FROM connections WHERE status = 'accepted' AND ((requester = ? AND target = ?) OR (requester = ? AND target = ?))", a, b, b, a));
  }
  member(room: string, agentId: string) { return Boolean(this.db.one('SELECT 1 FROM members WHERE room_id = ? AND agent_id = ?', room, agentId)); }
  message(row: Row) { return { id: row.seq, from: row.sender, to: row.target, room: row.room_id, text: row.text, data: row.data === null ? null : JSON.parse(row.data), kind: row.kind, thread_id: row.thread_id, reply_to: row.reply_to, mentions: JSON.parse(row.mentions), hop_count: row.hop_count, created_at: row.created_at }; }
  canRead(agentId: string, seq: number) { return Boolean(this.db.one('SELECT 1 FROM messages m WHERE m.seq = ? AND (m.sender = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.seq = m.seq AND d.agent_id = ?))', seq, agentId, agentId)); }
  publish(sender: string, input: Row, recipients: string[]) {
    this.db.run('INSERT INTO messages (sender, target, room_id, text, data, kind, thread_id, reply_to, client_message_id, mentions, hop_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', sender, input.to ?? null, input.room ?? null, input.text ?? null, input.data === undefined ? null : JSON.stringify(input.data), input.kind, input.thread_id ?? crypto.randomUUID(), input.reply_to ?? null, input.client_message_id, JSON.stringify(input.mentions ?? []), input.hop_count ?? 0, now());
    const row = this.db.one('SELECT * FROM messages WHERE seq = last_insert_rowid()')!;
    for (const agentId of recipients) {
      const directed = !input.room || input.mentions?.includes(agentId) ? 1 : 0;
      this.db.run('INSERT INTO deliveries (agent_id, seq, directed) VALUES (?, ?, ?)', agentId, row.seq, directed);
      this.events.enqueue(agentId, row.seq, directed);
    }
    return this.message(row);
  }
  async notify(message: Row, recipients: string[]) {
    for (const agentId of recipients) for (const socket of this.ctx.getWebSockets(agentId)) {
      const saved = socket.deserializeAttachment();
      const credential = this.db.one('SELECT * FROM tokens WHERE hash = ?', saved.hash);
      if (!credential || credential.used || (credential.expires_at && credential.expires_at <= Date.now()) || this.agent(agentId).revoked) { socket.close(1008, 'Credential revoked or expired'); continue; }
      try { socket.send(JSON.stringify({ type: 'message', message })); } catch { socket.close(); }
    }
    await this.events.schedule();
    this.background(this.events.flush());
  }
  async send(agentId: string, value: unknown) {
    const input = sendSchema.parse(value);
    requireThat(new TextEncoder().encode(JSON.stringify(input)).length <= 16384, 413, 'Message exceeds 16 KiB');
    const { result, recipients } = this.tx(() => {
      const existing = this.db.one('SELECT * FROM messages WHERE sender = ? AND client_message_id = ?', agentId, input.client_message_id);
      if (existing) {
        const sameContent = existing.target === (input.to ?? null) && existing.room_id === (input.room ?? null) && existing.text === (input.text ?? null) && existing.kind === input.kind && existing.reply_to === (input.reply_to ?? null) && canonical(existing.data === null ? null : JSON.parse(existing.data)) === canonical(input.data ?? null) && canonical(JSON.parse(existing.mentions)) === canonical(input.mentions) && (!input.thread_id || input.thread_id === existing.thread_id) && (input.reply_to || input.hop_count === existing.hop_count);
        requireThat(sameContent, 409, 'client_message_id was already used for a different message');
        return { result: this.message(existing), recipients: [] };
      }
      let recipients: string[];
      if (input.to) {
        requireThat(!this.agent(input.to).revoked, 403, 'Target unavailable');
        requireThat(this.linked(agentId, input.to), 403, 'Connection requires the target owner’s approval');
        recipients = [input.to];
        requireThat(input.mentions.length === 0, 400, 'Mentions apply to room messages');
      } else {
        requireThat(this.member(input.room!, agentId), 403, 'Room access denied');
        recipients = this.db.all('SELECT a.id FROM members m JOIN agents a ON a.id = m.agent_id WHERE m.room_id = ? AND a.revoked = 0 AND a.id != ?', input.room!, agentId).map(a => a.id);
        requireThat(input.mentions.every(id => recipients.includes(id) || id === agentId), 400, 'Mentioned agent is outside this room');
      }
      if (input.reply_to) {
        requireThat(this.canRead(agentId, input.reply_to), 403, 'Reply target is inaccessible');
        const parent = this.db.one('SELECT * FROM messages WHERE seq = ?', input.reply_to)!;
        requireThat((input.to && !parent.room_id && ((parent.sender === agentId && parent.target === input.to) || (parent.sender === input.to && parent.target === agentId))) || (input.room && parent.room_id === input.room), 400, 'A reply must stay in its original conversation');
        requireThat(!input.thread_id || input.thread_id === parent.thread_id, 400, 'Reply thread mismatch');
        input.thread_id = parent.thread_id;
        input.hop_count = parent.hop_count + 1;
        requireThat(input.hop_count <= 8, 400, 'Thread hop limit reached; ask the human before starting another exchange');
      }
      requireThat(Number(this.db.one('SELECT COUNT(*) AS n FROM messages WHERE sender = ?', agentId)!.n) < 50000, 507, 'Agent storage quota reached; contact owner');
      return { result: this.publish(agentId, input, recipients), recipients };
    });
    await this.notify(result, recipients);
    return result;
  }
  inbox(agentId: string, args: Row = {}) {
    const input = z.object({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50), include_acked: z.boolean().default(false), directed_only: z.boolean().default(false) }).strict().parse(args);
    const messages = this.db.all('SELECT m.*, d.acked, d.directed FROM deliveries d JOIN messages m ON m.seq = d.seq WHERE d.agent_id = ? AND d.seq > ? AND (? = 1 OR d.acked = 0) AND (? = 0 OR d.directed = 1) ORDER BY m.seq LIMIT ?', agentId, input.after, +input.include_acked, +input.directed_only, input.limit);
    return { messages: messages.map(m => ({ ...this.message(m), acknowledged: Boolean(m.acked), directed: Boolean(m.directed) })), next_cursor: messages.at(-1)?.seq ?? input.after, acknowledgement_required: true };
  }
  ack(agentId: string, value: unknown) {
    const { message_ids } = z.object({ message_ids: z.array(z.number().int().positive()).min(1).max(100) }).strict().parse(value);
    this.tx(() => { for (const seq of message_ids) { requireThat(this.db.one('SELECT 1 FROM deliveries WHERE agent_id = ? AND seq = ?', agentId, seq), 403, 'Message not in your inbox'); this.db.run('UPDATE deliveries SET acked = 1 WHERE agent_id = ? AND seq = ?', agentId, seq); } });
    return { acknowledged: message_ids };
  }
  async requestConnection(agentId: string, value: unknown) {
    const { to, reason } = z.object({ to: idSchema, reason: z.string().trim().min(1).max(500) }).strict().parse(value);
    requireThat(agentId !== to && !this.agent(to).revoked, 400, 'Invalid target');
    if (this.linked(agentId, to)) return { status: 'accepted', to };
    this.rate(`connect:${agentId}`, 10, 86400000);
    const existing = this.db.one('SELECT * FROM connections WHERE requester = ? AND target = ?', agentId, to);
    if (existing) return { request_id: existing.id, status: existing.status };
    const id = crypto.randomUUID();
    const message = this.tx(() => {
      this.db.run("INSERT INTO connections VALUES (?, ?, ?, ?, 'pending', ?)", id, agentId, to, reason, now());
      return this.publish('BTB', { to, kind: 'connection_request', data: { request_id: id, requester: this.profile(this.agent(agentId)), reason, owner_approval_required: true }, client_message_id: id }, [to]);
    });
    await this.notify(message, [to]);
    return { request_id: id, status: 'pending', owner_approval_required: true };
  }
  async mintInvite(owner: Row, value: unknown) {
    const input = inviteSchema.parse(value);
    if (input.agent_id) this.owns(owner, input.agent_id);
    let code: string, digest: string;
    do { code = randomCode(); digest = await hash(code); } while (this.db.one('SELECT 1 FROM invites WHERE hash = ?', digest));
    const expires = Date.now() + 15 * 60000;
    this.db.run('INSERT INTO invites VALUES (?, ?, ?, ?, ?, ?)', digest, owner.owner_id, input.name, JSON.stringify(input.capabilities), input.agent_id ?? null, expires);
    return { code, expires_at: new Date(expires).toISOString(), credential_expires: false };
  }
  async claim(value: unknown) {
    const { code } = z.object({ code: z.string().regex(/^\d{8}$/) }).strict().parse(value);
    const digest = await hash(code), token = randomToken(), tokenHash = await hash(token);
    const agent = this.tx(() => {
      const invite = this.db.one('SELECT * FROM invites WHERE hash = ?', digest);
      requireThat(invite && invite.expires_at > Date.now(), 400, 'Invalid, consumed, or expired pairing code');
      const a = invite.agent_id ? this.agent(invite.agent_id) : this.createAgent(invite.owner_id, invite.name, JSON.parse(invite.capabilities));
      requireThat(!a.revoked, 403, 'Agent revoked');
      this.db.run('INSERT INTO tokens (hash, agent_id, owner_id, kind) VALUES (?, ?, ?, ?)', tokenHash, a.id, a.owner_id, 'agent');
      this.db.run('DELETE FROM invites WHERE hash = ?', digest);
      return a;
    });
    return { agent: this.profile(agent), token, expires_at: null };
  }
  async admin(owner: Row, request: Request, path: string) {
    const input = request.method === 'GET' ? {} : path === '/admin/restore' ? JSON.parse(await readLimitedText(request, 8 * 1024 * 1024)) : await body(request);
    if (path === '/admin/agents' && request.method === 'POST') { const v = inviteSchema.omit({ agent_id: true }).parse(input); return json(this.profile(this.tx(() => this.createAgent(owner.owner_id, v.name, v.capabilities))), 201); }
    if (path === '/admin/invites' && request.method === 'POST') return json(await this.mintInvite(owner, input), 201);
    if (path === '/admin/connections/decide' && request.method === 'POST') {
      const v = z.object({ request_id: z.string().uuid(), decision: z.enum(['accepted', 'rejected', 'revoked']) }).strict().parse(input);
      const connection = this.db.one('SELECT * FROM connections WHERE id = ?', v.request_id); requireThat(connection, 404, 'Connection request not found');
      if (v.decision === 'revoked') requireThat([this.agent(connection.target).owner_id, this.agent(connection.requester).owner_id].includes(owner.owner_id), 403, 'Connection belongs to another owner'); else this.owns(owner, connection.target);
      this.db.run('UPDATE connections SET status = ? WHERE id = ?', v.decision, connection.id);
      const recipients = [connection.requester, connection.target];
      const message = this.tx(() => this.publish('BTB', { kind: 'connection_status', data: { request_id: connection.id, status: v.decision }, client_message_id: crypto.randomUUID() }, recipients));
      await this.notify(message, recipients);
      return json({ request_id: connection.id, status: v.decision });
    }
    if (path === '/admin/revoke' && request.method === 'POST') {
      const { agent_id } = z.object({ agent_id: idSchema }).strict().parse(input); this.owns(owner, agent_id);
      this.tx(() => { this.db.run('UPDATE agents SET revoked = 1 WHERE id = ?', agent_id); this.db.run('DELETE FROM tokens WHERE agent_id = ?', agent_id); this.db.run('DELETE FROM invites WHERE agent_id = ?', agent_id); this.db.run('DELETE FROM subscriptions WHERE agent_id = ?', agent_id); });
      for (const socket of this.ctx.getWebSockets(agent_id)) socket.close(1008, 'Agent revoked');
      return json({ revoked: agent_id });
    }
    if (path === '/admin/webhook-hosts' && request.method === 'POST') {
      requireThat(owner.hash === 'root', 403, 'Root owner only'); const { host } = z.object({ host: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/) }).strict().parse(input);
      requireThat(!/\.(localhost|local|internal|test|invalid)$/.test(host), 400, 'Public hostname required');
      this.db.run('INSERT OR IGNORE INTO webhook_hosts VALUES (?)', host); return json({ allowed_host: host });
    }
    if (path === '/admin/state' && request.method === 'GET') return json({
      agents: this.db.all('SELECT * FROM agents WHERE owner_id = ?', owner.owner_id).map(a => ({ ...this.profile(a), revoked: Boolean(a.revoked), credentials: this.db.one("SELECT COUNT(*) AS n FROM tokens WHERE agent_id = ? AND kind != 'refresh'", a.id)!.n })),
      rooms: this.db.all('SELECT * FROM rooms WHERE owner_id = ?', owner.owner_id),
      connection_requests: this.db.all('SELECT c.* FROM connections c JOIN agents a ON a.id = c.target WHERE a.owner_id = ?', owner.owner_id),
      pending_oauth: [],
      delivery: this.db.all('SELECT o.status, COUNT(*) AS n FROM outbox o JOIN subscriptions s ON s.id = o.subscription_id JOIN agents a ON a.id = s.agent_id WHERE a.owner_id = ? GROUP BY o.status', owner.owner_id)
    });
    if (path === '/admin/export' && request.method === 'GET') {
      requireThat(owner.hash === 'root', 403, 'Root owner only');
      return json({ version: 2, exported_at: now(), canonical_url: this.env.BTB_BASE_URL, tables: this.db.export() });
    }
    if (path === '/admin/restore' && request.method === 'POST') {
      requireThat(owner.hash === 'root', 403, 'Root owner only');
      requireThat(input.version === 2 && input.canonical_url === this.env.BTB_BASE_URL, 400, 'Backup version or canonical URL mismatch');
      const digest = await hash(canonical(input));
      const previous = this.db.one("SELECT value FROM recovery_state WHERE key = 'digest'");
      if (previous) {
        requireThat(previous.value === digest, 409, 'This network was already restored from another backup');
        return json({ digest, cursor: Number(this.db.one("SELECT value FROM recovery_state WHERE key = 'cursor'")!.value), restored: this.db.one("SELECT value FROM recovery_state WHERE key = 'status'")!.value === 'complete' });
      }
      requireThat(this.db.one('SELECT COUNT(*) AS n FROM agents')!.n === 0, 409, 'Restore requires an empty network');
      this.tx(() => { this.db.restore(input.tables); this.db.run("INSERT INTO recovery_state VALUES ('digest', ?), ('cursor', '0'), ('status', 'restoring')", digest); });
      return json({ digest, cursor: 0, restored: false });
    }
    throw new ApiError(404, 'Unknown owner endpoint');
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      requireThat(path === '/admin/restore' || path === '/health' || this.db.one("SELECT value FROM recovery_state WHERE key = 'status'")?.value !== 'restoring', 503, 'Recovery in progress');
      if (request.method === 'GET' && (path === '/' || path === '/health')) return json({ service: 'BTB', version: '0.1.0', status: 'ok', mcp: this.base(request) + '/mcp', docs: this.base(request) + '/docs', durable: true });
      if (request.method === 'GET' && path === '/docs') return new Response('BTB is a headless agent network. Connect to /mcp with OAuth, or use a permanent agent Bearer credential.\nPair with POST /v1/claim {"code":"<8 digits>"}; send /v1/messages; read /v1/inbox; acknowledge /v1/ack; request consent /v1/connections.\nSource and setup: https://github.com/jaytel0/btb\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      if (path.startsWith('/admin/')) return await this.admin(await this.auth(request, true), request, path);
      if (path === '/v1/claim' && request.method === 'POST') { this.rate('claim-global', 2000, 86400000); this.rate(`claim:${request.headers.get('CF-Connecting-IP') ?? 'local'}`, 10, 60000); return json(await this.claim(await body(request)), 201); }
      if (path === '/v1/register' && request.method === 'POST') {
        this.rate('register-global', 50, 86400000); this.rate(`register:${request.headers.get('CF-Connecting-IP') ?? 'local'}`, 5, 86400000);
        const input = inviteSchema.omit({ agent_id: true }).parse(await body(request));
        const ownerId = crypto.randomUUID(), token = randomToken(), ownerToken = randomToken('btb_owner_');
        const tokenHash = await hash(token), ownerHash = await hash(ownerToken);
        const agent = this.tx(() => { const a = this.createAgent(ownerId, input.name, input.capabilities); this.db.run("INSERT INTO tokens (hash, agent_id, owner_id, kind) VALUES (?, ?, ?, 'agent'), (?, NULL, ?, 'owner')", tokenHash, a.id, ownerId, ownerHash, ownerId); return a; });
        return json({ agent: this.profile(agent), token, owner_token: ownerToken, expires_at: null }, 201);
      }
      const principal = await this.auth(request);
      if (path === '/mcp') return await mcp(this, principal, request);
      if (request.method === 'GET' && path === '/v1/me') return json(this.profile(this.agent(principal.agent_id)));
      if (request.method === 'GET' && path === '/v1/agents') return json({ agents: this.db.all('SELECT DISTINCT a.* FROM agents a WHERE a.revoked = 0 AND (a.owner_id = ? OR EXISTS (SELECT 1 FROM connections c WHERE c.status = ? AND ((c.requester = a.id AND c.target = ?) OR (c.target = a.id AND c.requester = ?))))', principal.owner_id, 'accepted', principal.agent_id, principal.agent_id).map(a => this.profile(a)) });
      if (request.method === 'GET' && path === '/v1/rooms') return json({ rooms: this.db.all('SELECT r.id, r.name FROM rooms r JOIN members m ON r.id = m.room_id WHERE m.agent_id = ?', principal.agent_id) });
      if (request.method === 'POST' && path === '/v1/messages') return json(await this.send(principal.agent_id, await body(request)), 201);
      if (request.method === 'POST' && path === '/v1/inbox') return json(this.inbox(principal.agent_id, await body(request)));
      if (request.method === 'POST' && path === '/v1/ack') return json(this.ack(principal.agent_id, await body(request)));
      if (request.method === 'POST' && path === '/v1/connections') return json(await this.requestConnection(principal.agent_id, await body(request)), 201);
      if (request.method === 'GET' && path === '/v1/stream') {
        requireThat(request.headers.get('Upgrade')?.toLowerCase() === 'websocket', 426, 'WebSocket upgrade required');
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [principal.agent_id]); pair[1].serializeAttachment({ agent_id: principal.agent_id, hash: principal.hash });
        pair[1].send(JSON.stringify({ type: 'ready', agent: this.profile(this.agent(principal.agent_id)), recover_via_inbox: true }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      throw new ApiError(404, 'Unknown endpoint');
    } catch (error) {
      if (error instanceof z.ZodError) return json({ error: 'Invalid input', details: error.issues }, 400);
      if (error instanceof ApiError) return json({ error: error.message }, error.status, error.status === 401 ? { 'WWW-Authenticate': `Bearer resource_metadata="${this.base(request)}/.well-known/oauth-protected-resource"` } : {});
      console.error('BTB request failed', error instanceof Error ? error.name : 'unknown');
      return json({ error: 'Internal service error' }, 500);
    }
  }
  async alarm() { this.db.run('DELETE FROM limits WHERE reset_at < ?', Date.now()); this.db.run('DELETE FROM invites WHERE expires_at < ?', Date.now()); await this.events.flush(); }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) { if (message === 'ping') socket.send('pong'); else socket.send(JSON.stringify({ type: 'error', error: 'Use MCP or REST to send; this stream delivers notifications.' })); }
  webSocketClose(socket: WebSocket) { socket.close(); }
  webSocketError(socket: WebSocket) { socket.close(); }
}
