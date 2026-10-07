import { equal, now, requireThat, type Env, type Row } from './shared';

const bytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const base64 = (value: Uint8Array) => { let result = ''; for (const byte of value) result += String.fromCharCode(byte); return btoa(result); };
async function encryptionKey(secret: string) {
  requireThat(/^[a-f0-9]{64}$/.test(secret), 503, 'Backup encryption key missing');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, x => parseInt(x, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealBackup(snapshot: Row, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12)), key = await encryptionKey(secret);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('BTB backup v1') }, key, new TextEncoder().encode(JSON.stringify(snapshot)));
  return { format: 'btb-encrypted-v1', iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
export async function openBackup(envelope: Row, secret: string) {
  requireThat(envelope.format === 'btb-encrypted-v1', 400, 'Unknown backup format');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: new TextEncoder().encode('BTB backup v1') }, await encryptionKey(secret), bytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Row;
}
export async function createBackup(env: Env) {
  requireThat(env.BTB_ADMIN_TOKEN, 503, 'Owner secret missing');
  const response = await env.HUB.get(env.HUB.idFromName('btb-hub-v1')).fetch(new Request(env.BTB_BASE_URL + '/admin/export', { headers: { Authorization: 'Bearer ' + env.BTB_ADMIN_TOKEN } }));
  requireThat(response.ok, 503, 'Database backup failed');
  const snapshot = await response.json() as Row, oauth: Row[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.OAUTH_KV.list({ cursor, limit: 40 });
    const values = await Promise.all(list.keys.filter(k => /^(client|grant|token):/.test(k.name)).map(async key => {
      const value = await env.OAUTH_KV.get(key.name); requireThat(value !== null, 503, 'OAuth state changed during backup; retry');
      return { key: key.name, value, expiration: key.expiration ?? null, metadata: key.metadata ?? null };
    }));
    oauth.push(...values); cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  const exported_at = now(), payload = { ...snapshot, exported_at, oauth };
  requireThat(new TextEncoder().encode(JSON.stringify(payload)).length <= 8 * 1024 * 1024, 503, 'Backup exceeds the current 8 MiB restore limit; expand recovery before continuing');
  const envelope = await sealBackup(payload, env.BACKUP_ENCRYPTION_KEY);
  const key = 'btb/' + exported_at.replace(/:/g, '-') + '.json', encoded = JSON.stringify(envelope);
  await env.BACKUPS.put(key, encoded, { httpMetadata: { contentType: 'application/json' } });
  const stored = await env.BACKUPS.get(key); requireThat(stored && equal(await stored.text(), encoded), 503, 'Backup storage verification failed');
  await env.OAUTH_KV.put('backup-status', JSON.stringify({ key, exported_at, status: 'ok' }));
  console.log(JSON.stringify({ event: 'backup_success', key, bytes: encoded.length }));
  return { key, exported_at, encrypted: true, verified: true };
}
export async function restoreBackup(env: Env, snapshot: Row) {
  requireThat(snapshot.version === 2 && snapshot.canonical_url === env.BTB_BASE_URL && Array.isArray(snapshot.oauth), 400, 'Invalid backup or canonical URL');
  requireThat(snapshot.oauth.every((row: Row) => typeof row.key === 'string' && /^(client|grant|token):/.test(row.key) && row.key.length < 1024 && typeof row.value === 'string' && row.value.length < 128000 && (row.expiration === null || Number.isInteger(row.expiration))), 400, 'Invalid OAuth backup');
  const hub = env.HUB.get(env.HUB.idFromName('btb-hub-v1'));
  const started = await hub.fetch(new Request(env.BTB_BASE_URL + '/admin/restore', { method: 'POST', headers: { Authorization: 'Bearer ' + env.BTB_ADMIN_TOKEN }, body: JSON.stringify(snapshot) }));
  if (!started.ok) return started;
  const progress = await started.json() as Row;
  if (progress.restored) return Response.json({ restored: true });
  const end = Math.min(snapshot.oauth.length, progress.cursor + 15);
  for (const row of snapshot.oauth.slice(progress.cursor, end)) {
    if (row.expiration !== null && row.expiration <= Date.now() / 1000) continue;
    const existing = await env.OAUTH_KV.get(row.key);
    requireThat(existing === null || existing === row.value, 409, 'OAuth namespace contains different credentials; use a fresh namespace');
    if (existing === null) await env.OAUTH_KV.put(row.key, row.value, { ...(row.expiration ? { expiration: row.expiration } : {}), ...(row.metadata ? { metadata: row.metadata } : {}) });
  }
  const complete = end === snapshot.oauth.length;
  await (hub as any).checkpointRestore(progress.digest, progress.cursor, end, complete);
  return Response.json({ restored: complete, remaining: snapshot.oauth.length - end });
}
