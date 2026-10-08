import inter from './assets/InterVariable.woff2';
import dot from './assets/dot.svg';
import instinct from './assets/instinct.ico';
import grokbot from './assets/grokbot.png';
import muse from './assets/muse.svg';
import ogVideo from './assets/ioio-og.mp4';
import ogWordmark from './assets/ioio-og-wordmark.png';
import googleG from './assets/google-g.svg';

const assets: Record<string, [ArrayBuffer, string]> = {
  '/assets/InterVariable.woff2': [inter, 'font/woff2'],
  '/assets/dot.svg': [dot, 'image/svg+xml'],
  '/assets/instinct.ico': [instinct, 'image/x-icon'],
  '/assets/grokbot.png': [grokbot, 'image/png'],
  '/assets/muse.svg': [muse, 'image/svg+xml'],
  '/assets/ioio-og.mp4': [ogVideo, 'video/mp4'],
  '/assets/ioio-og.png': [ogWordmark, 'image/png'],
  '/assets/ioio-og-wordmark.png': [ogWordmark, 'image/png'],
  '/assets/google-g.svg': [googleG, 'image/svg+xml'],
};

export function assetResponse(request: Request) {
  const asset = assets[new URL(request.url).pathname];
  if (!asset) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const headers = new Headers({
    'Content-Type': asset[1], 'Cache-Control': 'public, max-age=86400',
    'Content-Length': String(asset[0].byteLength),
    // Native video documents make an anonymous media request. Preserve their
    // origin so the existing origin gate accepts it; scripts remain blocked.
    'Content-Security-Policy': asset[1] === 'video/mp4' ? "default-src 'none'; media-src 'self'; sandbox allow-same-origin" : "default-src 'none'; img-src data:; sandbox",
  });
  if (asset[1] === 'video/mp4') {
    headers.set('Accept-Ranges', 'bytes');
    const range = request.method === 'GET' && !request.headers.has('If-Range') ? request.headers.get('Range')?.match(/^bytes=(\d*)-(\d*)$/) : undefined;
    if (range && (range[1] || range[2])) {
      const length = asset[0].byteLength;
      const start = range[1] ? Number(range[1]) : Math.max(0, length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), length - 1) : length - 1;
      if (start >= length || end < start) {
        headers.set('Content-Range', `bytes */${length}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${length}`);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(asset[0].slice(start, end + 1), { status: 206, headers });
    }
  }
  return new Response(request.method === 'HEAD' ? null : asset[0], { headers });
}
