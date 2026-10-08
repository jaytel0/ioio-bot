import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'ioio-media-'));
let assetResponse, video;
before(async () => {
  const output = join(directory, 'assets.mjs');
  await build({ entryPoints: ['src/assets.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, loader: { '.woff2': 'binary', '.svg': 'binary', '.ico': 'binary', '.png': 'binary', '.mp4': 'binary' } });
  ({ assetResponse } = await import(output));
  video = await readFile('src/assets/ioio-og.mp4');
});
after(async () => { await rm(directory, { recursive: true, force: true }); });
const request = (headers = {}, method = 'GET') => new Request('https://ioio.bot/assets/ioio-og.mp4', { method, headers });

test('preview video exposes its type and full length without a HEAD body', async () => {
  const response = assetResponse(request({}, 'HEAD'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-length'), String(video.length));
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});

test('preview players can fetch exact leading, trailing and open-ended video ranges', async () => {
  for (const [range, start, end] of [['bytes=0-31', 0, 31], ['bytes=-16', video.length - 16, video.length - 1], [`bytes=${video.length - 16}-`, video.length - 16, video.length - 1]]) {
    const response = assetResponse(request({ Range: range }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${video.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(start, end + 1));
  }
});

test('unsatisfiable ranges are rejected and unknown If-Range validators get the full file', async () => {
  const bad = assetResponse(request({ Range: `bytes=${video.length}-` }));
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${video.length}`);
  const full = assetResponse(request({ Range: 'bytes=0-31', 'If-Range': '"old-version"' }));
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), video);
});
