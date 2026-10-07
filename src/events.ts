import { z } from 'zod';
import type { BtbHub } from './hub';
import { ApiError, equal, eventDefinition, eventName, hash, randomToken, requireThat, type Row } from './shared';

const subscriptionSchema = z.object({
  name: z.literal(eventName), arguments: z.object({ directed_only: z.boolean().default(false) }).strict().default({ directed_only: false }),
  delivery: z.object({ mode: z.literal('webhook'), url: z.string().url(), secret: z.string().optional() }).strict(),
  ttlMs: z.number().int().min(60000).max(31536000000).nullable().optional(), cursor: z.null().optional()
}).strict();

export class Events {
  private flushing?: Promise<void>;
  constructor(private hub: BtbHub) {}
  private validateCallback(uri: string) {
    const url = new URL(uri);
    // Exact operator-controlled hostname allowlist avoids arbitrary outbound fetches.
    // Never accept wildcard hosts, IP literals, userinfo, redirects, or custom ports.
    requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') && Boolean(this.hub.db.one('SELECT 1 FROM webhook_hosts WHERE host = ?', url.hostname)), 400, 'Callback hostname must be explicitly allowed by the BTB owner');
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
    const id = 'sub_' + await hash(JSON.stringify([principal.agent_id, input.delivery.url, input.name, input.arguments.directed_only]));
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
    this.hub.db.run('INSERT OR REPLACE INTO subscriptions (id, agent_id, callback_url, grant_family, secret, old_secret, rotate_until, directed_only, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, principal.agent_id, input.delivery.url, subscription.grant_family, subscription.secret, rotate ? existing.secret : existing?.old_secret ?? null, rotate ? Date.now() + 60000 : existing?.rotate_until ?? null, +input.arguments.directed_only, expires);
    return { id, refreshBefore: expires === null ? null : new Date(expires).toISOString(), cursor: null, truncated: false };
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
      const grantValid = !sub?.grant_family || Boolean(this.hub.db.one('SELECT 1 FROM tokens WHERE family = ?', sub.grant_family));
      if (!sub || !grantValid || this.hub.agent(sub.agent_id).revoked || (sub.expires_at && sub.expires_at <= Date.now())) { this.hub.db.run("UPDATE outbox SET status = 'stopped' WHERE id = ?", item.id); continue; }
      const message = this.hub.db.one('SELECT kind, created_at FROM messages WHERE seq = ?', item.seq)!;
      let status = 0;
      try { status = (await this.post(sub, item.id, { eventId: item.id, name: eventName, timestamp: message.created_at, data: { agent_id: sub.agent_id, message_id: item.seq, kind: message.kind }, cursor: null })).status; } catch { /* Durable retry below. No message or credentials enter logs. */ }
      const attempts = item.attempts + 1;
      const state = status >= 200 && status < 300 ? 'delivered' : status === 410 || status === 413 || attempts >= 12 ? 'failed' : 'pending';
      this.hub.db.run('UPDATE outbox SET status = ?, attempts = ?, last_status = ?, next_at = ? WHERE id = ?', state, attempts, status, Date.now() + Math.min(3600000, 1000 * 2 ** attempts), item.id);
    }
    await this.schedule();
  }
}
