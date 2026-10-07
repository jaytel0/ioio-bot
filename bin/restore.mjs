#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const [file, server] = process.argv.slice(2);
if (!file || !server?.startsWith('https://')) throw new Error('Provide an encrypted backup and the canonical HTTPS URL of a fresh recovery Worker');
if (!process.env.BTB_ADMIN_TOKEN || !process.env.BACKUP_ENCRYPTION_KEY) throw new Error('Run through Infisical Apps /btb prod');
const envelope = JSON.parse(await readFile(file, 'utf8'));
if (envelope.format !== 'btb-encrypted-v1') throw new Error('Unknown backup format');
const key = await webcrypto.subtle.importKey('raw', Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex'), 'AES-GCM', false, ['decrypt']);
const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: new TextEncoder().encode('BTB backup v1') }, key, Buffer.from(envelope.ciphertext, 'base64'));
const snapshot = JSON.parse(new TextDecoder().decode(plaintext));
if (snapshot.canonical_url !== server) throw new Error('Recovery must preserve the original canonical URL');
let result;
do {
  const response = await fetch(server + '/admin/restore', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.BTB_ADMIN_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) });
  result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Restore failed; network remains unavailable until recovery completes');
} while (!result.restored);
console.log(JSON.stringify({ restored: true, server }));
