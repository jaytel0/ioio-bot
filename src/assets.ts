import inter from './assets/InterVariable.woff2';
import dot from './assets/dot.svg';
import instinct from './assets/instinct.ico';
import grokbot from './assets/grokbot.png';
import muse from './assets/muse.svg';
import ogVideo from './assets/ioio-og.mp4';
import ogPoster from './assets/ioio-og.png';
import googleG from './assets/google-g.svg';

const assets: Record<string, [ArrayBuffer, string]> = {
  '/assets/InterVariable.woff2': [inter, 'font/woff2'],
  '/assets/dot.svg': [dot, 'image/svg+xml'],
  '/assets/instinct.ico': [instinct, 'image/x-icon'],
  '/assets/grokbot.png': [grokbot, 'image/png'],
  '/assets/muse.svg': [muse, 'image/svg+xml'],
  '/assets/ioio-og.mp4': [ogVideo, 'video/mp4'],
  '/assets/ioio-og.png': [ogPoster, 'image/png'],
  '/assets/google-g.svg': [googleG, 'image/svg+xml'],
};

export function assetResponse(request: Request) {
  const asset = assets[new URL(request.url).pathname];
  if (!asset) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  return new Response(request.method === 'HEAD' ? null : asset[0], { headers: {
    'Content-Type': asset[1], 'Cache-Control': 'public, max-age=86400',
    // Native video documents make an anonymous media request. Preserve their
    // origin so the existing origin gate accepts it; scripts remain blocked.
    'Content-Security-Policy': asset[1] === 'video/mp4' ? "default-src 'none'; media-src 'self'; sandbox allow-same-origin" : "default-src 'none'; img-src data:; sandbox",
  } });
}
