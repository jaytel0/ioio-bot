#!/usr/bin/env node
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const ownerFile = process.env.BTB_OWNER_FILE || join(homedir(), '.config', 'btb', 'owner.json');
const owner = process.env.BTB_ADMIN_TOKEN ? { token: process.env.BTB_ADMIN_TOKEN, server: 'https://ioio.bot' } : JSON.parse(await readFile(ownerFile, 'utf8'));
const server = (process.argv[2] || owner.server).replace(/\/$/, '');
async function api(path, input) { const r = await fetch(server + path, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: input ? JSON.stringify(input) : undefined }); const result = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${result.error}`); return result; }
const state = await api('/admin/state');
const agents = {};
for (const name of ['Dot', 'Instinct', 'Grokbot', 'Muse']) agents[name] = state.agents.find(a => a.name === name && !a.revoked) || await api('/admin/agents', { name });
await mkdir('.secrets', { recursive: true, mode: 0o700 }); await chmod('.secrets', 0o700);
await writeFile('.secrets/agents.json', JSON.stringify({ server, mcp: server + '/mcp', agents }, null, 2) + '\n', { mode: 0o600 }); await chmod('.secrets/agents.json', 0o600);
process.stdout.write(JSON.stringify({ server, agents: Object.fromEntries(Object.entries(agents).map(([name, a]) => [name, a.id])), paired: false, next: 'Connect each hosted agent once with OAuth, or issue an eight-digit invitation when it is ready to enroll.' }, null, 2) + '\n');
