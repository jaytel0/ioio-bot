import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
const directory = await mkdtemp(join(tmpdir(), 'btb-security-'));
let verifyGoogleIdentity, sealBackup, openBackup, readLimitedText, createBackup, authorizationReturn;
before(async () => {
  const file = join(directory, 'security.mjs');
  await build({ stdin: { contents: "export { verifyGoogleIdentity } from './src/google'; export { sealBackup, openBackup, createBackup } from './src/recovery'; export { readLimitedText } from './src/shared'; export { authorizationReturn } from './src/ui';", resolveDir: process.cwd() }, outfile: file, bundle: true, platform: 'node', format: 'esm' });
  ({ verifyGoogleIdentity, sealBackup, openBackup, readLimitedText, createBackup, authorizationReturn } = await import(file));
});
after(() => rm(directory, { recursive: true, force: true }));
test('OAuth return navigates the exact approved callback without widening form permissions or leaking referrers', async () => {
  const target = 'https://client.example/callback?code=fixture&state=</script><script>bad()</script>';
  const response = authorizationReturn(target, new Headers({ 'Set-Cookie': 'fixture=; Max-Age=0' }));
  const html = await response.text(), csp = response.headers.get('content-security-policy');
  assert.equal(response.status, 200); assert.equal(response.headers.get('location'), null);
  assert(csp.includes("form-action 'self'")); assert(!csp.includes('client.example'));
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), 'fixture=; Max-Age=0');
  assert(!html.includes('</script><script>bad()'));
  const [, nonce, script] = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert(csp.includes(`'nonce-${nonce}'`));
  let destination; runInNewContext(script, { location: { replace: value => { destination = value; } } });
  assert.equal(destination, target);
  assert(html.includes('href="https://client.example/callback?code=fixture&#38;state=&#60;/script&#62;'));
});
test('Google sign-in rejects wrong signatures, audience, nonce, issuer, expiration and unverified email', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256'), jwk = await exportJWK(publicKey);
  jwk.kid = 'test'; const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (changes = {}, key = privateKey) => new SignJWT({ sub: 'google-user', email: 'owner@example.com', email_verified: true, nonce: 'nonce', iss: 'https://accounts.google.com', aud: 'google-client', exp: Math.floor(Date.now()/1000)+300, ...changes }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
  assert.deepEqual(await verifyGoogleIdentity(await sign(), 'google-client', 'nonce', keys), { subject: 'google-user', email: 'owner@example.com' });
  for (const changes of [{ aud: 'other' }, { nonce: 'other' }, { iss: 'https://evil.invalid' }, { email_verified: false }, { exp: 1 }]) await assert.rejects(() => sign(changes).then(token => verifyGoogleIdentity(token, 'google-client', 'nonce', keys)));
  const attacker = await generateKeyPair('RS256');
  await assert.rejects(() => sign({}, attacker.privateKey).then(token => verifyGoogleIdentity(token, 'google-client', 'nonce', keys)));
});
test('encrypted backups reject a wrong key and modified ciphertext', async () => {
  const snapshot = { private: 'message history', version: 2 }, secret = '02'.repeat(32), encrypted = await sealBackup(snapshot, secret);
  assert(!JSON.stringify(encrypted).includes(snapshot.private));
  assert.deepEqual(await openBackup(encrypted, secret), snapshot);
  await assert.rejects(() => openBackup(encrypted, '03'.repeat(32)));
  const modified = { ...encrypted, ciphertext: 'AAAA' + encrypted.ciphertext.slice(4) };
  await assert.rejects(() => openBackup(modified, secret));
});
test('chunked requests without content-length are bounded before parsing', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(() => readLimitedText(new Request('https://btb.example', { method: 'POST', body: stream, duplex: 'half' }), 2048), /too large/);
  assert.equal(cancelled, true);
});

test('backup creation refuses snapshots larger than the supported restore size', async () => {
  let stored = false;
  const env = { BTB_ADMIN_TOKEN: 'fixture-owner', BTB_BASE_URL: 'https://btb.example.com', HUB: { idFromName: () => 'fixture', get: () => ({ fetch: async () => Response.json({ tables: { messages: [{ text: 'x'.repeat(8*1024*1024) }] } }) }) }, OAUTH_KV: { list: async () => ({ keys: [], list_complete: true }) }, BACKUPS: { put: async () => { stored = true; } } };
  await assert.rejects(() => createBackup(env), /8 MiB restore limit/);
  assert.equal(stored, false);
});
