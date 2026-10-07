import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'btb-events-'));
let Events, Store;
before(async () => { const output = join(directory, 'events.mjs'); await build({ stdin: { contents: "export { Events } from './src/events'; export { Store } from './src/store';", resolveDir: process.cwd() }, outfile: output, bundle: true, platform: 'node', format: 'esm' }); ({ Events, Store } = await import(output)); });
after(async () => { await rm(directory, { recursive: true, force: true }); });
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const sql = { exec(query, ...params) { if (!params.length && query.includes(';')) { sqlite.exec(query); return { toArray: () => [] }; } const statement = sqlite.prepare(query); let values = []; if (statement.columns().length) values = statement.all(...params); else statement.run(...params); return { toArray: () => values }; } };
  const db = new Store(sql); db.run("INSERT INTO agents VALUES ('A-000-000-001', 'dot', 'home', '[]', '2026-10-07T12:00:00Z', 0)");
  let alarm;
  const hub = { db, agent: id => db.one('SELECT * FROM agents WHERE id = ?', id), storage: { async setAlarm(time) { alarm = time; } } };
  return { db, events: new Events(hub), alarm: () => alarm, close: () => sqlite.close() };
}
const principal = { agent_id: 'A-000-000-001' };
const subscription = () => ({ name: 'btb.message.created', arguments: { directed_only: true }, ttlMs: null, delivery: { mode: 'webhook', url: 'https://chatgpt.com/mcp-callback/test', secret: 'whsec_' + randomBytes(32).toString('base64') } });
function verifySignature(init, secret) { const id = init.headers['webhook-id'], time = init.headers['webhook-timestamp']; const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${time}.${init.body}`).digest('base64'); assert(init.headers['webhook-signature'].split(' ').includes('v1,' + expected)); assert.equal(init.redirect, 'error'); }

test('permanent event subscriptions verify callbacks and deliver signed durable events', async t => {
  const f = fixture(), input = subscription(), deliveries = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { assert.equal(url, input.delivery.url); verifySignature(init, input.delivery.secret); const value = JSON.parse(init.body); if (value.type === 'verification') return Response.json({ challenge: value.challenge }); deliveries.push(value); return new Response(null, { status: 204 }); });
  const result = await f.events.handle(principal, 'events/subscribe', input); assert.equal(result.refreshBefore, null);
  f.db.run("INSERT INTO messages (seq,sender,target,kind,thread_id,client_message_id,mentions,hop_count,created_at) VALUES (1,'A-000-000-002','A-000-000-001','request','thread','key','[]',0,'2026-10-07T12:00:00Z')");
  f.events.enqueue(principal.agent_id, 1, 1); await f.events.schedule(); assert(f.alarm()); await f.events.flush();
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].data.message_id, 1); assert.equal(deliveries[0].eventId, f.db.one('SELECT * FROM outbox').id); assert.equal(f.db.one('SELECT * FROM outbox').status, 'delivered');
  assert.equal((await f.events.handle(principal, 'events/subscribe', input)).id, result.id); assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n, 1);
  await f.events.handle(principal, 'events/unsubscribe', { ...input, delivery: { mode: 'webhook', url: input.delivery.url } }); assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n, 0); f.close();
});
test('failed verification does not activate a subscription', async t => { const f = fixture(); t.mock.method(globalThis, 'fetch', async () => Response.json({ challenge: 'wrong' })); await assert.rejects(() => f.events.handle(principal, 'events/subscribe', subscription()), /verification failed/); assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n, 0); f.close(); });
test('webhook retries preserve event IDs and never remove inbox messages', async t => {
  const f = fixture(), input = subscription(), eventIds = [];
  let failures = true;
  t.mock.method(globalThis, 'fetch', async (_, init) => { const value = JSON.parse(init.body); if (value.type === 'verification') return Response.json({ challenge: value.challenge }); eventIds.push(value.eventId); return new Response(null, { status: failures ? 503 : 204 }); });
  await f.events.handle(principal, 'events/subscribe', input);
  f.db.run("INSERT INTO messages (seq,sender,target,kind,thread_id,client_message_id,mentions,hop_count,created_at) VALUES (1,'BTB','A-000-000-001','connection_request','thread','key','[]',0,'2026-10-07T12:00:00Z')");
  f.db.run("INSERT INTO deliveries VALUES ('A-000-000-001',1,0,1)"); f.events.enqueue(principal.agent_id, 1, 1); await f.events.flush(); assert.equal(f.db.one('SELECT * FROM outbox').status, 'pending');
  failures = false; f.db.run('UPDATE outbox SET next_at = 0'); await f.events.flush(); assert.equal(eventIds[0], eventIds[1]); assert.equal(f.db.one('SELECT * FROM outbox').status, 'delivered'); assert.equal(f.db.one('SELECT * FROM deliveries').acked, 0); f.close();
});
test('directed subscriptions ignore undirected room broadcasts', async t => { const f = fixture(); t.mock.method(globalThis, 'fetch', async (_, init) => Response.json({ challenge: JSON.parse(init.body).challenge })); await f.events.handle(principal, 'events/subscribe', subscription()); f.events.enqueue(principal.agent_id, 1, 0); assert.equal(f.db.one('SELECT COUNT(*) AS n FROM outbox').n, 0); f.close(); });
test('revoked OAuth grants stop queued webhook delivery', async t => { const f = fixture(); t.mock.method(globalThis, 'fetch', async (_, init) => Response.json({ challenge: JSON.parse(init.body).challenge })); await f.events.handle({ ...principal, family: 'revoked-grant' }, 'events/subscribe', subscription()); f.events.enqueue(principal.agent_id, 1, 1); await f.events.flush(); assert.equal(f.db.one('SELECT * FROM outbox').status, 'stopped'); f.close(); });
