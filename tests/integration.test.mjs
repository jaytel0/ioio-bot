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

const base = 'http://127.0.0.1:8798', admin = 'integration-owner', directory = await mkdtemp(join(tmpdir(), 'btb-test-'));
let worker, logs = '', dot, grok, muse, guest, sent;
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
  const r = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
  const text = await r.text(); const result = text ? JSON.parse(text) : {}; assert.equal(r.status, expected, JSON.stringify(result)); return result;
}
async function enroll(name) { const inv = await api('/admin/invites', { name }, admin, 201); const agent = await api('/v1/claim', { code: inv.code }, '', 201); assert.equal(agent.expires_at, null); return agent; }
async function client(token, modern = false) {
  const c = new Client({ name: 'btb-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return c;
}
before(async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  config.kv_namespaces.push({binding:'RECOVERY_KV',id:'00000000000000000000000000000001'});
  config.main = fixtureFile; config.vars = { BTB_BASE_URL: base, BTB_ADMIN_TOKEN: admin, BTB_INTERNAL_SECRET: 'integration-internal', BTB_OWNER_EMAIL: 'owner@example.com', GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret', BACKUP_ENCRYPTION_KEY: '01'.repeat(32) };
  config.ratelimits[0].simple.limit = 2000; config.ratelimits[1].simple.limit = 200;
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(fixtureFile, `
import application, { BtbHub, serve } from '${process.cwd()}/src/index';
import { oauthHelpers } from '${process.cwd()}/src/oauth';
import { restoreBackup } from '${process.cwd()}/src/recovery';
export { BtbHub };
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__test/')) {
    if (url.pathname !== '/__test/recovered' && request.headers.get('Authorization') !== 'Bearer integration-owner') return Response.json({}, {status:403});
    const hub = env.HUB.get(env.HUB.idFromName('btb-hub-v1'));
    if (url.pathname === '/__test/complete') {
      const parsed = await oauthHelpers(env).parseAuthRequest(new Request(env.BTB_BASE_URL + '/oauth/authorize' + url.search));
      const agent = (await hub.ownerAgents('home')).find(a => a.id === url.searchParams.get('agent_id'));
      if (!agent) return Response.json({}, {status:403});
      return Response.json(await oauthHelpers(env).completeAuthorization({request:parsed,userId:'fixture-user',scope:['btb'],metadata:{agent_id:agent.id},props:{agent_id:agent.id,owner_id:'home',userId:'fixture-user'},revokeExistingGrants:false}));
    }
    if (url.pathname === '/__test/google-owner') { const input = await request.json(); return Response.json(await hub.googleOwner(input.subject,input.email)); }
    if (url.pathname === '/__test/edge-deny') return serve(new Request(env.BTB_BASE_URL+'/v1/me'), {...env,EDGE_RATE_LIMITER:{limit:async()=>({success:false})},HUB:{get:()=>{throw new Error('Database reached')}}},ctx);
    if (url.pathname === '/__test/restore') return restoreBackup({...env,OAUTH_KV:env.RECOVERY_KV,HUB:{idFromName:()=>env.HUB.idFromName('restore-fixture'),get:id=>env.HUB.get(id)}},await request.json());
    if (url.pathname === '/__test/recovered') return env.HUB.get(env.HUB.idFromName('restore-fixture')).fetch(new Request(env.BTB_BASE_URL+url.searchParams.get('path'),{method:request.method,headers:request.headers,body:request.method==='GET'?undefined:await request.text()}));
  }
  return application.fetch(request,env,ctx);
}};`);
  await start(); dot = await enroll('dot'); grok = await enroll('grokbot'); muse = await enroll('muse'); guest = await api('/v1/register', { name: 'outside' }, '', 201); });
after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });

test('unpaired users cannot read private messages or use tools', async () => { await api('/v1/me', undefined, '', 401); await api('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '', 401); });
test('bot credentials cannot administer the network', async () => { await api('/admin/invites', { name: 'bad' }, dot.token, 403); await api('/v1/me', undefined, admin, 403); });
test('pairing codes can be consumed only once, including concurrent requests', async () => { const inv = await api('/admin/invites', { name: 'one-time' }, admin, 201); const attempts = await Promise.all([0, 1].map(() => fetch(base + '/v1/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: inv.code }) }))); assert.deepEqual(attempts.map(r => r.status).sort(), [201, 400]); });
test('preassigned agent numbers survive pairing and subsequent credentials', async () => { const a = await api('/admin/agents', { name: 'instinct' }, admin, 201); const inv = await api('/admin/invites', { name: 'instinct', agent_id: a.id }, admin, 201); const enrolled = await api('/v1/claim', { code: inv.code }, '', 201); assert.equal(enrolled.agent.id, a.id); assert.match(a.id, /^A-\d{3}-\d{3}-\d{3}$/); });
test('agent tokens stored only as hashes', async () => { const backup = await api('/admin/export'); assert(!JSON.stringify(backup).includes(dot.token)); assert(!JSON.stringify(backup).includes(guest.owner_token)); });
test('guests cannot discover private agents or rooms', async () => { const list = await api('/v1/agents', undefined, guest.token); assert.deepEqual(list.agents.map(a => a.id), [guest.agent.id]); assert.deepEqual((await api('/v1/rooms', undefined, guest.token)).rooms, []); });
test('direct messages preserve structured values exactly and stay private', async () => { sent = await api('/v1/messages', { to: grok.agent.id, data: { slots: ['2026-10-08T18:00:00-04:00'], cost: 0, available: false }, client_message_id: 'direct-once' }, dot.token, 201); const inbox = await api('/v1/inbox', {}, grok.token); assert.deepEqual(inbox.messages[0].data, { slots: ['2026-10-08T18:00:00-04:00'], cost: 0, available: false }); assert.equal((await api('/v1/inbox', {}, muse.token)).messages.length, 0); });
test('retries are idempotent even when sent concurrently', async () => { const input = { to: grok.agent.id, text: 'one delivery', client_message_id: randomUUID() }; const results = await Promise.all([0, 1, 2].map(() => api('/v1/messages', input, dot.token, 201))); assert.equal(new Set(results.map(r => r.id)).size, 1); });
test('idempotency keys reject changed messages and accept equivalent JSON key order', async () => { await api('/v1/messages', { to: grok.agent.id, data: { slots: [], cost: 1, available: true }, client_message_id: 'direct-once' }, dot.token, 409); const same = await api('/v1/messages', { to: grok.agent.id, data: { available: false, cost: 0, slots: ['2026-10-08T18:00:00-04:00'] }, client_message_id: 'direct-once' }, dot.token, 201); assert.equal(same.id, sent.id); });
test('reads retain messages until explicit acknowledgement', async () => { const first = await api('/v1/inbox', {}, grok.token), second = await api('/v1/inbox', {}, grok.token); assert.deepEqual(first, second); await api('/v1/ack', { message_ids: [sent.id] }, grok.token); assert(!(await api('/v1/inbox', {}, grok.token)).messages.some(m => m.id === sent.id)); assert((await api('/v1/inbox', { include_acked: true }, grok.token)).messages.some(m => m.id === sent.id && m.acknowledged)); });
test('another bot cannot acknowledge someone else’s message', async () => { await api('/v1/ack', { message_ids: [sent.id] }, muse.token, 403); });
test('shared room delivery and mention filtering', async () => { const room = await api('/v1/messages', { room: 'home', text: 'Who can handle this?', mentions: [grok.agent.id], client_message_id: randomUUID() }, dot.token, 201); assert((await api('/v1/inbox', { directed_only: true }, grok.token)).messages.some(m => m.id === room.id)); assert(!(await api('/v1/inbox', { directed_only: true }, muse.token)).messages.some(m => m.id === room.id)); assert((await api('/v1/inbox', {}, muse.token)).messages.some(m => m.id === room.id)); await api('/v1/messages', { room: 'home', text: 'unauthorized', client_message_id: randomUUID() }, guest.token, 403); });
test('room mentions cannot reach outside the room', async () => { await api('/v1/messages', { room: 'home', text: 'bad mention', mentions: [guest.agent.id], client_message_id: randomUUID() }, dot.token, 400); });
test('outside contact requires approval by the correct human owner', async () => {
  await api('/v1/messages', { to: grok.agent.id, text: 'no permission', client_message_id: randomUUID() }, guest.token, 403);
  const request = await api('/v1/connections', { to: grok.agent.id, reason: 'Coordinate a test' }, guest.token, 201);
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
test('MCP 2025 tools work through the official client', async () => { const c = await client(dot.token); try { assert.equal((await c.listTools()).tools.length, 9); assert.equal((await c.callTool({ name: 'btb_whoami', arguments: {} })).structuredContent.id, dot.agent.id); } finally { await c.close(); } });
test('MCP 2026 discovery and tool calls work through the official client', async () => { const c = await client(dot.token, true); try { assert.equal((await c.callTool({ name: 'btb_whoami', arguments: {} })).structuredContent.id, dot.agent.id); } finally { await c.close(); } });
test('MCP event catalog is authenticated and callback destinations are restricted', async () => { const request = async (method, params = {}) => api('/mcp', { jsonrpc: '2.0', id: 1, method, params }, dot.token); const list = await request('events/list'); assert.equal(list.result.events[0].name, 'btb.message.created'); const denied = await request('events/subscribe', { name: 'btb.message.created', arguments: {}, ttlMs: null, delivery: { mode: 'webhook', url: 'https://127.0.0.1/test', secret: 'whsec_' + randomBytes(32).toString('base64') } }); assert.equal(denied.error.code, -32602); });
test('real-time streams deliver messages and revocation closes the socket', async () => {
  const fresh = await enroll('socket-target'), ws = new WebSocket(base.replace('http', 'ws') + '/v1/stream', { headers: { Authorization: 'Bearer ' + fresh.token } });
  const first = once(ws, 'message'); await once(ws, 'open'); assert.equal(JSON.parse((await first)[0]).type, 'ready');
  const arrival = once(ws, 'message'); const message = await api('/v1/messages', { to: fresh.agent.id, text: 'live', client_message_id: randomUUID() }, dot.token, 201); assert.equal(JSON.parse((await arrival)[0]).message.id, message.id);
  const closed = once(ws, 'close'); await api('/admin/revoke', { agent_id: fresh.agent.id }); assert.equal((await closed)[0], 1008); await api('/v1/me', undefined, fresh.token, 401);
});
test('maintained OAuth enforces PKCE, audience, consent cookies, refresh and revocation', async () => {
  const redirect = 'http://127.0.0.1:9876/callback', c = await api('/oauth/register', { client_name: '<script>bad</script>', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, '', 201);
  const verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: redirect, response_type: 'code', resource: base + '/mcp', scope: 'btb', code_challenge_method: 'S256', code_challenge: challenge, state: 'state-check' });
  const consent = await fetch(base + '/oauth/authorize?' + q); assert.equal(consent.status, 200);
  const html = await consent.text(); assert(!html.includes('<script>bad</script>')); assert(html.includes('&#60;script&#62;'));
  assert(consent.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];
  const unbound = await fetch(base+'/oauth/authorize',{method:'POST',body:new URLSearchParams({handle,decision:'allow'}),redirect:'manual'}); assert.equal(unbound.status,400);
  const cookies = consent.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const denied = await fetch(base+'/oauth/authorize',{method:'POST',headers:{Cookie:cookies},body:new URLSearchParams({handle,decision:'deny'}),redirect:'manual'}); assert.equal(denied.status,302); assert(new URL(denied.headers.get('location')).searchParams.get('error')==='access_denied');
  const replay = await fetch(base+'/oauth/authorize',{method:'POST',headers:{Cookie:cookies},body:new URLSearchParams({handle,decision:'allow'}),redirect:'manual'}); assert.equal(replay.status,400);
  const completed = await api('/__test/complete?'+q+'&agent_id='+dot.agent.id);
  const callback = new URL(completed.redirectTo); assert.equal(callback.searchParams.get('state'),'state-check'); assert.equal(callback.searchParams.get('iss'),base);
  const form = {grant_type:'authorization_code',client_id:c.client_id,redirect_uri:redirect,resource:base+'/mcp',code_verifier:verifier,code:callback.searchParams.get('code')};
  const token = async (data,status=200) => {const r=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams(data)});const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;};
  await token({...form,resource:'https://wrong.invalid/mcp'},400); await token({...form,code_verifier:randomBytes(48).toString('base64url')},400);
  const grant = await token(form), connected = await clientFor(grant.access_token); assert.equal((await connected.callTool({name:'btb_whoami',arguments:{}})).structuredContent.id,dot.agent.id); await connected.close();
  const next = await token({grant_type:'refresh_token',client_id:c.client_id,resource:base+'/mcp',refresh_token:grant.refresh_token});
  const nextClient=await clientFor(next.access_token); assert.equal((await nextClient.callTool({name:'btb_whoami',arguments:{}})).structuredContent.id,dot.agent.id); await nextClient.close();
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
test('encrypted backup round-trips and restores identity and inbox into an empty isolated network',async()=>{
  for(let i=0;i<16;i++) await api('/oauth/register',{redirect_uris:['http://127.0.0.1:9876/callback'],token_endpoint_auth_method:'none'},'',201);
  const backup=await api('/admin/backup',{});assert.equal(backup.verified,true);
  const encrypted=await api('/admin/backup/download?key='+encodeURIComponent(backup.key));assert.equal(encrypted.format,'btb-encrypted-v1');assert(!JSON.stringify(encrypted).includes(sent.text));
  const moduleFile=join(directory,'recovery.mjs');await build({entryPoints:['src/recovery.ts'],outfile:moduleFile,bundle:true,platform:'node',format:'esm'});
  const {openBackup}=await import(moduleFile),snapshot=await openBackup(encrypted,'01'.repeat(32));assert(snapshot.oauth.some(x=>x.key.startsWith('client:')));
  let response=await api('/__test/restore',snapshot);while(!response.restored) response=await api('/__test/restore',snapshot);assert.equal(response.restored,true);
  const me=await api('/__test/recovered?path=/v1/me',undefined,dot.token);assert.equal(me.id,dot.agent.id);
  const inbox=await api('/__test/recovered?path=/v1/inbox',{include_acked:true},grok.token);assert(inbox.messages.some(x=>x.id===sent.id));
  assert.equal((await api('/__test/restore',snapshot)).restored,true);
  await api('/admin/restore',snapshot,admin,409);
});
test('CLI pairing stores private credentials and its stdio bridge serves real MCP', async () => {
  const inv = await api('/admin/invites', { name: 'cli-bot' }, admin, 201), config = join(directory, 'cli', 'agent.json');
  const pair = spawn(process.execPath, ['bin/btb.mjs', 'pair', inv.code, '--server', base, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; pair.stdout.on('data', x => { output += x; }); const [exit] = await once(pair, 'exit'); assert.equal(exit, 0);
  const stored = JSON.parse(await readFile(config, 'utf8'));
  const secondInvite = await api('/admin/invites', { name: 'must-not-replace-cli' }, admin, 201);
  const duplicate = spawn(process.execPath, ['bin/btb.mjs', 'pair', secondInvite.code, '--server', base, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] }); let duplicateError = ''; duplicate.stderr.on('data', x => { duplicateError += x; }); assert.equal((await once(duplicate, 'exit'))[0], 1); assert.match(duplicateError, /preserved/); assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), stored);
  assert(!output.includes(stored.token)); assert.equal((await stat(config)).mode & 0o777, 0o600);
  const c = new Client({ name: 'stdio-test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/btb.mjs', 'mcp', '--config', config, '--server', base] }));
  try { assert.equal((await c.callTool({ name: 'btb_whoami', arguments: {} })).structuredContent.id, stored.agent.id); } finally { await c.close(); }
});
