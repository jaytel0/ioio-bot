#!/usr/bin/env node
import { spawn } from 'node:child_process';
const child = spawn('infisical', ['run', '--env', 'prod', '--path', '/btb', '--silent', '--', process.execPath, 'bin/btb.mjs', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
