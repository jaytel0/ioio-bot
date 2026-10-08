import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import WebSocket from 'ws';
import { build } from 'esbuild';
import { createIdentity, fingerprint, trustPeer, trustRoom, keyRegistration, encryptMessage, decryptResult } from '../bin/e2ee.mjs';

const base = 'http://127.0.0.1:8798', admin = 'integration-owner', directory = await mkdtemp(join(tmpdir(), 'btb-test-'));
let worker, logs = '', dot, grok, muse, guest, sent;
const endpointKeys = new Map(), tokenAgents = new Map(), outgoing = new Map();
const configFile = join(directory, 'wrangler.json');
const fixtureFile = join(directory, 'entry.ts');
async function start() {
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8798', '--inspector-port', '0', '--config', configFile, '--persist-to', join(directory, 'storage')], { detached: true, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', x => { logs = (logs + x).slice(-16000); }); worker.stderr.on('data', x => { logs = (logs + x).slice(-16000); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { try { if ((await fetch(base + '/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Worker did not start: ' + logs);
}
async function stop() { if (worker?.pid) { const exited = once(worker, 'exit'); process.kill(-worker.pid, 'SIGTERM'); await exited; worker = undefined; } }
async function api(path, input, token = admin, expected = 200) {
  let original = input;
  if (path === '/v1/messages' && input && !input.encrypted) {
    const selfId = tokenAgents.get(token) ?? (await api('/v1/me', undefined, token)).id;
    const sender = await testIdentity(selfId);
    let recipients;
    if (input.to) recipients = [input.to];
    else recipients = ((await api('/v1/rooms', undefined, token)).rooms.find(room => room.id === input.room)?.participants ?? [{ id: dot.agent.id }]).map(agent => agent.id).filter(id => id !== selfId);
    const peers = [];
    for (const id of recipients) { const identity = await testIdentity(id); trustPeer(sender,id,identity.public_key,fingerprint(identity.public_key)); peers.push({id,encryption_key:identity.public_key}); }
    if(input.room) { for(const id of [...recipients,selfId]) { const identity=endpointKeys.get(id); for(const member of [...recipients,selfId]) { const peer=endpointKeys.get(member); trustPeer(identity,member,peer.public_key,fingerprint(peer.public_key)); } trustRoom(identity,input.room,[...recipients,selfId],id); } } // fixture explicitly approves its known test-only membership
    const route = {...input};
    if (route.reply_to) { const parent = await api('/v1/messages/'+route.reply_to,undefined,token); route.thread_id ??= parent.thread_id; route.hop_count = parent.hop_count+1; }
    const canonical = value => Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : value && typeof value==='object' ? '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}' : JSON.stringify(value);
    const cacheKey = selfId+':'+input.client_message_id, cached = outgoing.get(cacheKey);
    if (cached && cached.input === canonical(input)) input = cached.envelope;
    else { input=encryptMessage(sender,base,selfId,route,peers); if(!cached) outgoing.set(cacheKey,{input:canonical(original),envelope:input}); }
  }
  const r = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
  const text = await r.text(); let result = text ? JSON.parse(text) : {}; assert.equal(r.status, expected, JSON.stringify(result));
  if (result.token && result.agent && !path.startsWith('/__test/recovered')) { tokenAgents.set(result.token,result.agent.id); await testIdentity(result.agent.id); }
  const selfId = tokenAgents.get(token);
  if (selfId && r.ok && (result.from || result.messages)) {
    const identity=await testIdentity(selfId);
    for(const message of result.messages??(result.from?[result]:[])) { const peer=endpointKeys.get(message.from); if(peer) trustPeer(identity,message.from,peer.public_key,fingerprint(peer.public_key)); }
    result=decryptResult(identity,base,selfId,result);
  }
  return result;
}
async function testIdentity(id) {
  if (endpointKeys.has(id)) return endpointKeys.get(id);
  const identity=createIdentity(); endpointKeys.set(id,identity);
  const response=await fetch(base+'/__test/key',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+admin},body:JSON.stringify({id,...keyRegistration(identity,base,id)})});
  assert.equal(response.status,200); return identity;
}
async function enroll(name) { const inv = await api('/admin/invites', { name }, admin, 201); const agent = await api('/v1/claim', { code: inv.code }, '', 201); assert.equal(agent.expires_at, null); return agent; }
async function client(token, modern = false) {
  const c = new Client({ name: 'btb-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return c;
}
before(async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  delete config.routes;
  config.kv_namespaces.push({binding:'RECOVERY_KV',id:'00000000000000000000000000000001'});
  config.main = fixtureFile; config.vars = { BTB_BASE_URL: base, BTB_ADMIN_TOKEN: admin, BTB_INTERNAL_SECRET: 'integration-internal', BTB_OWNER_EMAIL: 'owner@example.com', GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret', BACKUP_ENCRYPTION_KEY: '01'.repeat(32), BTB_REQUEST_LIMIT:'2000', BTB_AUTH_LIMIT:'200' };
  config.ratelimits[0].namespace_id = '61601'; config.ratelimits[1].namespace_id = '61602';
  config.ratelimits[0].simple.limit = 2000; config.ratelimits[1].simple.limit = 200;
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(fixtureFile, `
import application, { BtbHub, BtbRequestGate, serve } from '${process.cwd()}/src/index';
import { oauthHelpers } from '${process.cwd()}/src/oauth';
import { restoreBackup } from '${process.cwd()}/src/recovery';
import { hash } from '${process.cwd()}/src/shared';
export { BtbHub, BtbRequestGate };
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__test/')) {
    if (url.pathname !== '/__test/recovered' && request.headers.get('Authorization') !== 'Bearer integration-owner') return Response.json({}, {status:403});
    const hub = env.HUB.get(env.HUB.idFromName('btb-hub-v1'));
    if (url.pathname === '/__test/origin') return serve(new Request(url.searchParams.get('origin') + '/.well-known/oauth-protected-resource/mcp'), {...env,BTB_COMPAT_ORIGINS:'https://legacy.example'},ctx);
    if (url.pathname === '/__test/https') { const result = await serve(new Request('http://ioio.example/setup?from=test'), {...env,BTB_BASE_URL:'https://ioio.example'},ctx); return Response.json({status:result.status,location:result.headers.get('Location')}); }
    if (url.pathname === '/__test/complete') {
      const parsed = await oauthHelpers(env).parseAuthRequest(new Request(env.BTB_BASE_URL + '/oauth/authorize' + url.search));
      const agent = (await hub.ownerAgents('home')).find(a => a.id === url.searchParams.get('agent_id'));
      if (!agent) return Response.json({}, {status:403});
      return Response.json(await oauthHelpers(env).completeAuthorization({request:parsed,userId:'fixture-user',scope:['btb'],metadata:{agent_id:agent.id},props:{agent_id:agent.id,owner_id:'home',userId:'fixture-user'},revokeExistingGrants:false}));
    }
    if (url.pathname === '/__test/owner-session') { const owner=await hub.googleOwner('portal-fixture','portal@example.com');const token=crypto.randomUUID(),csrf=crypto.randomUUID();await env.OAUTH_KV.put('owner-session:'+await hash(token),JSON.stringify({...owner,csrf,expires_at:Date.now()+60000}));return Response.json({token,csrf}); }
    if (url.pathname === '/__test/selection-session') {
      const parsed = await oauthHelpers(env).parseAuthRequest(new Request(env.BTB_BASE_URL + '/oauth/authorize' + url.search));
      const owner = await hub.googleOwner('selection-fixture','selection@example.com');
      const token = crypto.randomUUID(), csrf = crypto.randomUUID(), handle = crypto.randomUUID();
      await env.OAUTH_KV.put('owner-session:' + await hash(token), JSON.stringify({...owner,csrf,expires_at:Date.now()+60000}));
      await env.OAUTH_KV.put('agent-selection:' + await hash(handle), JSON.stringify({request:parsed,owner_id:owner.owner_id,subject:owner.subject}));
      return Response.json({token,csrf,handle});
    }
    if (url.pathname === '/__test/google-owner') { const input = await request.json(); return Response.json(await hub.googleOwner(input.subject,input.email)); }
    if (url.pathname === '/__test/key') { const {id,...input}=await request.json(); return Response.json(await hub.registerEncryptionKey(id,input)); }
    if (url.pathname === '/__test/strict-gate') { const gate=env.REQUEST_GATES.get(env.REQUEST_GATES.idFromName('strict-fixture')); return Response.json(await Promise.all([gate.consume(true,{requests:2,auth:2}),gate.consume(true,{requests:2,auth:2}),gate.consume(true,{requests:2,auth:2})])); }
    if (url.pathname === '/__test/edge-deny') return serve(new Request(env.BTB_BASE_URL+'/v1/me'), {...env,EDGE_RATE_LIMITER:{limit:async()=>({success:false})},HUB:{get:()=>{throw new Error('Database reached')}}},ctx);
    if (url.pathname === '/__test/restore') return restoreBackup({...env,OAUTH_KV:env.RECOVERY_KV,HUB:{idFromName:()=>env.HUB.idFromName('restore-fixture'),get:id=>env.HUB.get(id)}},await request.json());
    if (url.pathname === '/__test/recovered') return env.HUB.get(env.HUB.idFromName('restore-fixture')).fetch(new Request(env.BTB_BASE_URL+url.searchParams.get('path'),{method:request.method,headers:request.headers,body:request.method==='GET'?undefined:await request.text()}));
  }
  return application.fetch(request,env,ctx);
}};`);
  await start(); dot = await enroll('dot'); grok = await enroll('grokbot'); muse = await enroll('muse'); guest = await api('/v1/register', { name: 'outside' }, '', 201); });
after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });

test('unpaired users cannot read private messages or use tools', async () => { await api('/v1/me', undefined, '', 401); await api('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '', 401); });
test('domain migration keeps explicitly supported OAuth issuers isolated and rejects unknown hosts', async () => {
  const current = await api('/.well-known/oauth-protected-resource/mcp');
  assert.equal(current.resource, base + '/mcp');
  const legacy = await api('/__test/origin?origin=' + encodeURIComponent('https://legacy.example'));
  assert.equal(legacy.resource, 'https://legacy.example/mcp');
  assert.deepEqual(legacy.authorization_servers, ['https://legacy.example']);
  await api('/__test/origin?origin=' + encodeURIComponent('https://attacker.example'), undefined, admin, 421);
  assert.equal((await api('/.well-known/oauth-protected-resource/mcp')).resource, base + '/mcp');
  assert.deepEqual(await api('/__test/https'), {status:308,location:'https://ioio.example/setup?from=test'});
});
test('bot credentials cannot administer the network', async () => { await api('/admin/invites', { name: 'bad' }, dot.token, 403); await api('/v1/me', undefined, admin, 403); });
test('pairing codes can be consumed only once, including concurrent requests', async () => { const inv = await api('/admin/invites', { name: 'one-time' }, admin, 201); const attempts = await Promise.all([0, 1].map(() => fetch(base + '/v1/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: inv.code }) }))); assert.deepEqual(attempts.map(r => r.status).sort(), [201, 400]); });
test('preassigned agent numbers survive pairing and subsequent credentials', async () => { const a = await api('/admin/agents', { name: 'instinct' }, admin, 201); const inv = await api('/admin/invites', { name: 'instinct', agent_id: a.id }, admin, 201); const enrolled = await api('/v1/claim', { code: inv.code }, '', 201); assert.equal(enrolled.agent.id, a.id); assert.match(a.id, /^A-\d{3}-\d{3}-\d{3}$/); });
test('temporary enrollment expires across REST and MCP while preserving the agent number', async () => {
  const a = await api('/admin/agents', { name: 'temporary-instinct' }, admin, 201);
  for (const credential_ttl_seconds of [0, -1, 86401, 1.5]) await api('/admin/invites', { name: a.name, agent_id: a.id, credential_ttl_seconds }, admin, 400);
  const inv = await api('/admin/invites', { name: a.name, agent_id: a.id, credential_ttl_seconds: 1 }, admin, 201);
  assert.equal(inv.credential_expires, true);
  const enrollment = await api('/v1/claim', { code: inv.code }, '', 201);
  assert.equal(enrollment.agent.id, a.id);
  assert(Date.parse(enrollment.expires_at) > Date.now());
  assert.equal((await api('/v1/me', undefined, enrollment.token)).id, a.id);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(enrollment.expires_at) - Date.now()) + 50));
  await api('/v1/inbox', {}, enrollment.token, 401);
  await api('/mcp', { jsonrpc:'2.0', id:1, method:'tools/list' }, enrollment.token, 401);
  const another = await api('/admin/invites', { name:a.name, agent_id:a.id, credential_ttl_seconds:3600 }, admin, 201);
  const renewed = await api('/v1/claim', { code:another.code }, '', 201);
  assert.equal(renewed.agent.id, a.id);
  assert.equal((await api('/v1/me', undefined, renewed.token)).id, a.id);
});
test('agent tokens stored only as hashes', async () => { const backup = await api('/admin/export'); assert(!JSON.stringify(backup).includes(dot.token)); assert(!JSON.stringify(backup).includes(guest.owner_token)); });
test('guests cannot discover private agents or rooms', async () => { const list = await api('/v1/agents', undefined, guest.token); assert.deepEqual(list.agents.map(a => a.id), [guest.agent.id]); assert.deepEqual((await api('/v1/rooms', undefined, guest.token)).rooms, []); });
test('direct messages preserve structured values exactly and stay private', async () => { sent = await api('/v1/messages', { to: grok.agent.id, data: { slots: ['2026-10-08T18:00:00-04:00'], cost: 0, available: false }, client_message_id: 'direct-once' }, dot.token, 201); const inbox = await api('/v1/inbox', {}, grok.token); assert.deepEqual(inbox.messages[0].data, { slots: ['2026-10-08T18:00:00-04:00'], cost: 0, available: false }); assert.equal((await api('/v1/inbox', {}, muse.token)).messages.length, 0); });
test('raw REST and remote MCP reject plaintext; transport, exports and logs reveal no content', async () => {
  const privateText='privacy fixture: message content must stay endpoint-only';
  const raw=await fetch(base+'/v1/messages',{method:'POST',headers:{Authorization:'Bearer '+dot.token,'Content-Type':'application/json'},body:JSON.stringify({to:grok.agent.id,text:privateText,client_message_id:randomUUID()})});
  assert.equal(raw.status,400); assert(!(await raw.text()).includes(privateText));
  const c=await client(dot.token);
  try { const failed=await c.callTool({name:'ioio_send',arguments:{to:grok.agent.id,text:privateText,client_message_id:randomUUID()}}); assert.equal(failed.isError,true); assert(!JSON.stringify(failed).includes(privateText)); } finally { await c.close(); }
  const note=await fetch(base+'/v1/connections',{method:'POST',headers:{Authorization:'Bearer '+guest.token,'Content-Type':'application/json'},body:JSON.stringify({to:grok.agent.id,reason:privateText})}); assert.equal(note.status,400);
  const delivered=await api('/v1/messages',{to:grok.agent.id,text:privateText,client_message_id:randomUUID()},dot.token,201);
  const response=await fetch(base+'/v1/inbox',{method:'POST',headers:{Authorization:'Bearer '+grok.token,'Content-Type':'application/json'},body:'{}'}),wire=await response.json();
  const message=wire.messages.find(item=>item.id===delivered.id); assert(message.encrypted); assert.equal(message.text,null); assert.equal(message.data,null);
  assert(!JSON.stringify(wire).includes(privateText)); assert.deepEqual(Object.keys(message.encrypted.recipients),[grok.agent.id]);
  const exported=await api('/admin/export'); assert(exported.tables.messages.every(item=>item.text===null&&item.data===null)); assert(!JSON.stringify(exported).includes(privateText));
  assert(!logs.includes(privateText));
  await api('/v1/ack',{message_ids:[delivered.id]},grok.token);
  const removed=await api('/v1/messages/'+delivered.id,undefined,dot.token); assert.equal(removed.encrypted,undefined); assert.equal(removed.content_unavailable,true);
});
test('encryption identities require possession proof and cannot be replaced even with a valid agent token', async () => {
  const attacker=createIdentity(); await api('/v1/encryption-key',{public_key:attacker.public_key,signature:'00'.repeat(64)},dot.token,409);
  await api('/v1/encryption-key',{public_key:endpointKeys.get(dot.agent.id).public_key,signature:'00'.repeat(64)},dot.token,403);
  await api('/v1/encryption-key',keyRegistration(attacker,base,dot.agent.id),dot.token,409);
  await api('/v1/encryption-key',keyRegistration(endpointKeys.get(dot.agent.id),base,grok.agent.id),dot.token,403);
});
test('retries are idempotent even when sent concurrently', async () => { const input = { to: grok.agent.id, text: 'one delivery', client_message_id: randomUUID() }; const results = await Promise.all([0, 1, 2].map(() => api('/v1/messages', input, dot.token, 201))); assert.equal(new Set(results.map(r => r.id)).size, 1); });
test('idempotency keys reject changed messages and accept equivalent JSON key order', async () => { await api('/v1/messages', { to: grok.agent.id, data: { slots: [], cost: 1, available: true }, client_message_id: 'direct-once' }, dot.token, 409); const same = await api('/v1/messages', { to: grok.agent.id, data: { available: false, cost: 0, slots: ['2026-10-08T18:00:00-04:00'] }, client_message_id: 'direct-once' }, dot.token, 201); assert.equal(same.id, sent.id); });
test('reads retain messages until explicit acknowledgement', async () => { const first = await api('/v1/inbox', {}, grok.token), second = await api('/v1/inbox', {}, grok.token); assert.deepEqual(first, second); await api('/v1/ack', { message_ids: [sent.id] }, grok.token); assert(!(await api('/v1/inbox', {}, grok.token)).messages.some(m => m.id === sent.id)); assert((await api('/v1/inbox', { include_acked: true }, grok.token)).messages.some(m => m.id === sent.id && m.acknowledged)); });
test('another bot cannot acknowledge someone else’s message', async () => { await api('/v1/ack', { message_ids: [sent.id] }, muse.token, 403); });
test('shared room delivery and mention filtering', async () => { const room = await api('/v1/messages', { room: 'home', text: 'Who can handle this?', mentions: [grok.agent.id], client_message_id: randomUUID() }, dot.token, 201); assert((await api('/v1/inbox', { directed_only: true }, grok.token)).messages.some(m => m.id === room.id)); assert(!(await api('/v1/inbox', { directed_only: true }, muse.token)).messages.some(m => m.id === room.id)); assert((await api('/v1/inbox', {}, muse.token)).messages.some(m => m.id === room.id)); await api('/v1/messages', { room: 'home', text: 'unauthorized', client_message_id: randomUUID() }, guest.token, 403); });
test('room mentions cannot reach outside the room', async () => { await api('/v1/messages', { room: 'home', text: 'bad mention', mentions: [guest.agent.id], client_message_id: randomUUID() }, dot.token, 400); });
test('outside contact requires approval by the correct human owner', async () => {
  await api('/v1/messages', { to: grok.agent.id, text: 'no permission', client_message_id: randomUUID() }, guest.token, 403);
  const request = await api('/v1/connections', { to: grok.agent.id }, guest.token, 201);
  assert.equal(request.status, 'pending'); assert((await api('/v1/inbox', {}, grok.token)).messages.some(m => m.data?.request_id === request.request_id));
  await api('/admin/connections/decide', { request_id: request.request_id, decision: 'accepted' }, guest.owner_token, 403);
  await api('/admin/connections/decide', { request_id: request.request_id, decision: 'accepted' }, grok.token, 403);
  await api('/admin/connections/decide', { request_id: request.request_id, decision: 'accepted' });
  await api('/v1/messages', { to: grok.agent.id, text: 'approved', client_message_id: randomUUID() }, guest.token, 201);
  await api('/v1/messages', { room: 'home', text: 'still private', client_message_id: randomUUID() }, guest.token, 403);
  await api('/admin/connections/decide', { request_id: request.request_id, decision: 'revoked' });
  await api('/v1/messages', { to: grok.agent.id, text: 'permission revoked', client_message_id: randomUUID() }, guest.token, 403);
});
test('reply threads preserve correlation and enforce hop limits', async () => { let parent = sent; for (let n = 0; n < 8; n++) { const from = n % 2 === 0 ? grok : dot, to = n % 2 === 0 ? dot : grok; parent = await api('/v1/messages', { to: to.agent.id, text: 'reply', kind: 'response', reply_to: parent.id, client_message_id: randomUUID() }, from.token, 201); assert.equal(parent.thread_id, sent.thread_id); assert.equal(parent.hop_count, n + 1); } await api('/v1/messages', { to: dot.agent.id, text: 'too many', reply_to: parent.id, client_message_id: randomUUID() }, grok.token, 400); });
test('reply contents cannot be forwarded to another conversation', async () => { await api('/v1/messages', { to: muse.agent.id, text: 'wrong conversation', reply_to: sent.id, client_message_id: randomUUID() }, dot.token, 400); });
test('messages and credentials survive a worker restart', async () => { await stop(); await start(); assert.equal((await api('/v1/me', undefined, dot.token)).id, dot.agent.id); assert((await api('/v1/inbox', { include_acked: true }, grok.token)).messages.some(m => m.id === sent.id)); });
test('MCP 2025 tools work through the official client', async () => { const c = await client(dot.token); try { assert.equal((await c.listTools()).tools.length, 12); assert((await c.listTools()).tools.every(t=>t.name.startsWith('ioio_'))); assert.equal((await c.callTool({ name: 'ioio_whoami', arguments: {} })).structuredContent.id, dot.agent.id); assert.match(c.getInstructions(), /same_owner/); assert.equal((await c.callTool({name:'btb_whoami',arguments:{}})).structuredContent.id,dot.agent.id); } finally { await c.close(); } });
test('MCP 2026 discovery and tool calls work through the official client', async () => { const c = await client(dot.token, true); try { assert.equal((await c.callTool({ name: 'ioio_whoami', arguments: {} })).structuredContent.id, dot.agent.id); } finally { await c.close(); } });
test('MCP event catalog is authenticated and callback destinations are restricted', async () => { const request = async (method, params = {}) => api('/mcp', { jsonrpc: '2.0', id: 1, method, params }, dot.token); const list = await request('events/list'); assert.equal(list.result.events[0].name, 'ioio.message.created'); const denied = await request('events/subscribe', { name: 'ioio.message.created', arguments: {}, ttlMs: null, delivery: { mode: 'webhook', url: 'https://127.0.0.1/test', secret: 'whsec_' + randomBytes(32).toString('base64') } }); assert.equal(denied.error.code, -32602); });
test('real-time streams deliver messages and revocation closes the socket', async () => {
  const fresh = await enroll('socket-target'), ws = new WebSocket(base.replace('http', 'ws') + '/v1/stream', { headers: { Authorization: 'Bearer ' + fresh.token } });
  const first = once(ws, 'message'); await once(ws, 'open'); assert.equal(JSON.parse((await first)[0]).type, 'ready');
  assert.equal((await api('/v1/receiving',undefined,fresh.token)).receiving,'stream');
  const arrival = once(ws, 'message'); const message = await api('/v1/messages', { to: fresh.agent.id, text: 'live', client_message_id: randomUUID() }, dot.token, 201); const received = JSON.parse((await arrival)[0]).message; assert.equal(received.id, message.id); assert.equal(received.sender_context.relationship,'same_owner');
  const closed = once(ws, 'close'); await api('/admin/revoke', { agent_id: fresh.agent.id }); assert.equal((await closed)[0], 1008); await api('/v1/me', undefined, fresh.token, 401);
});
test('maintained OAuth enforces PKCE, audience, consent cookies, refresh and revocation', async () => {
  const redirect = 'http://127.0.0.1:9876/callback', c = await api('/oauth/register', { client_name: '<script>bad</script>', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, '', 201);
  const verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: redirect, response_type: 'code', resource: base + '/mcp', scope: 'btb', code_challenge_method: 'S256', code_challenge: challenge, state: 'state-check' });
  const consent = await fetch(base + '/oauth/authorize?' + q); assert.equal(consent.status, 200);
  const html = await consent.text(); assert(!html.includes('<script>bad</script>')); assert(html.includes('&#60;script&#62;'));
  assert(consent.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(consent.headers.get('referrer-policy'),'same-origin');
  assert(consent.headers.get('content-security-policy').includes('https://accounts.google.com'));
  assert(consent.headers.get('content-security-policy').includes('http://127.0.0.1:9876'));
  assert(!consent.headers.get('content-security-policy').includes('*'));
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];
  const unbound = await fetch(base+'/oauth/authorize',{method:'POST',body:new URLSearchParams({handle,decision:'allow'}),redirect:'manual'}); assert.equal(unbound.status,400);
  const cookies = consent.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const opaqueOrigin=await fetch(base+'/oauth/authorize',{method:'POST',headers:{Cookie:cookies,Origin:'null'},body:new URLSearchParams({handle,decision:'allow'}),redirect:'manual'});assert.equal(opaqueOrigin.status,403);
  const denied = await fetch(base+'/oauth/authorize',{method:'POST',headers:{Cookie:cookies},body:new URLSearchParams({handle,decision:'deny'}),redirect:'manual'}); assert.equal(denied.status,302); assert(new URL(denied.headers.get('location')).searchParams.get('error')==='access_denied');
  const replay = await fetch(base+'/oauth/authorize',{method:'POST',headers:{Cookie:cookies},body:new URLSearchParams({handle,decision:'allow'}),redirect:'manual'}); assert.equal(replay.status,400);
  const completed = await api('/__test/complete?'+q+'&agent_id='+dot.agent.id);
  const callback = new URL(completed.redirectTo); assert.equal(callback.searchParams.get('state'),'state-check'); assert.equal(callback.searchParams.get('iss'),base);
  const form = {grant_type:'authorization_code',client_id:c.client_id,redirect_uri:redirect,resource:base+'/mcp',code_verifier:verifier,code:callback.searchParams.get('code')};
  const token = async (data,status=200) => {const r=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams(data)});const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
  await token({...form,resource:'https://wrong.invalid/mcp'},400); await token({...form,code_verifier:randomBytes(48).toString('base64url')},400);
  const grant = await token(form), connected = await clientFor(grant.access_token); assert.equal((await connected.callTool({name:'ioio_whoami',arguments:{}})).structuredContent.id,dot.agent.id); await connected.close();
  const replayCompleted=await api('/__test/complete?'+q+'&agent_id='+dot.agent.id);
  const replayForm={...form,code:new URL(replayCompleted.redirectTo).searchParams.get('code')};
  await token(replayForm);await token(replayForm,400);
  const next = await token({grant_type:'refresh_token',client_id:c.client_id,resource:base+'/mcp',refresh_token:grant.refresh_token});
  const nextClient=await clientFor(next.access_token); assert.equal((await nextClient.callTool({name:'ioio_whoami',arguments:{}})).structuredContent.id,dot.agent.id); await nextClient.close();
  // Follow the maintained provider's published RFC 7009 endpoint.
  const discovery=await (await fetch(base+'/.well-known/oauth-authorization-server')).json();
  const revoked=await fetch(discovery.revocation_endpoint,{method:'POST',body:new URLSearchParams({token:next.refresh_token,client_id:c.client_id})}); assert.equal(revoked.status,200);
  await api('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},next.access_token,401);
});
const clientFor = token => client(token,true);
test('Google owner mapping preserves subjects and isolates other owners',async()=>{
  const owner=await api('/__test/google-owner',{subject:'google-owner',email:'owner@example.com'});assert.equal(owner.owner_id,'home');
  const outside=await api('/__test/google-owner',{subject:'google-outside',email:'outside@example.com'});assert.notEqual(outside.owner_id,'home');
  const repeat=await api('/__test/google-owner',{subject:'google-outside',email:'changed@example.com'});assert.equal(repeat.owner_id,outside.owner_id);
});
test('forged internal identities, unknown browser origins, and oversized bodies are rejected',async()=>{
  const forged=await fetch(base+'/admin/state',{headers:{'X-BTB-Principal':JSON.stringify({kind:'owner',owner_id:'home',hash:'root'}),'X-BTB-Internal-Auth':'fake'}});assert.equal(forged.status,401);
  const origin=await fetch(base+'/v1/me',{headers:{Origin:'https://evil.invalid',Authorization:'Bearer '+dot.token}});assert.equal(origin.status,403);
  const huge=await fetch(base+'/v1/inbox',{method:'POST',headers:{Authorization:'Bearer '+dot.token},body:' '.repeat(32769)});assert.equal(huge.status,413);
  await api('/__test/edge-deny',undefined,admin,429);
  await api('/admin/export',undefined,dot.token,403);await api('/admin/export',undefined,guest.owner_token,403);
});
test('encrypted recovery backups restore identity and receipts without communication content',async()=>{
  const legacyInvite=await api('/admin/invites',{name:'legacy pending enrollment'},admin,201);
  for(let i=0;i<16;i++) await api('/oauth/register',{redirect_uris:['http://127.0.0.1:9876/callback'],token_endpoint_auth_method:'none'},'',201);
  const backup=await api('/admin/backup',{});assert.equal(backup.verified,true);
  const encrypted=await api('/admin/backup/download?key='+encodeURIComponent(backup.key));assert.equal(encrypted.format,'btb-encrypted-v1');assert(!JSON.stringify(encrypted).includes(sent.text));
  const moduleFile=join(directory,'recovery.mjs');await build({entryPoints:['src/recovery.ts'],outfile:moduleFile,bundle:true,platform:'node',format:'esm'});
  const {openBackup}=await import(moduleFile),snapshot=await openBackup(encrypted,'01'.repeat(32));assert(snapshot.oauth.some(x=>x.key.startsWith('client:')));
  assert(snapshot.tables.messages.every(message=>message.text===null&&message.data===null));
  // A pre-upgrade restore must not resurrect readable conversation content.
  snapshot.tables.messages.find(message=>message.seq===sent.id).text='legacy plaintext must not return';
  snapshot.tables.messages.find(message=>message.seq===sent.id).data=JSON.stringify({private:'legacy data must not return'});
  // An older snapshot has no optional temporary-key field; restore it with the
  // original permanent enrollment semantics, without relaxing other columns.
  for (const invite of snapshot.tables.invites) delete invite.credential_ttl_seconds;
  for (const table of ['accounts','setup_links','agent_activity','friendships']) delete snapshot.tables[table];
  let response=await api('/__test/restore',snapshot);while(!response.restored) response=await api('/__test/restore',snapshot);assert.equal(response.restored,true);
  const legacyEnrollment=await api('/__test/recovered?path=/v1/claim',{code:legacyInvite.code},'',201);assert.equal(legacyEnrollment.expires_at,null);
  const me=await api('/__test/recovered?path=/v1/me',undefined,dot.token);assert.equal(me.id,dot.agent.id);
  const inbox=await api('/__test/recovered?path=/v1/inbox',{include_acked:true},grok.token);assert(inbox.messages.some(x=>x.id===sent.id));
  assert(!JSON.stringify(inbox).includes('legacy plaintext')); assert(!JSON.stringify(inbox).includes('legacy data')); assert(inbox.messages.every(message=>message.text===null&&message.data===null&&!message.encrypted));
  assert.equal((await api('/__test/restore',snapshot)).restored,true);
  await api('/admin/restore',snapshot,admin,409);
});
test('CLI pairing stores private credentials and its stdio bridge serves real MCP', async () => {
  const inv = await api('/admin/invites', { name: 'cli-bot' }, admin, 201), config = join(directory, 'cli', 'agent.json');
  const pair = spawn(process.execPath, ['bin/btb.mjs', 'pair', inv.code, '--server', base, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', pairError = ''; pair.stdout.on('data', x => { output += x; }); pair.stderr.on('data', x => { pairError += x; }); const [exit] = await once(pair, 'exit'); assert.equal(exit, 0, pairError);
  const stored = JSON.parse(await readFile(config, 'utf8'));
  const secondInvite = await api('/admin/invites', { name: 'must-not-replace-cli' }, admin, 201);
  const duplicate = spawn(process.execPath, ['bin/btb.mjs', 'pair', secondInvite.code, '--server', base, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] }); let duplicateError = ''; duplicate.stderr.on('data', x => { duplicateError += x; }); assert.equal((await once(duplicate, 'exit'))[0], 1); assert.match(duplicateError, /preserved/); assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), stored);
  assert(!output.includes(stored.token)); assert.equal((await stat(config)).mode & 0o777, 0o600);
  const initialized=spawn(process.execPath,['bin/btb.mjs','privacy-init','--server',base,'--config',config],{stdio:['ignore','pipe','pipe']}); let initError=''; initialized.stderr.on('data',x=>initError+=x); assert.equal((await once(initialized,'exit'))[0],0,initError);
  const privateProfile=JSON.parse(await readFile(config,'utf8'));
  trustPeer(privateProfile.encryption,grok.agent.id,endpointKeys.get(grok.agent.id).public_key,fingerprint(endpointKeys.get(grok.agent.id).public_key));
  await writeFile(config,JSON.stringify(privateProfile),{mode:0o600});
  const c = new Client({ name: 'stdio-test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/btb.mjs', 'mcp', '--config', config, '--server', base] }));
  try {
    assert.equal((await c.callTool({ name: 'ioio_whoami', arguments: {} })).structuredContent.id, stored.agent.id);
    assert.match(c.getInstructions(), /same_owner/); assert.match(c.getInstructions(), /act on behalf/i);
    const tools = (await c.listTools()).tools; assert.equal(tools.length, 12);
    assert.equal(tools.find(t => t.name === 'ioio_whoami')._meta['openai/profile'], true);
    assert(tools.find(t => t.name === 'ioio_whoami').outputSchema.properties.owner);
    assert.equal((await c.callTool({name:'ioio_receiving_status',arguments:{}})).structuredContent.receiving,'manual_or_scheduled');
    const key=randomUUID(),text='local MCP endpoint privacy round-trip';
    const first=await c.callTool({name:'ioio_send',arguments:{to:grok.agent.id,text,client_message_id:key}}); assert.equal(first.isError,undefined); assert.equal(first.structuredContent.text,text);
    const repeated=await c.callTool({name:'ioio_send',arguments:{to:grok.agent.id,text,client_message_id:key}}); assert.equal(repeated.structuredContent.id,first.structuredContent.id);
    trustPeer(endpointKeys.get(grok.agent.id),stored.agent.id,privateProfile.encryption.public_key,fingerprint(privateProfile.encryption.public_key)); endpointKeys.set(stored.agent.id,privateProfile.encryption);
    const inbox=await api('/v1/inbox',{},grok.token); assert.equal(inbox.messages.find(message=>message.id===first.structuredContent.id).text,text);
    const reply=await api('/v1/messages',{to:stored.agent.id,text:'encrypted reply',reply_to:first.structuredContent.id,client_message_id:randomUUID()},grok.token,201);
    const received=await c.callTool({name:'ioio_inbox',arguments:{}}); assert.equal(received.structuredContent.messages.find(message=>message.id===reply.id).text,'encrypted reply');
    const wire=await fetch(base+'/v1/inbox',{method:'POST',headers:{Authorization:'Bearer '+stored.token,'Content-Type':'application/json'},body:'{}'}); assert(!(await wire.text()).includes('encrypted reply'));
  } finally { await c.close(); }
});

test('persistent request gate enforces concurrent limits before message storage',async()=>{const results=await api('/__test/strict-gate');assert.equal(results.filter(x=>x.success).length,2);assert.equal(results.filter(x=>!x.success).length,1);});

test('one setup message enrolls distinct agents, expires on replacement, and cannot administer', async () => {
  const link = await api('/admin/setup', {}, admin, 201);
  assert.match(link.token,/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
  const a = await api('/v1/join', { token:link.token, name:'setup-one' }, '', 201);
  const b = await api('/v1/join', { token:link.token.toLowerCase(), name:'setup-two' }, '', 201);
  assert.notEqual(a.agent.id,b.agent.id); assert.notEqual(a.token,b.token);
  assert.equal((await api('/v1/me',undefined,a.token)).id,a.agent.id);
  await api('/admin/setup',{},a.token,403);
  await api('/v1/me',undefined,link.token,401);
  const backup=await api('/admin/export'); assert(!JSON.stringify(backup).includes(link.token)); assert(!JSON.stringify(backup).includes(a.token));
  const replacement=await api('/admin/setup',{},admin,201);
  await api('/v1/join',{token:link.token,name:'old-message'},'',400);
  await api('/admin/setup/revoke',{});
  await api('/v1/join',{token:replacement.token,name:'revoked-message'},'',400);
  assert.equal((await api('/v1/me',undefined,a.token)).id,a.agent.id);
  await api('/admin/revoke',{agent_id:a.agent.id});await api('/v1/me',undefined,a.token,401);
});
test('setup messages enforce a ten-agent cap under concurrent enrollment', async () => {
  const link=await api('/admin/setup',{},admin,201);
  const outcomes=await Promise.all(Array.from({length:11},(_,i)=>fetch(base+'/v1/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:link.token,name:'batch-'+i})})));
  assert.equal(outcomes.filter(r=>r.status===201).length,10);assert.equal(outcomes.filter(r=>r.status===400).length,1);
});
test('personal numbers survive requests; friends require target approval and never reveal rooms or inboxes', async () => {
  const home=await api('/admin/state'), other=await api('/admin/state',undefined,guest.owner_token);
  assert.equal((await api('/admin/state')).account.number,home.account.number);
  assert.match(home.account.number,/^\d{4}-\d{4}$/);
  const publicProfile=await fetch(base+'/'+home.account.number);assert.equal(publicProfile.status,200);assert(!(await publicProfile.text()).includes('owner@example.com'));
  const request=await api('/admin/friends',{number:home.account.number},guest.owner_token,201);
  await api('/admin/friends/decide',{id:request.id,decision:'accepted'},guest.owner_token,403);
  await api('/admin/friends/decide',{id:request.id,decision:'accepted'},guest.token,403);
  assert(!(await api('/v1/agents',undefined,guest.token)).agents.some(a=>a.id===muse.agent.id));
  await api('/admin/friends/decide',{id:request.id,decision:'accepted'});
  assert((await api('/v1/agents',undefined,guest.token)).agents.some(a=>a.id===muse.agent.id));
  const m=await api('/v1/messages',{to:muse.agent.id,text:'friend delivery',client_message_id:randomUUID()},guest.token,201);
  assert((await api('/v1/inbox',{},muse.token)).messages.some(x=>x.id===m.id));
  assert(!(await api('/v1/inbox',{},dot.token)).messages.some(x=>x.id===m.id));
  await api('/v1/messages',{room:'home',text:'private room',client_message_id:randomUUID()},guest.token,403);
  await api('/admin/friends/decide',{id:request.id,decision:'revoked'},guest.owner_token);
  await api('/v1/messages',{to:muse.agent.id,text:'revoked',client_message_id:randomUUID()},guest.token,403);
  assert(!(await api('/v1/agents',undefined,guest.token)).agents.some(a=>a.id===muse.agent.id));
  assert.equal(other.account.number,(await api('/admin/state',undefined,guest.owner_token)).account.number);
});
test('landing, setup documentation and signed-out actions keep credentials private', async () => {
  const r=await fetch(base+'/');const html=await r.text();assert(html.includes('Continue with Google'));assert(html.includes('Your agents and your friends’ agents, connected.'));assert(!html.includes('setup_'));
  assert(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const setup=await fetch(base+'/owner/setup',{method:'POST',body:new URLSearchParams({csrf:'invalid'})});assert.equal(setup.status,401);
  const docs=await fetch(base+'/setup');assert.equal(docs.status,200);assert((await docs.text()).includes('does not wake your model'));
});

test('approved OAuth selection returns a protected callback document and cannot be replayed', async () => {
  const redirect = 'https://www.client.example/callback', c = await api('/oauth/register', {client_name:'Fixture',redirect_uris:[redirect],token_endpoint_auth_method:'none'}, '', 201);
  const q = new URLSearchParams({client_id:c.client_id,redirect_uri:redirect,response_type:'code',resource:base+'/mcp',scope:'btb',code_challenge_method:'S256',code_challenge:createHash('sha256').update('v'.repeat(48)).digest('base64url'),state:'callback-check'});
  const session = await api('/__test/selection-session?' + q);
  const headers = {Cookie:'__Host-btb-owner='+session.token+'; __Host-btb-select='+session.handle, Origin:base};
  const response = await fetch(base+'/oauth/select', {method:'POST',headers,body:new URLSearchParams({csrf:session.csrf,name:'selection-fixture'}),redirect:'manual'});
  assert.equal(response.status,200); assert.equal(response.headers.get('location'),null);
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert(response.headers.get('content-security-policy').includes("form-action 'self'"));
  assert(!response.headers.get('content-security-policy').includes('client.example'));
  const html = await response.text(); assert(html.includes('location.replace("https://www.client.example/callback?')); assert(html.includes('state=callback-check'));
  assert(response.headers.get('set-cookie').includes('__Host-btb-select=;'));
  const replay = await fetch(base+'/oauth/select',{method:'POST',headers,body:new URLSearchParams({csrf:session.csrf,name:'selection-fixture'}),redirect:'manual'});
  assert.equal(replay.status,401);
});

test('owner website requires a session and CSRF before copying setup permissions', async () => {
  const session=await api('/__test/owner-session');const headers={Cookie:'__Host-btb-owner='+session.token,Origin:base};
  const before=await fetch(base+'/owner',{headers});const html=await before.text();assert(html.includes('No agents connected'));
  assert(!html.includes('portal@example.com'));assert(html.includes('Sign out'));assert(!html.includes('href="/owner/settings"'));assert(!html.includes('href="/owner/add-friend"'));
  for(const path of ['/owner/settings','/owner/add-friend']) { const r=await fetch(base+path,{headers,redirect:'manual'});assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/owner'); }
  const forged=await fetch(base+'/owner/setup',{method:'POST',headers,body:new URLSearchParams({csrf:'forged'})});assert.equal(forged.status,403);
  const response=await fetch(base+'/owner/setup',{method:'POST',headers,body:new URLSearchParams({csrf:session.csrf})});assert.equal(response.status,200);const result=await response.json();
  assert.match(result.message,/^http:\/\/127\.0\.0\.1:8798\/setup#[0-9A-Z-]+$/);assert(result.message.length<120);
  const code=result.message.split('#')[1];const joined=await api('/v1/join',{token:code,name:'My agent'},'',201);
  const notAuthenticated=await(await fetch(base+'/owner',{headers})).text();assert(!notAuthenticated.includes('<strong>My agent</strong>'));
  assert.equal((await api('/v1/agents',undefined,joined.token)).agents.length,1);
  const connected=await(await fetch(base+'/owner',{headers})).text();assert(connected.includes('<strong>My agent</strong>'));assert(!connected.includes('Not connected'));
  await fetch(base+'/owner',{method:'POST',headers,body:new URLSearchParams({csrf:session.csrf,action:'stop-setup'}),redirect:'manual'});
  await api('/v1/join',{token:code,name:'Must not join'},'',400);
  const forgedLogout=await fetch(base+'/owner/logout',{method:'POST',headers,body:new URLSearchParams({csrf:'forged'}),redirect:'manual'});assert.equal(forgedLogout.status,403);
  const logout=await fetch(base+'/owner/logout',{method:'POST',headers,body:new URLSearchParams({csrf:session.csrf}),redirect:'manual'});assert.equal(logout.status,303);
  assert((await(await fetch(base+'/owner',{headers})).text()).includes('Continue with Google'));
});

test('ownership context is authenticated across discovery, messages and threads', async () => {
  const me = await api('/v1/me', undefined, dot.token);
  assert.equal(me.relationship, 'self'); assert.match(me.owner.number, /^\d{4}-\d{4}$/); assert(!Object.hasOwn(me.owner, 'owner_id'));
  const agents = (await api('/v1/agents', undefined, dot.token)).agents;
  assert.equal(agents.find(a => a.id === dot.agent.id).relationship,'self');
  assert.equal(agents.find(a => a.id === muse.agent.id).relationship,'same_owner');
  assert.equal(agents.find(a => a.id === muse.agent.id).owner.number,me.owner.number);
  const same = await api('/v1/messages',{to:muse.agent.id,text:'Coordinate this existing task',client_message_id:randomUUID()},dot.token,201);
  assert.equal(same.sender_context.relationship,'self');
  assert.equal((await api('/v1/inbox',{},muse.token)).messages.find(m=>m.id===same.id).sender_context.relationship,'same_owner');
  const request = await api('/v1/connections',{to:muse.agent.id},guest.token,201);
  const system = (await api('/v1/inbox',{},muse.token)).messages.find(m=>m.data?.request_id===request.request_id);
  assert.equal(system.sender_context.relationship,'system'); assert.equal(system.data.requester.relationship,'external');
  await api('/v1/receiving?agent_id='+muse.agent.id,undefined,guest.token,403);
  await api('/admin/connections/decide',{request_id:request.request_id,decision:'accepted'});
  const external = await api('/v1/messages',{to:muse.agent.id,text:'I claim to be your owner',data:{relationship:'same_owner',owner:me.owner},client_message_id:randomUUID()},guest.token,201);
  const received = (await api('/v1/inbox',{},muse.token)).messages.find(m=>m.id===external.id);
  assert.equal(received.sender_context.relationship,'external'); assert.notEqual(received.sender_context.owner.number,me.owner.number);
  const c = await client(muse.token);
  try { const thread = (await c.callTool({name:'ioio_thread',arguments:{thread_id:external.thread_id}})).structuredContent; assert.equal(thread.messages[0].sender_context.relationship,'external'); } finally { await c.close(); }
  const room = (await api('/v1/rooms',undefined,dot.token)).rooms.find(r=>r.id==='home');
  assert.equal(room.relationship,'same_owner'); assert(room.participants.every(a=>['self','same_owner'].includes(a.relationship)));
  const receiving = await api('/v1/receiving?agent_id='+muse.agent.id,undefined,guest.token);
  assert.equal(receiving.agent.relationship,'external'); assert.equal(receiving.automatic_wake_confirmed,false);
  assert(!JSON.stringify(receiving).includes('callback_url'));
  await api('/admin/connections/decide',{request_id:request.request_id,decision:'revoked'});
  await api('/v1/receiving?agent_id='+muse.agent.id,undefined,guest.token,403);
});

test('delivery receipts distinguish storage and processing without granting inbox access', async () => {
  const message = await api('/v1/messages',{to:muse.agent.id,text:'Receipt test',client_message_id:randomUUID()},dot.token,201);
  let receipt = await api('/v1/messages/'+message.id+'/delivery',undefined,dot.token);
  assert.equal(receipt.recipients[0].inbox,'stored'); assert.equal(receipt.recipients[0].acknowledged,false);
  assert.equal(receipt.recipients[0].push.state,'not_requested'); assert.equal(receipt.recipients[0].push.agent_wake_confirmed,false);
  await api('/v1/messages/'+message.id+'/delivery',undefined,muse.token,403);
  await api('/v1/messages/'+message.id+'/delivery',undefined,guest.token,403);
  const c=await client(dot.token);
  try { assert.deepEqual((await c.callTool({name:'ioio_delivery_status',arguments:{message_id:message.id}})).structuredContent,receipt); } finally { await c.close(); }
  await api('/v1/ack',{message_ids:[message.id]},muse.token);
  receipt=await api('/v1/messages/'+message.id+'/delivery',undefined,dot.token);
  assert.equal(receipt.recipients[0].acknowledged,true);
  await api('/v1/push',{url:'https://evil.example/wake',secret:'whsec_'+randomBytes(32).toString('base64')},muse.token,400);
  const receiver=await client(muse.token);
  try { const failure=await receiver.callTool({name:'ioio_enable_push',arguments:{url:'https://127.0.0.1/wake',secret:'whsec_'+randomBytes(32).toString('base64')}});assert.equal(failure.isError,true); } finally { await receiver.close(); }
});

test('setup and discovery teach consistent ownership and receiving requirements',async()=>{
  for(const path of ['/setup.txt','/setup','/agents.md','/llms.txt','/docs']){
    const response=await fetch(base+path);assert.equal(response.status,200);
    const instructions=await response.text();assert.match(instructions,/same_owner/);assert.match(instructions,/act on behalf/i);assert.match(instructions,/callback accepting a push is not proof/i);assert.match(instructions,/ioio_delivery_status/);
    assert.match(instructions,/Automatic receiving setup is part of onboarding/);
    assert.match(instructions,/preserve its approved sender and task restrictions/);
    assert.match(instructions,/without a human opening the chat/);
    assert.match(instructions,/correlated IO reply/);
    assert.match(instructions,/need a compatible IO provider adapter/);
  }
});
