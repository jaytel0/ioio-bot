#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const file = process.env.BTB_OWNER_FILE || join(homedir(), '.config', 'btb', 'owner.json');
const { token } = JSON.parse(await readFile(file, 'utf8'));
if (!/^btb_owner_[a-f0-9]{64}$/.test(token)) throw new Error('Invalid owner secret');
const child = spawn('npx', ['wrangler', 'secret', 'put', 'BTB_ADMIN_TOKEN'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(token + '\n');
child.on('exit', code => { process.exitCode = code || 0; });
