import inter from './assets/InterVariable.woff2';
import dot from './assets/dot.svg';
import instinct from './assets/instinct.ico';
import grokbot from './assets/grokbot.png';
import muse from './assets/muse.svg';
import heroGrok from './assets/landing/grok.svg';
import heroInstinct from './assets/landing/instinct.svg';
import heroMuse from './assets/landing/muse.svg';
import heroDotYellow from './assets/landing/dot-yellow.svg';
import heroDotBlue from './assets/landing/dot-blue.svg';

const assets: Record<string, [ArrayBuffer, string]> = {
  '/assets/landing/grok.svg': [heroGrok, 'image/svg+xml'],
  '/assets/landing/instinct.svg': [heroInstinct, 'image/svg+xml'],
  '/assets/landing/muse.svg': [heroMuse, 'image/svg+xml'],
  '/assets/landing/dot-yellow.svg': [heroDotYellow, 'image/svg+xml'],
  '/assets/landing/dot-blue.svg': [heroDotBlue, 'image/svg+xml'],
  '/assets/InterVariable.woff2': [inter, 'font/woff2'],
  '/assets/dot.svg': [dot, 'image/svg+xml'],
  '/assets/instinct.ico': [instinct, 'image/x-icon'],
  '/assets/grokbot.png': [grokbot, 'image/png'],
  '/assets/muse.svg': [muse, 'image/svg+xml'],
};

export function assetResponse(request: Request) {
  const asset = assets[new URL(request.url).pathname];
  if (!asset) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  return new Response(request.method === 'HEAD' ? null : asset[0], { headers: {
    'Content-Type': asset[1], 'Cache-Control': 'public, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; img-src data:; sandbox",
  } });
}
