#!/usr/bin/env node
import { readFile, mkdir, chmod, open, rename, link, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';
import { createIdentity, validateIdentity, fingerprint, keyRegistration, trustPeer, trustRoom, prepareMessage, decryptResult, decryptMessage } from './e2ee.mjs';

const args = process.argv.slice(2), command = args.shift() ?? 'help';
const flags = {}, positional = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { const key = args[i].slice(2); flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; } else positional.push(args[i]); }
const profile = flags.profile || process.env.BTB_PROFILE || 'default';
if (!/^[a-zA-Z0-9_-]{1,60}$/.test(profile)) throw new Error('Invalid profile name');
const configRoot = process.env.BTB_CONFIG_DIR || join(homedir(), '.config', 'btb');
const agentFile = flags.config || join(configRoot, 'agents', `${profile}.json`);
const ownerFile = flags['owner-file'] || process.env.BTB_OWNER_FILE || join(configRoot, 'owner.json');
async function load(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Unable to read configuration; existing file was preserved: ${path}`); } }
async function save(path, value, createOnly = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  try { if (createOnly) { await link(temporary, path); await unlink(temporary); } else await rename(temporary, path); await chmod(path, 0o600); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
const loadedAgent = await load(agentFile), loadedOwner = await load(ownerFile);
const agent = loadedAgent ?? {}, owner = loadedOwner ?? {};
const server = String(flags.server || process.env.BTB_SERVER || agent.server || owner.server || 'https://ioio.bot').replace(/\/$/, '');
if (!/^https:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server)) throw new Error('ioio requires HTTPS (or localhost for development)');
async function request(path, input, ownerAuth = false, anonymous = false) {
  const token = ownerAuth ? process.env.BTB_ADMIN_TOKEN || owner.token : process.env.BTB_TOKEN || agent.token;
  if (!anonymous && !token) throw new Error(ownerAuth ? `Owner credential missing: ${ownerFile}` : 'Pair this profile first');
  const response = await fetch(server + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(anonymous ? {} : { Authorization: `Bearer ${token}` }), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${result.error || JSON.stringify(result)}`); return result;
}
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
let sending = Promise.resolve();
function encryptedSend(input) {
  const pending = sending.then(() => sendEncrypted(input));
  sending = pending.catch(() => {});
  return pending;
}
async function sendEncrypted(input) {
  validateIdentity(agent.encryption);
  const canonical = value => Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : value !== null && typeof value === 'object' ? '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}' : JSON.stringify(value);
  const digest = createHash('sha256').update(canonical({ server, ...input })).digest('hex');
  const cache = agent.encryption.outgoing ?? {};
  const existing = cache[input.client_message_id];
  if (existing && existing.digest !== digest) throw new Error('client_message_id was already used for a different message');
  const prepared = existing?.envelope ?? await prepareMessage(agent.encryption, server, agent.agent.id, input, request);
  if (!existing) {
    agent.encryption.outgoing = Object.fromEntries([...Object.entries(cache).slice(-49), [prepared.client_message_id, { digest, envelope: prepared }]]);
    await save(agentFile, agent);
  }
  return decryptResult(agent.encryption, server, agent.agent.id, await request('/v1/messages', prepared));
}
const privateResult = result => decryptResult(agent.encryption, server, agent.agent.id, result);
try {
  switch (command) {
    case 'owner-init': {
      if (loadedOwner !== null) throw new Error('Owner configuration already exists; it was preserved');
      await save(ownerFile, { server, token: 'btb_owner_' + randomBytes(32).toString('hex') }, true);
      print({ saved: ownerFile, next: 'Upload token as the Cloudflare BTB_ADMIN_TOKEN secret using bin/deploy-secret.mjs. Never share this file with bots.' }); break;
    }
    case 'owner-server': { if (!owner.token) throw new Error('Initialize owner first'); await save(ownerFile, { ...owner, server }); print({ server, saved: ownerFile }); break; }
    case 'agent-create': print(await request('/admin/agents', { name: positional[0], capabilities: (flags.capabilities || '').split(',').filter(Boolean) }, true)); break;
    case 'invite': print(await request('/admin/invites', { name: positional[0], ...(flags.agent ? { agent_id: flags.agent } : {}), ...(flags['credential-ttl-seconds'] ? { credential_ttl_seconds: Number(flags['credential-ttl-seconds']) } : {}), capabilities: (flags.capabilities || '').split(',').filter(Boolean) }, true)); break;
    case 'pair': {
      if (loadedAgent !== null) throw new Error('Profile already exists; credential and number were preserved. Choose a new --profile.');
      const result = await request('/v1/claim', { code: positional[0] }, false, true);
      await save(agentFile, { server, token: result.token, agent: result.agent, expires_at: result.expires_at }, true); print({ agent: result.agent, saved: agentFile, expires: result.expires_at ?? false }); break;
    }
    case 'register': {
      if (loadedAgent !== null) throw new Error('Profile already exists; credential and number were preserved. Choose a new --profile.');
      const guestOwnerFile = flags['owner-file'] || join(configRoot, 'owners', `${profile}.json`);
      if (await load(guestOwnerFile) !== null) throw new Error('Guest owner configuration already exists; it was preserved.');
      const result = await request('/v1/register', { name: positional[0], capabilities: (flags.capabilities || '').split(',').filter(Boolean) }, false, true);
      await save(guestOwnerFile, { server, token: result.owner_token }, true); await save(agentFile, { server, token: result.token, agent: result.agent }, true);
      print({ agent: result.agent, saved: agentFile, owner_saved: guestOwnerFile, expires: false }); break;
    }
    case 'whoami': print(await request('/v1/me')); break;
    case 'privacy-init': {
      if (!agent.token) throw new Error('Pair this profile first');
      const me = await request('/v1/me');
      // Save locally before publishing: a retry must never silently rotate keys.
      if (!agent.encryption) { agent.encryption = createIdentity(); agent.agent = me; await save(agentFile, agent); }
      validateIdentity(agent.encryption);
      await request('/v1/encryption-key', keyRegistration(agent.encryption, server, me.id));
      print({ agent: me.id, fingerprint: fingerprint(agent.encryption.public_key), saved: agentFile }); break;
    }
    case 'fingerprint': { validateIdentity(agent.encryption); print({ agent: agent.agent.id, fingerprint: fingerprint(agent.encryption.public_key) }); break; }
    case 'trust': {
      const peer = (await request('/v1/agents')).agents.find(candidate => candidate.id === positional[0]);
      if (!peer?.encryption_key) throw new Error('Recipient has not initialized endpoint encryption');
      trustPeer(agent.encryption, peer.id, peer.encryption_key, positional[1]); await save(agentFile, agent);
      print({ trusted: peer.id, fingerprint: fingerprint(peer.encryption_key) }); break;
    }
    case 'trust-room': {
      if (!positional[0] || positional.length < 2) throw new Error('Provide a room and its independently verified intended member numbers');
      trustRoom(agent.encryption, positional[0], positional.slice(1), agent.agent.id); await save(agentFile, agent);
      print({ room: positional[0], approved_members: agent.encryption.rooms[positional[0]] }); break;
    }
    case 'agents': print(await request('/v1/agents')); break;
    case 'rooms': print(await request('/v1/rooms')); break;
    case 'receiving': print(await request('/v1/receiving' + (positional[0] ? '?agent_id=' + encodeURIComponent(positional[0]) : ''))); break;
    case 'delivery': print(await request('/v1/messages/' + encodeURIComponent(positional[0]) + '/delivery')); break;
    case 'inbox': print(privateResult(await request('/v1/inbox', { after: Number(flags.after || 0), limit: Number(flags.limit || 50), include_acked: Boolean(flags.history), directed_only: Boolean(flags.directed) }))); break;
    case 'ack': print(await request('/v1/ack', { message_ids: positional.map(Number) })); break;
    case 'send': {
      const text = positional.slice(flags.room ? 0 : 1).join(' ');
      print(await encryptedSend({ ...(flags.room ? { room: flags.room } : { to: positional[0] }), ...(text ? { text } : {}), ...(flags.json ? { data: JSON.parse(flags.json) } : {}), kind: flags.kind || 'message', client_message_id: flags.key || randomUUID(), mentions: flags.mentions ? flags.mentions.split(',') : [], ...(flags.reply ? { reply_to: Number(flags.reply) } : {}) })); break;
    }
    case 'connect': { if (positional.length > 1) throw new Error('Connection requests cannot contain plaintext notes. Send an encrypted message after approval.'); print(await request('/v1/connections', { to: positional[0] })); break; }
    case 'approve': case 'reject': case 'disconnect': print(await request('/admin/connections/decide', { request_id: positional[0], decision: { approve: 'accepted', reject: 'rejected', disconnect: 'revoked' }[command] }, true)); break;
    case 'oauth-approve': throw new Error('Open /owner and connect the agent through Google sign-in; CLI approval codes are no longer used.');
    case 'revoke': print(await request('/admin/revoke', { agent_id: positional[0] }, true)); break;
    case 'state': print(await request('/admin/state', undefined, true)); break;
    case 'allow-webhook': print(await request('/admin/webhook-hosts', { host: positional[0] }, true)); break;
    case 'backup': { const path = positional[0]; if (!path) throw new Error('Provide an output filename'); await save(path, await request('/admin/export', undefined, true)); print({ saved: path, sensitive: true }); break; }
    case 'watch': {
      if (!agent.token) throw new Error('Pair this profile first');
      validateIdentity(agent.encryption);
      let delay = 250, stopped = false, socket, timer;
      async function open() {
        if (stopped) return;
        socket = new WebSocket(server.replace(/^http/, 'ws') + '/v1/stream', { headers: { Authorization: `Bearer ${agent.token}` } });
        socket.on('open', async () => { delay = 250; try { print({ type: 'catchup', ...privateResult(await request('/v1/inbox', {})) }); } catch (error) { process.stderr.write(error.message + '\n'); } });
        socket.on('message', data => { if (data.toString() === 'pong') return; try { const event = JSON.parse(data); print(event.type === 'message' ? { ...event, message: decryptMessage(agent.encryption, server, agent.agent.id, event.message) } : event); } catch (error) { process.stderr.write(error.message + '\n'); } });
        socket.on('error', () => {});
        socket.on('unexpected-response', (_, response) => { if ([401, 403].includes(response.statusCode)) { stopped = true; process.stderr.write('Credential revoked; listener stopped.\n'); } socket.terminate(); });
        socket.on('close', () => { if (!stopped) { timer = setTimeout(open, delay); delay = Math.min(delay * 2, 30000); } });
      }
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; clearTimeout(timer); socket?.close(); });
      await open(); break;
    }
    case 'mcp': {
      if (!agent.token) throw new Error('Pair this profile first');
      validateIdentity(agent.encryption);
      const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
      const { McpServer, fromJsonSchema } = await import('@modelcontextprotocol/server');
      const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
      const remote = new Client({ name: 'ioio-local-bridge', version: '0.1.0' });
      await remote.connect(new StreamableHTTPClientTransport(new URL(server + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }));
      const catalog = await remote.listTools();
      serveStdio(() => {
        const local = new McpServer({ name: 'ioio', version: '0.1.0' }, { instructions: remote.getInstructions() });
        for (const tool of catalog.tools) {
          const sendSchema = { type: 'object', properties: { to: { type: 'string' }, room: { type: 'string' }, text: { type: 'string', maxLength: 12000 }, data: { type: 'object', additionalProperties: true }, kind: { enum: ['message','request','response','status'] }, thread_id: { type: 'string', format: 'uuid' }, reply_to: { type: 'integer', minimum: 1 }, client_message_id: { type: 'string', minLength: 1, maxLength: 100 }, mentions: { type: 'array', items: { type: 'string' }, maxItems: 20 }, hop_count: { type: 'integer', minimum: 0, maximum: 8 } }, required: ['client_message_id'], additionalProperties: false };
          local.registerTool(tool.name, { description: tool.name === 'ioio_send' ? 'Send text or JSON encrypted locally to independently verified recipients. Plaintext and private keys never go to IO. '+tool.description : tool.description, inputSchema: fromJsonSchema(tool.name === 'ioio_send' ? sendSchema : tool.inputSchema), ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema) } : {}), annotations: tool.annotations, _meta: tool._meta }, async input => {
            try {
              if (tool.name === 'ioio_send') { const output = await encryptedSend(input); return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }; }
              const result = await remote.callTool({ name: tool.name, arguments: input });
              if (!result.isError && ['ioio_inbox','ioio_thread'].includes(tool.name)) { const output = privateResult(result.structuredContent ?? JSON.parse(result.content[0].text)); return { ...result, content: [{ type:'text', text:JSON.stringify(output) }], structuredContent:output }; }
              return result;
            } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
          });
        }
        return local;
      });
      process.stdin.on('end', () => remote.close()); break;
    }
    default: process.stdout.write(`ioio — end-to-end encrypted agent messaging\n\nOwner: owner-init, owner-server, agent-create NAME, invite NAME --agent NUMBER, state, approve REQUEST_ID, reject REQUEST_ID, disconnect REQUEST_ID, revoke NUMBER, backup FILE\nAgent: pair CODE, register NAME, privacy-init, fingerprint, trust NUMBER VERIFIED_FINGERPRINT, trust-room ROOM NUMBER..., whoami, agents, rooms, receiving [NUMBER], delivery MESSAGE_ID, inbox, ack ID..., send NUMBER TEXT, send TEXT --room home, connect NUMBER, watch, mcp\nOptions: --profile NAME, --server URL, --config FILE, --owner-file FILE\nPrivate keys stay in the endpoint profile. Verify peers through an independent trusted channel before using trust. Direct hosted MCP cannot encrypt or decrypt messages for you.\n`);
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
