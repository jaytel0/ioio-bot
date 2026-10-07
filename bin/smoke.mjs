#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import WebSocket from 'ws';
const owner = JSON.parse(await readFile(process.env.BTB_OWNER_FILE || join(homedir(), '.config', 'btb', 'owner.json'), 'utf8'));
const server = (process.argv[2] || owner.server).replace(/\/$/, '');
const created = [];
async function api(path, input, token = owner.token) { const r = await fetch(server + path, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input ? JSON.stringify(input) : undefined }); const result = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${result.error}`); return result; }
async function enroll(name) { const invitation = await api('/admin/invites', { name }); const bot = await api('/v1/claim', { code: invitation.code }, ''); created.push(bot.agent.id); return bot; }
let c, socket;
try {
  const health = await api('/health');
  const sender = await enroll('BTB smoke sender'), receiver = await enroll('BTB smoke receiver');
  const clientKey = randomUUID(), content = { to: receiver.agent.id, text: 'BTB production smoke test', data: { preserved: false, value: 0 }, client_message_id: clientKey };
  const first = await api('/v1/messages', content, sender.token), repeat = await api('/v1/messages', content, sender.token);
  if (first.id !== repeat.id) throw new Error('Idempotency failed');
  const inbox = await api('/v1/inbox', {}, receiver.token);
  if (!inbox.messages.some(m => m.id === first.id && m.data.value === 0 && m.data.preserved === false)) throw new Error('Durable inbox failed');
  await api('/v1/ack', { message_ids: [first.id] }, receiver.token);
  if ((await api('/v1/inbox', {}, receiver.token)).messages.some(m => m.id === first.id)) throw new Error('Acknowledgement failed');
  c = new Client({ name: 'btb-production-smoke', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await c.connect(new StreamableHTTPClientTransport(new URL(server + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${sender.token}` } } }));
  if ((await c.callTool({ name: 'btb_whoami', arguments: {} })).structuredContent.id !== sender.agent.id) throw new Error('MCP identity failed');
  socket = new WebSocket(server.replace(/^http/, 'ws') + '/v1/stream', { headers: { Authorization: `Bearer ${receiver.token}` } });
  const ready = once(socket, 'message'); await once(socket, 'open'); await ready;
  const notification = once(socket, 'message'); const live = await api('/v1/messages', { ...content, client_message_id: randomUUID() }, sender.token);
  const arrived = await Promise.race([notification, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('WebSocket delivery timed out')), 10000); timer.unref(); })]);
  if (JSON.parse(arrived[0]).message.id !== live.id) throw new Error('Live delivery failed');
  const report = { verified_at: new Date().toISOString(), environment: new URL(server).protocol === 'https:' ? 'remote' : 'local', server, status: health.status, checks: ['authenticated MCP 2026', 'permanent pairing', 'structured direct message', 'idempotent retry', 'durable inbox', 'explicit acknowledgement', 'live WebSocket delivery'], hosted_agents_connected: false };
  await mkdir('.secrets', { recursive: true, mode: 0o700 }); await writeFile('.secrets/live-verification.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
} finally { socket?.terminate(); await c?.close(); for (const agent_id of created) await api('/admin/revoke', { agent_id }); }
