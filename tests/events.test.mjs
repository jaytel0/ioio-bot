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
  const db = new Store(sql); db.run("INSERT INTO agents (id,name,owner_id,capabilities,created_at,revoked) VALUES ('A-000-000-001', 'dot', 'home', '[]', '2026-10-07T12:00:00Z', 0)");
  let alarm;
  const hub = { grantActive: async () => false, background: promise => promise.catch(() => {}), db, agent: id => db.one('SELECT * FROM agents WHERE id = ?', id), storage: { async setAlarm(time) { alarm = time; } } };
  return { hub, db, events: new Events(hub), alarm: () => alarm, close: () => sqlite.close() };
}
const principal = { agent_id: 'A-000-000-001' };
const subscription = () => ({ name: 'ioio.message.created', arguments: { directed_only: true }, ttlMs: null, delivery: { mode: 'webhook', url: 'https://chatgpt.com/mcp-callback/test', secret: 'whsec_' + randomBytes(32).toString('base64') } });
function verifySignature(init, secret) { const id = init.headers['webhook-id'], time = init.headers['webhook-timestamp']; const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${time}.${init.body}`).digest('base64'); assert(init.headers['webhook-signature'].split(' ').includes('v1,' + expected)); assert.equal(init.redirect, 'error'); }

test('permanent event subscriptions verify callbacks and deliver signed durable events', async t => {
  const f = fixture(), input = subscription(), deliveries = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { assert.equal(url, input.delivery.url); verifySignature(init, input.delivery.secret); const value = JSON.parse(init.body); if (value.type === 'verification') return Response.json({ challenge: value.challenge }); deliveries.push(value); return new Response(null, { status: 204 }); });
  const result = await f.events.handle(principal, 'events/subscribe', input); assert.equal(result.refreshBefore, null);
  assert.deepEqual(await f.events.receivingStatus(principal.agent_id), {state:'ready',active_subscriptions:1,host_wake_required:true});
  f.db.run("INSERT INTO messages (seq,sender,target,kind,thread_id,client_message_id,mentions,hop_count,created_at) VALUES (1,'A-000-000-002','A-000-000-001','request','thread','key','[]',0,'2026-10-07T12:00:00Z')");
  f.events.enqueue(principal.agent_id, 1, 1); await f.events.schedule(); assert(f.alarm()); await f.events.flush();
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].name,'ioio.message.created'); assert.equal(deliveries[0].data.message_id, 1); assert.equal(deliveries[0].eventId, f.db.one('SELECT * FROM outbox').id); assert.equal(f.db.one('SELECT * FROM outbox').status, 'delivered');
  assert.deepEqual(await f.events.deliveryStatus(principal.agent_id,1),{state:'accepted',attempts:1,agent_wake_confirmed:false});
  assert(!JSON.stringify(await f.events.receivingStatus(principal.agent_id)).includes(input.delivery.secret));
  assert.equal((await f.events.handle(principal, 'events/subscribe', input)).id, result.id); assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n, 1);
  await f.events.handle(principal, 'events/unsubscribe', { ...input, delivery: { mode: 'webhook', url: input.delivery.url } }); assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n, 0);
  assert.equal((await f.events.deliveryStatus(principal.agent_id,1)).state,'unknown'); f.close();
});
test('failed verification does not activate a subscription', async t => { const f = fixture(); t.mock.method(globalThis, 'fetch', async () => Response.json({ challenge: 'wrong' })); await assert.rejects(() => f.events.handle(principal, 'events/subscribe', subscription()), /verification failed/); assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n, 0); f.close(); });
test('webhook retries preserve event IDs and never remove inbox messages', async t => {
  const f = fixture(), input = subscription(), eventIds = [];
  let failures = true;
  t.mock.method(globalThis, 'fetch', async (_, init) => { const value = JSON.parse(init.body); if (value.type === 'verification') return Response.json({ challenge: value.challenge }); eventIds.push(value.eventId); return new Response(null, { status: failures ? 503 : 204 }); });
  await f.events.handle(principal, 'events/subscribe', input);
  f.db.run("INSERT INTO messages (seq,sender,target,kind,thread_id,client_message_id,mentions,hop_count,created_at) VALUES (1,'BTB','A-000-000-001','connection_request','thread','key','[]',0,'2026-10-07T12:00:00Z')");
  f.db.run("INSERT INTO deliveries VALUES ('A-000-000-001',1,0,1)"); f.events.enqueue(principal.agent_id, 1, 1); await f.events.flush(); assert.equal(f.db.one('SELECT * FROM outbox').status, 'pending');
  assert.equal((await f.events.receivingStatus(principal.agent_id)).state,'retrying');
  assert.equal((await f.events.deliveryStatus(principal.agent_id,1)).state,'pending');
  failures = false; f.db.run('UPDATE outbox SET next_at = 0'); await f.events.flush(); assert.equal(eventIds[0], eventIds[1]); assert.equal(f.db.one('SELECT * FROM outbox').status, 'delivered'); assert.equal(f.db.one('SELECT * FROM deliveries').acked, 0); f.close();
});
test('directed subscriptions ignore undirected room broadcasts', async t => { const f = fixture(); t.mock.method(globalThis, 'fetch', async (_, init) => Response.json({ challenge: JSON.parse(init.body).challenge })); await f.events.handle(principal, 'events/subscribe', subscription()); f.events.enqueue(principal.agent_id, 1, 0); assert.equal(f.db.one('SELECT COUNT(*) AS n FROM outbox').n, 0); f.close(); });
test('revoked OAuth grants stop queued webhook delivery', async t => { const f = fixture(); t.mock.method(globalThis, 'fetch', async (_, init) => Response.json({ challenge: JSON.parse(init.body).challenge })); await f.events.handle({ ...principal, family: 'revoked-grant' }, 'events/subscribe', subscription()); f.events.enqueue(principal.agent_id, 1, 1); await f.events.flush(); assert.equal(f.db.one('SELECT * FROM outbox').status, 'stopped'); f.close(); });

test('enabling push wakes the receiver to catch up on unacknowledged directed messages', async t => {
  const f = fixture(), input = subscription(), runs = [];
  for (const [seq, acked, directed] of [[1,0,1],[2,0,1],[3,1,1],[4,0,0]]) {
    f.db.run("INSERT INTO messages (seq,sender,target,kind,thread_id,client_message_id,mentions,hop_count,created_at) VALUES (?,'A-000-000-002','A-000-000-001','request','thread',?,'[]',0,'2026-10-07T12:00:00Z')",seq,'key-'+seq);
    f.db.run('INSERT INTO deliveries VALUES (?,?,?,?)',principal.agent_id,seq,acked,directed);
  }
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    verifySignature(init,input.delivery.secret);
    const event = JSON.parse(init.body);
    if (event.type === 'verification') return Response.json({challenge:event.challenge});
    runs.push(event.data.message_id);
    // Receiver queues a run and processes its inbox, including older messages.
    for(const message of f.db.all('SELECT seq FROM deliveries WHERE agent_id = ? AND acked = 0 AND directed = 1',principal.agent_id)) f.db.run('UPDATE deliveries SET acked = 1 WHERE seq = ? AND agent_id = ?',message.seq,principal.agent_id);
    return new Response(null,{status:202});
  });
  await f.events.handle(principal,'events/subscribe',input); await f.events.flush();
  assert.deepEqual(runs,[2]); assert(f.alarm());
  assert.deepEqual(f.db.all('SELECT seq,acked FROM deliveries ORDER BY seq').map(d=>[d.seq,d.acked]),[[1,1],[2,1],[3,1],[4,0]]);
  assert.equal((await f.events.deliveryStatus(principal.agent_id,2)).state,'accepted');
  f.close();
});

test('push health reflects expiration, revocation, disabled adapters and permanent failure without exposing callbacks', async t => {
  const f=fixture(),input=subscription();
  t.mock.method(globalThis,'fetch',async (_,init)=>{const event=JSON.parse(init.body);return event.type==='verification'?Response.json({challenge:event.challenge}):new Response(null,{status:410});});
  const registered=await f.events.handle(principal,'events/subscribe',input);
  f.db.run("INSERT INTO messages (seq,sender,target,kind,thread_id,client_message_id,mentions,hop_count,created_at) VALUES (1,'BTB','A-000-000-001','connection_request','thread','key','[]',0,'2026-10-07T12:00:00Z')");
  f.events.enqueue(principal.agent_id,1,1);await f.events.flush();
  assert.equal((await f.events.receivingStatus(principal.agent_id)).state,'failed');
  assert.equal((await f.events.deliveryStatus(principal.agent_id,1)).state,'failed');
  f.db.run('UPDATE subscriptions SET expires_at = ? WHERE id = ?',Date.now()-1,registered.id);
  assert.equal((await f.events.receivingStatus(principal.agent_id)).active_subscriptions,0);
  f.db.run("UPDATE subscriptions SET expires_at = NULL, grant_family = 'revoked'");
  assert.equal((await f.events.receivingStatus(principal.agent_id)).active_subscriptions,0);
  f.db.run('UPDATE subscriptions SET grant_family = NULL');f.db.run('UPDATE agents SET revoked = 1');
  assert.equal((await f.events.receivingStatus(principal.agent_id)).active_subscriptions,0);
  f.db.run('UPDATE agents SET revoked = 0');f.db.run("UPDATE subscriptions SET id = 'grok_routine'");
  assert.equal((await f.events.receivingStatus(principal.agent_id)).active_subscriptions,0);
  assert(!JSON.stringify(await f.events.receivingStatus(principal.agent_id)).includes(input.delivery.url));
  f.close();
});

test('Grok adapter binds only configured OAuth identity and retries authenticated pointer deliveries', async t => {
  const f = fixture(), calls = [];
  f.hub.grokRoutine = { agentId:principal.agent_id, url:'https://api2.cursor.sh/automations/webhook/958adc3e-fa00-5e0e-b04f-a273b5c1d0e4', key:'fixture-key' };
  f.hub.grantActive = async family => family === 'user:grant';
  for (const identity of [principal, { ...principal, kind:'oauth', family:'user:grant', owner_id:'outside' }, { agent_id:'A-000-000-002', kind:'oauth', family:'user:grant', owner_id:'home' }]) f.events.bindGrokRoutine(identity);
  assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n,0);
  const identity = { ...principal, kind:'oauth', family:'user:grant', owner_id:'home' };
  f.events.bindGrokRoutine(identity); f.events.bindGrokRoutine(identity);
  assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n,1);
  assert.equal(f.db.one('SELECT event_name FROM subscriptions').event_name,'ioio.message.created');
  assert(!JSON.stringify(f.db.export()).includes('fixture-key'));
  let fail = true;
  t.mock.method(globalThis,'fetch',async (url,init) => {
    assert.equal(url,f.hub.grokRoutine.url); assert.equal(init.headers.Authorization,'Bearer fixture-key'); assert.equal(init.redirect,'error');
    calls.push(JSON.parse(init.body)); assert.equal(calls.at(-1).name,'ioio.message.created'); assert(!init.body.includes('private message'));
    return new Response(null,{status:fail ? 503 : 200});
  });
  f.db.run("INSERT INTO messages (seq,sender,target,text,kind,thread_id,client_message_id,mentions,hop_count,created_at) VALUES (1,'A-000-000-002','A-000-000-001','private message','request','thread','key','[]',0,'2026-10-07T12:00:00Z')");
  f.db.run("INSERT INTO deliveries VALUES ('A-000-000-001',1,0,1)");
  f.events.enqueue(principal.agent_id,1,1); await f.events.flush(); assert.equal(f.db.one('SELECT * FROM outbox').status,'pending');
  fail = false; f.db.run('UPDATE outbox SET next_at=0'); await f.events.flush();
  assert.equal(f.db.one('SELECT * FROM outbox').status,'delivered'); assert.equal(calls[0].eventId,calls[1].eventId); assert.equal(calls[0].data.message_id,1);
  assert.equal(f.db.one('SELECT * FROM deliveries').acked,0);
  f.hub.grantActive = async () => false;
  f.db.run("UPDATE outbox SET status='pending',next_at=0"); await f.events.flush(); assert.equal(f.db.one('SELECT * FROM outbox').status,'stopped'); assert.equal(calls.length,2);
  f.hub.grokRoutine.url='https://evil.example/automations/webhook/958adc3e-fa00-5e0e-b04f-a273b5c1d0e4';
  assert.throws(()=>f.events.bindGrokRoutine(identity),/Invalid Grok/);
  f.close();
});

// Existing hosts keep their subscribed event name while fresh hosts discover ioio.
test('legacy event subscriptions retain their name and can be replaced without duplicating delivery', async t => {
 const f=fixture(), input={...subscription(),name:'btb.message.created'}, delivered=[];
 t.mock.method(globalThis,'fetch',async (_,init)=>{const value=JSON.parse(init.body);if(value.type==='verification')return Response.json({challenge:value.challenge});delivered.push(value.name);return new Response(null,{status:204});});
 const old=await f.events.handle(principal,'events/subscribe',input);
 f.db.run("INSERT INTO messages (seq,sender,target,kind,thread_id,client_message_id,mentions,hop_count,created_at) VALUES (1,'A-000-000-002','A-000-000-001','request','thread','key','[]',0,'2026-10-07T12:00:00Z')");
 f.events.enqueue(principal.agent_id,1,1);await f.events.flush();assert.deepEqual(delivered,['btb.message.created']);
 const fresh=await f.events.handle(principal,'events/subscribe',{...input,name:'ioio.message.created'});assert.equal(fresh.id,old.id);assert.equal(f.db.one('SELECT COUNT(*) AS n FROM subscriptions').n,1);f.close();
});
