import { z } from 'zod';
import type { BtbHub } from './hub';
import { ApiError, equal, eventDefinition, eventName, hash, randomToken, requireThat, type Row } from './shared';

const subscriptionSchema = z.object({
  name: z.enum([eventName, 'btb.message.created']), arguments: z.object({ directed_only: z.boolean().default(false) }).strict().default({ directed_only: false }),
  delivery: z.object({ mode: z.literal('webhook'), url: z.string().url(), secret: z.string().optional() }).strict(),
  ttlMs: z.number().int().min(60000).max(31536000000).nullable().optional(), cursor: z.null().optional()
}).strict();

export class Events {
  private flushing?: Promise<void>;
  constructor(private hub: BtbHub) {}
  private routineURL(value: string) {
    const url = new URL(value);
    requireThat(url.protocol === 'https:' && url.hostname === 'api2.cursor.sh' && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/automations\/webhook\/[a-f0-9-]{36}$/.test(url.pathname), 503, 'Invalid Grok routine configuration');
    return value;
  }
  bindGrokRoutine(principal: Row) {
    const routine = this.hub.grokRoutine;
    // Only the operator-configured agent's authenticated OAuth grant can bind this
    // provider adapter. Clients cannot supply destinations or provider secrets.
    if (!routine || principal.kind !== 'oauth' || !principal.family || principal.agent_id !== routine.agentId || principal.owner_id !== 'home') return;
    this.routineURL(routine.url);
    this.hub.db.run("INSERT INTO subscriptions (id,agent_id,callback_url,grant_family,secret,directed_only,expires_at,event_name) VALUES ('grok_routine',?,?,?,'',1,NULL,?) ON CONFLICT(id) DO UPDATE SET callback_url=excluded.callback_url,grant_family=excluded.grant_family,event_name=excluded.event_name", routine.agentId, routine.url, principal.family, eventName);
  }
  private validateCallback(uri: string) {
    const url = new URL(uri);
    // Exact operator-controlled hostname allowlist avoids arbitrary outbound fetches.
    // Never accept wildcard hosts, IP literals, userinfo, redirects, or custom ports.
    requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') && Boolean(this.hub.db.one('SELECT 1 FROM webhook_hosts WHERE host = ?', url.hostname)), 400, 'Callback hostname must be explicitly allowed by the ioio owner');
    return url;
  }
  private key(secret: string) {
    requireThat(secret.startsWith('whsec_'), 400, 'Standard Webhooks secret required');
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(secret.slice(6)), c => c.charCodeAt(0)); } catch { throw new ApiError(400, 'Invalid webhook signing key'); }
    requireThat(bytes.length >= 24 && bytes.length <= 64, 400, 'Webhook key must be 24–64 bytes');
    return bytes;
  }
  private async signature(secret: string, eventId: string, timestamp: string, text: string) {
    const key = await crypto.subtle.importKey('raw', this.key(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${eventId}.${timestamp}.${text}`)));
    return 'v1,' + btoa(String.fromCharCode(...signature));
  }
  private async post(subscription: Row, eventId: string, value: Row) {
    if (subscription.id === 'grok_routine') {
      const routine = this.hub.grokRoutine;
      requireThat(routine && routine.agentId === subscription.agent_id && routine.url === subscription.callback_url, 503, 'Grok routine disabled');
      this.routineURL(routine.url);
      return fetch(routine.url, { method:'POST', redirect:'manual', signal:AbortSignal.timeout(10000), headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+routine.key, 'Idempotency-Key':eventId }, body:JSON.stringify(value) });
    }
    this.validateCallback(subscription.callback_url);
    const text = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000));
    let signature = await this.signature(subscription.secret, eventId, timestamp, text);
    if (subscription.old_secret && subscription.rotate_until > Date.now()) signature += ' ' + await this.signature(subscription.old_secret, eventId, timestamp, text);
    return fetch(subscription.callback_url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': timestamp, 'webhook-signature': signature, 'X-MCP-Subscription-Id': subscription.id }, body: text });
  }
  async handle(principal: Row, method: string, params: Row) {
    if (method === 'events/list') return { events: [eventDefinition] };
    const input = subscriptionSchema.parse(params);
    this.validateCallback(input.delivery.url);
    const id = 'sub_' + await hash(JSON.stringify([principal.agent_id, input.delivery.url, 'btb.message.created', input.arguments.directed_only]));
    if (method === 'events/unsubscribe') { this.hub.db.run('DELETE FROM subscriptions WHERE id = ? AND agent_id = ?', id, principal.agent_id); return {}; }
    requireThat(method === 'events/subscribe', 400, 'Unknown event method');
    requireThat(input.delivery.secret, 400, 'Signing secret required'); this.key(input.delivery.secret);
    const existing = this.hub.db.one('SELECT * FROM subscriptions WHERE id = ?', id);
    requireThat(existing || this.hub.db.one('SELECT COUNT(*) AS n FROM subscriptions WHERE agent_id = ?', principal.agent_id)!.n < 5, 400, 'Subscription limit reached');
    const subscription: Row = { id, agent_id: principal.agent_id, callback_url: input.delivery.url, grant_family: principal.family ?? null, secret: input.delivery.secret };
    const challenge = randomToken('challenge_');
    try {
      const verification = await this.post(subscription, randomToken('verification_'), { type: 'verification', challenge });
      requireThat(verification.ok, 502, 'Webhook callback verification failed');
      const response = await verification.json() as Row;
      requireThat(typeof response.challenge === 'string' && equal(response.challenge, challenge), 502, 'Webhook callback challenge mismatch');
    } catch { throw new ApiError(502, 'Webhook callback verification failed; no subscription activated'); }
    // Requests explicitly asking for ttlMs:null receive a permanent subscription.
    // Finite subscriptions refresh automatically through the MCP event protocol.
    const expires = input.ttlMs === null ? null : Date.now() + (input.ttlMs ?? 31536000000);
    const rotate = existing && existing.secret !== subscription.secret;
    this.hub.db.run('INSERT OR REPLACE INTO subscriptions (id, agent_id, callback_url, grant_family, secret, old_secret, rotate_until, directed_only, expires_at, event_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, principal.agent_id, input.delivery.url, subscription.grant_family, subscription.secret, rotate ? existing.secret : existing?.old_secret ?? null, rotate ? Date.now() + 60000 : existing?.rotate_until ?? null, +input.arguments.directed_only, expires, input.name);
    // One pointer wakes the host to drain its durable inbox, including messages
    // that arrived before receiving was configured. Avoid a wake per old item.
    const backlog = this.hub.db.one('SELECT seq, directed FROM deliveries WHERE agent_id = ? AND acked = 0 AND (? = 0 OR directed = 1) ORDER BY seq DESC LIMIT 1', principal.agent_id, +input.arguments.directed_only);
    if (backlog) {
      this.hub.db.run('INSERT OR IGNORE INTO outbox (id, subscription_id, seq, next_at) VALUES (?, ?, ?, ?)', `evt_${id}_${backlog.seq}`, id, backlog.seq, Date.now());
      await this.schedule();
      this.hub.background(this.flush());
    }
    return { id, refreshBefore: expires === null ? null : new Date(expires).toISOString(), cursor: null, truncated: false };
  }
  private async activeSubscriptions(agentId: string) {
    if (this.hub.agent(agentId).revoked) return [];
    const subscriptions = this.hub.db.all('SELECT * FROM subscriptions WHERE agent_id = ? AND (expires_at IS NULL OR expires_at > ?)', agentId, Date.now());
    const active: Row[] = [];
    for (const sub of subscriptions) {
      if (sub.grant_family && !await this.hub.grantActive(sub.grant_family)) continue;
      try {
        if (sub.id === 'grok_routine') {
          const routine = this.hub.grokRoutine;
          if (!routine || routine.agentId !== agentId || routine.url !== sub.callback_url) continue;
          this.routineURL(routine.url);
        } else this.validateCallback(sub.callback_url);
      } catch { continue; }
      active.push(sub);
    }
    return active;
  }
  async receivingStatus(agentId: string) {
    const active = await this.activeSubscriptions(agentId);
    const latest = active.map(sub => this.hub.db.one('SELECT status, attempts FROM outbox WHERE subscription_id = ? ORDER BY seq DESC LIMIT 1', sub.id)).filter(Boolean);
    const state = active.length === 0 ? 'not_configured' : latest.some(item => item!.status === 'failed' || item!.status === 'stopped') ? 'failed' : latest.some(item => item!.status === 'pending' && item!.attempts > 0) ? 'retrying' : 'ready';
    return { state, active_subscriptions: active.length, host_wake_required: true };
  }
  async deliveryStatus(agentId: string, seq: number) {
    const active = await this.activeSubscriptions(agentId);
    const attempts = this.hub.db.all('SELECT o.subscription_id, o.status, o.attempts FROM outbox o JOIN subscriptions s ON s.id = o.subscription_id WHERE s.agent_id = ? AND o.seq = ?', agentId, seq);
    // Revocation/unsubscribe deletes the callback binding. Orphaned historical
    // rows cannot safely be attributed to a room recipient; report uncertainty.
    const missingHistory = Boolean(this.hub.db.one('SELECT 1 FROM outbox o WHERE o.seq = ? AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = o.subscription_id)', seq));
    // "Accepted" is an HTTP success from a receiver, not a model-run receipt.
    const state = attempts.some(item => item.status === 'delivered') ? 'accepted' : attempts.some(item => item.status === 'pending' && active.some(sub => sub.id === item.subscription_id)) ? 'pending' : attempts.some(item => item.status === 'failed') ? 'failed' : attempts.length ? 'stopped' : missingHistory ? 'unknown' : 'not_requested';
    return { state, attempts: attempts.reduce((n, item) => n + item.attempts, 0), agent_wake_confirmed: false };
  }
  enqueue(agentId: string, seq: number, directed: number) {
    const subs = this.hub.db.all('SELECT * FROM subscriptions WHERE agent_id = ? AND (expires_at IS NULL OR expires_at > ?) AND (directed_only = 0 OR ? = 1)', agentId, Date.now(), directed);
    for (const sub of subs) this.hub.db.run('INSERT OR IGNORE INTO outbox (id, subscription_id, seq, next_at) VALUES (?, ?, ?, ?)', `evt_${sub.id}_${seq}`, sub.id, seq, Date.now());
  }
  async schedule() {
    const pending = this.hub.db.one("SELECT MIN(next_at) AS time FROM outbox WHERE status = 'pending'");
    if (pending?.time !== null && pending?.time !== undefined) await this.hub.storage.setAlarm(Math.max(Date.now() + 100, pending.time));
  }
  flush() {
    if (!this.flushing) this.flushing = this.deliver().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async deliver() {
    const pending = this.hub.db.all("SELECT * FROM outbox WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 20", Date.now());
    for (const item of pending) {
      const sub = this.hub.db.one('SELECT * FROM subscriptions WHERE id = ?', item.subscription_id);
      if (sub && this.hub.db.one('SELECT acked FROM deliveries WHERE agent_id = ? AND seq = ?', sub.agent_id, item.seq)?.acked) {
        this.hub.db.run("UPDATE outbox SET status = 'stopped' WHERE id = ?", item.id);
        continue;
      }
      const grantValid = !sub?.grant_family || await this.hub.grantActive(sub.grant_family);
      if (!sub || !grantValid || this.hub.agent(sub.agent_id).revoked || (sub.id === 'grok_routine' && !this.hub.grokRoutine) || (sub.expires_at && sub.expires_at <= Date.now())) { this.hub.db.run("UPDATE outbox SET status = 'stopped' WHERE id = ?", item.id); continue; }
      const message = this.hub.db.one('SELECT kind, created_at FROM messages WHERE seq = ?', item.seq)!;
      let status = 0;
      try { status = (await this.post(sub, item.id, { eventId: item.id, name: sub.event_name ?? 'btb.message.created', timestamp: message.created_at, data: { agent_id: sub.agent_id, message_id: item.seq, kind: message.kind }, cursor: null })).status; } catch (error) {
        // Fixed categories only: runtime messages can contain callback URLs or credentials.
        const description = error instanceof Error ? error.message : '';
        console.warn(JSON.stringify({ type: 'push_transport_failure', adapter: sub.id === 'grok_routine' ? 'native' : 'standard', reason: /Invalid Grok|disabled/.test(description) ? 'configuration' : /redirect/i.test(description) ? 'redirect' : /dns|resolve/i.test(description) ? 'dns' : /certificate|tls|ssl/i.test(description) ? 'tls' : /header/i.test(description) ? 'header' : /timeout|abort/i.test(description) ? 'timeout' : 'transport' }));
      }
      const attempts = item.attempts + 1;
      const state = status >= 200 && status < 300 ? 'delivered' : status === 410 || status === 413 || attempts >= 12 ? 'failed' : 'pending';
      this.hub.db.run('UPDATE outbox SET status = ?, attempts = ?, last_status = ?, next_at = ? WHERE id = ?', state, attempts, status, Date.now() + Math.min(3600000, 1000 * 2 ** attempts), item.id);
    }
    await this.schedule();
  }
}
