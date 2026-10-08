#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import WebSocket from 'ws';
import { createIdentity, fingerprint, trustPeer, keyRegistration, encryptMessage, decryptResult } from './e2ee.mjs';
const owner = process.env.BTB_ADMIN_TOKEN ? { token: process.env.BTB_ADMIN_TOKEN, server: 'https://ioio.bot' } : JSON.parse(await readFile(process.env.BTB_OWNER_FILE || join(homedir(), '.config', 'btb', 'owner.json'), 'utf8'));
const server = (process.argv[2] || owner.server).replace(/\/$/, '');
const created = [];
async function api(path, input, token = owner.token) { const r = await fetch(server + path, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input ? JSON.stringify(input) : undefined }); const result = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${result.error}`); return result; }
async function enroll(name) { const invitation = await api('/admin/invites', { name }); const bot = await api('/v1/claim', { code: invitation.code }, ''); created.push(bot.agent.id); return bot; }
let c, socket;
try {
  const health = await api('/health');
  const sender = await enroll('ioio.bot smoke sender'), receiver = await enroll('ioio.bot smoke receiver');
  const senderKeys=createIdentity(),receiverKeys=createIdentity();
  await api('/v1/encryption-key',keyRegistration(senderKeys,server,sender.agent.id),sender.token);
  await api('/v1/encryption-key',keyRegistration(receiverKeys,server,receiver.agent.id),receiver.token);
  trustPeer(senderKeys,receiver.agent.id,receiverKeys.public_key,fingerprint(receiverKeys.public_key));
  trustPeer(receiverKeys,sender.agent.id,senderKeys.public_key,fingerprint(senderKeys.public_key));
  const clientKey = randomUUID(), content = { to: receiver.agent.id, text: 'ioio.bot production smoke test', data: { preserved: false, value: 0 }, client_message_id: clientKey };
  const encrypted=encryptMessage(senderKeys,server,sender.agent.id,content,[{id:receiver.agent.id,encryption_key:receiverKeys.public_key}]);
  const first = await api('/v1/messages', encrypted, sender.token), repeat = await api('/v1/messages', encrypted, sender.token);
  if (first.id !== repeat.id) throw new Error('Idempotency failed');
  const wire = await api('/v1/inbox', {}, receiver.token);
  if (JSON.stringify(wire).includes(content.text)||JSON.stringify(wire).includes('preserved')) throw new Error('Transport disclosed content');
  const inbox = decryptResult(receiverKeys,server,receiver.agent.id,wire);
  if (!inbox.messages.some(m => m.id === first.id && m.data.value === 0 && m.data.preserved === false)) throw new Error('Durable inbox failed');
  await api('/v1/ack', { message_ids: [first.id] }, receiver.token);
  if ((await api('/v1/messages/'+first.id,undefined,sender.token)).encrypted) throw new Error('Acknowledged content was retained');
  if ((await api('/v1/inbox', {}, receiver.token)).messages.some(m => m.id === first.id)) throw new Error('Acknowledgement failed');
  c = new Client({ name: 'btb-production-smoke', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await c.connect(new StreamableHTTPClientTransport(new URL(server + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${sender.token}` } } }));
  if ((await c.callTool({ name: 'btb_whoami', arguments: {} })).structuredContent.id !== sender.agent.id) throw new Error('MCP identity failed');
  if (!(await c.callTool({name:'ioio_send',arguments:content})).isError) throw new Error('Remote MCP accepted plaintext');
  const exported=await api('/admin/export');
  if (exported.tables.messages.some(message=>message.text!==null||message.data!==null)) throw new Error('Export included content');
  if (exported.tables.google_owners.some(identity=>identity.email!=='')) throw new Error('Persistent email was retained');
  socket = new WebSocket(server.replace(/^http/, 'ws') + '/v1/stream', { headers: { Authorization: `Bearer ${receiver.token}` } });
  const ready = once(socket, 'message'); await once(socket, 'open'); await ready;
  const notification = once(socket, 'message'); const live = await api('/v1/messages', encryptMessage(senderKeys,server,sender.agent.id,{...content,client_message_id:randomUUID()},[{id:receiver.agent.id,encryption_key:receiverKeys.public_key}]), sender.token);
  const arrived = await Promise.race([notification, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('WebSocket delivery timed out')), 10000); timer.unref(); })]);
  if (JSON.parse(arrived[0]).message.id !== live.id) throw new Error('Live delivery failed');
  if (arrived[0].toString().includes(content.text)) throw new Error('Stream disclosed content');
  const legacy=await fetch(server+'/v1/messages',{method:'POST',headers:{Authorization:'Bearer '+sender.token,'Content-Type':'application/json'},body:JSON.stringify(content)}); if(legacy.status!==400) throw new Error('Plaintext REST was not rejected');
  await api('/v1/ack',{message_ids:[live.id]},receiver.token);
  const report = { verified_at: new Date().toISOString(), environment: new URL(server).protocol === 'https:' ? 'remote' : 'local', server, status: health.status, checks: ['endpoint-only private keys','encrypted exact JSON round-trip','plaintext REST and remote MCP rejected','content-free operator exports','no stored Google email','idempotent encrypted retry','acknowledgement removes content','ciphertext-only live WebSocket delivery'], hosted_agents_connected: false };
  await mkdir('.secrets', { recursive: true, mode: 0o700 }); await writeFile('.secrets/live-verification.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
} finally { socket?.terminate(); await c?.close(); for (const agent_id of created) await api('/admin/revoke', { agent_id }); }
