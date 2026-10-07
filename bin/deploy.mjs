#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const keys = ['BTB_ADMIN_TOKEN', 'BTB_INTERNAL_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'BACKUP_ENCRYPTION_KEY'];
const missing = keys.filter(key => !process.env[key]);
if (missing.length) throw new Error('Missing Apps /btb prod secrets: ' + missing.join(', '));
if (process.env.GROKBOT_WEBHOOK_KEY) keys.push('GROKBOT_WEBHOOK_KEY');
const temporary = await mkdtemp(join(tmpdir(), 'btb-deploy-')), file = join(temporary, 'secrets.json');
try {
  await writeFile(file, JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))), { mode: 0o600 });
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--secrets-file', file], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  process.exitCode = await new Promise(resolve => child.on('exit', code => resolve(code ?? 1)));
} finally { await rm(temporary, { recursive: true, force: true }); }
