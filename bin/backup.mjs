#!/usr/bin/env node
import { writeFile, chmod } from 'node:fs/promises';
const server = 'https://btb.molly-codex.workers.dev';
if (!process.env.BTB_ADMIN_TOKEN) throw new Error('Run through Infisical Apps /btb prod');
const response = await fetch(server + '/admin/backup', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.BTB_ADMIN_TOKEN } });
const result = await response.json();
if (!response.ok) throw new Error(result.error || 'Backup failed');
if (process.argv[2]) {
  const download = await fetch(server + '/admin/backup/download?key=' + encodeURIComponent(result.key), { headers: { Authorization: 'Bearer ' + process.env.BTB_ADMIN_TOKEN } });
  if (!download.ok) throw new Error('Encrypted backup download failed');
  await writeFile(process.argv[2], await download.text(), { mode: 0o600, flag: 'wx' }); await chmod(process.argv[2], 0o600);
}
console.log(JSON.stringify(result, null, 2));
