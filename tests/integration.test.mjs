import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import WebSocket from 'ws';

const base = 'http://127.0.0.1:8798', admin = 'integration-owner', directory = await mkdtemp(join(tmpdir(), 'btb-test-'));
let worker, logs = '', dot, grok, muse, guest, sent;
async function start() {
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8798', '--inspector-port', '0', '--persist-to', join(directory, 'storage'), '--var', `BTB_ADMIN_TOKEN:${admin}`], { detached: true, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', x => { logs = (logs + x).slice(-16000); }); worker.stderr.on('data', x => { logs = (logs + x).slice(-16000); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { try { if ((await fetch(base + '/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Worker did not start: ' + logs);
}
async function stop() { if (worker?.pid) { const exited = once(worker, 'exit'); process.kill(-worker.pid, 'SIGTERM'); await exited; worker = undefined; } }
async function api(path, input, token = admin, expected = 200) {
  const r = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
  const result = await r.json(); assert.equal(r.status, expected, JSON.stringify(result)); return result;
}
async function enroll(name) { const inv = await api('/admin/invites', { name }, admin, 201); const agent = await api('/v1/claim', { code: inv.code }, '', 201); assert.equal(agent.expires_at, null); return agent; }
async function client(token, modern = false) {
  const c = new Client({ name: 'btb-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return c;
}
before(async () => { await start(); dot = await enroll('dot'); grok = await enroll('grokbot'); muse = await enroll('muse'); guest = await api('/v1/register', { name: 'outside' }, '', 201); });
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
test('OAuth enforces owner approval, PKCE, audience, one-use codes and durable rotating refresh', async () => {
  const redirect = 'http://127.0.0.1:9876/callback', client = await api('/oauth/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, '', 201);
  const verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', resource: base + '/mcp', scope: 'btb', code_challenge_method: 'S256', code_challenge: challenge, state: 'state-check' });
  const response = await fetch(base + '/oauth/authorize?' + q, { redirect: 'manual' }); assert.equal(response.status, 303);
  const wait = response.headers.get('location'); const approval = await (await fetch(wait)).text(); const code = approval.match(/Verification code: (\d{8})/)[1];
  await api('/admin/oauth/approve', { code, agent_id: dot.agent.id }, dot.token, 403); await api('/admin/oauth/approve', { code, agent_id: dot.agent.id });
  const finish = await fetch(wait, { redirect: 'manual' }); const callback = new URL(finish.headers.get('location')); assert.equal(callback.searchParams.get('state'), 'state-check'); assert.equal(callback.searchParams.get('iss'), base);
  const form = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirect, resource: base + '/mcp', code_verifier: verifier, code: callback.searchParams.get('code') };
  const token = async (data, status = 200) => { const r = await fetch(base + '/oauth/token', { method: 'POST', body: new URLSearchParams(data) }); const result = await r.json(); assert.equal(r.status, status, JSON.stringify(result)); return result; };
  await token({ ...form, resource: 'https://wrong.invalid/mcp' }, 400); await token({ ...form, code_verifier: randomBytes(48).toString('base64url') }, 400);
  const grant = await token(form); await token(form, 400); assert.equal((await api('/v1/me', undefined, grant.access_token)).id, dot.agent.id);
  const next = await token({ grant_type: 'refresh_token', client_id: client.client_id, resource: base + '/mcp', refresh_token: grant.refresh_token });
  const snapshot = await api('/admin/export'); const persisted = snapshot.tables.tokens.find(t => t.hash === createHash('sha256').update(next.refresh_token).digest('hex')); assert.equal(persisted.expires_at, null);
  await token({ grant_type: 'refresh_token', client_id: client.client_id, resource: base + '/mcp', refresh_token: grant.refresh_token }, 400); await api('/v1/me', undefined, next.access_token, 401);
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
