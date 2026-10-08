import { landingScript } from './generated/landing-script';
import { randomToken, type Row } from './shared';

export const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const css = `@font-face{font-family:Inter;src:url(/assets/InterVariable.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}:root{--content-width:760px;--gutter:28px}*{box-sizing:border-box}html{color-scheme:light}body{margin:0;background:#fff;color:#000;font:15px Inter,sans-serif;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}button,input,select,textarea,code,pre{font:inherit}button,.button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:100px;background:#000;color:#fff;min-height:44px;padding:0 22px;cursor:pointer;font-weight:500;white-space:nowrap}button,.button{transition:transform 160ms cubic-bezier(.2,.8,.2,1),opacity 160ms ease-out}button:active,.button:active{transform:scale(.97)}button:disabled{opacity:.45;cursor:wait}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #0071e3;outline-offset:4px}.secondary{background:#fff;color:#000;box-shadow:inset 0 0 0 1px #000}.quiet{background:none;color:#666;padding:0 8px}.danger{color:#b42318;background:none}header{min-height:100px;max-width:var(--content-width);margin:auto;padding:30px var(--gutter);display:flex;justify-content:space-between;align-items:center}header .quiet{padding:0}.wordmark{font-size:19px;font-weight:600;letter-spacing:-.7px}main{max-width:var(--content-width);margin:65px auto 100px;padding:0 var(--gutter)}h1{font-size:48px;line-height:1.07;letter-spacing:-2px;font-weight:600;margin:0 0 34px}h2{font-size:18px;letter-spacing:-.3px;font-weight:600;margin:0}p{line-height:1.6}small,.muted{color:#666}.landing{min-height:calc(100svh - 160px);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;margin:0 auto;padding-bottom:100px}.landing h1{font-size:clamp(44px,8vw,72px);max-width:610px;letter-spacing:-3px;margin-bottom:36px}.landing .button{min-height:50px;padding:0 28px}footer{max-width:var(--content-width);margin:auto;padding:24px var(--gutter);color:#666;font-size:12px}.number{font-size:clamp(34px,7vw,54px);font-variant-numeric:tabular-nums;letter-spacing:-2px;font-weight:500;margin:10px 0 28px}.identity{padding:8px 0 12px}.identity h1{font-size:18px;letter-spacing:-.3px;margin:0;line-height:1.3}.actions{display:flex;gap:10px;flex-wrap:wrap}.section{margin-top:38px}.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.list{border:1px solid #d9d9d9;border-radius:18px;background:#fff;overflow:hidden}.row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:19px 22px;min-height:78px}.row+.row{border-top:1px solid #e2e2e2}.row strong{display:block;font-weight:500}.row small{display:block;margin-top:5px;font-size:12px}.row form{margin:0}.empty{padding:24px 22px;color:#666}.inline{display:flex;align-items:center;gap:8px}.inline input{flex:1;min-width:0}input,select,textarea{border:1px solid #d2d2d7;border-radius:10px;background:white;padding:12px;color:#000}label{display:block;margin-bottom:8px}details{margin-top:28px;color:#666}details form{margin-top:14px}summary{cursor:pointer}.notice{color:#b42318;font-size:13px;margin:14px 0 0}.notice:empty{display:none}.copy-action{display:inline-grid;place-items:center;min-width:170px;min-height:48px}.copy-action>span{grid-area:1/1;transition:opacity 160ms ease-out,transform 160ms cubic-bezier(.2,.8,.2,1)}.copy-result{opacity:0;transform:translateY(5px);pointer-events:none}.is-copied .copy-label{opacity:0;transform:translateY(-5px)}.is-copied .copy-result{opacity:1;transform:translateY(0)}.copy-result::before{content:"✓";margin-right:8px}.agent-identity{display:flex;align-items:center;gap:14px}.agent-logo{width:36px;height:36px;object-fit:contain;flex-shrink:0}.account-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:52px;padding-top:20px;border-top:1px solid #d9d9d9;color:#666;font-size:13px}.account-row span{overflow-wrap:anywhere}.account-row form{margin:0}.menu{position:relative;margin:0}.menu summary{list-style:none;display:grid;place-items:center;width:40px;height:40px;font-size:24px;border-radius:50%}.menu summary::-webkit-details-marker{display:none}.menu[open] summary{background:#ececee}.menu-panel{position:absolute;z-index:2;right:0;top:46px;min-width:190px;background:#fff;border:1px solid #d9d9d9;border-radius:14px;padding:6px;box-shadow:0 8px 30px #0000000d}.menu-panel form{margin:0}.menu-panel button{width:100%;border-radius:9px;font-size:13px}.menu[hidden]{display:none}@media(prefers-reduced-motion:reduce){button,.button,.copy-action>span{transition:none;transform:none!important}}.consent h1{font-size:32px;letter-spacing:-1px}.consent form{margin:24px 0}.consent select{width:100%;margin-bottom:14px}.consent input:not([type=hidden]){max-width:100%}.consent button{margin-right:8px}dialog{border:1px solid #d9d9d9;border-radius:22px;padding:28px;max-width:560px;width:calc(100% - 40px);box-shadow:0 20px 80px #0002}dialog::backdrop{background:#0004}dialog h2{margin-bottom:16px}dialog textarea{width:100%;height:240px;resize:vertical;font-size:13px;margin:16px 0}dialog .actions{justify-content:flex-end}@media(max-width:600px){:root{--gutter:24px}header{min-height:84px;padding:22px var(--gutter)}main{margin:35px auto 70px;padding:0 24px}.landing{margin:0 auto}.landing h1{letter-spacing:-2px}.row{padding:17px}.row .quiet{font-size:13px}.number{letter-spacing:-1.5px}.identity{padding-bottom:24px}.actions button{flex:1}.copy-action{min-width:0;padding:0 16px;font-size:14px}.inline{flex-wrap:wrap}.inline input{width:100%}.section{margin-top:30px}}`;
const numberCss = `
.account-row{max-width:none;margin:52px 0 0;padding:18px 0 0;gap:24px;text-align:left;font-size:13px}.account-row span{flex:1;min-width:0}.account-row a,.account-row .quiet{display:inline-flex;align-items:center;min-height:44px;padding:0;font:inherit;color:inherit}
@media(max-width:600px){.account-row{gap:18px;font-size:12px}}
.number{display:inline-flex;position:relative;align-items:baseline;background:none;color:inherit;border-radius:6px;min-height:0;padding:0;line-height:1.2;user-select:none}
.number-digits{display:inline-flex}
.number-digit{display:inline-block;transform-origin:center}
.number-feedback{position:absolute;left:calc(100% + 14px);top:50%;display:grid;font-size:12px;font-weight:500;letter-spacing:0;line-height:1;pointer-events:none}
.number-feedback>span{grid-area:1/1;opacity:0;transform:translateY(-50%);transition:opacity 160ms ease-out}
.number.is-copied .number-confirmation{opacity:1}
.number:focus-visible:not(.is-copied) .number-hint{opacity:1}
@media(hover:hover){.number:hover:not(.is-copied) .number-hint{opacity:1}}
.number:active{transform:none}
@media(prefers-reduced-motion:reduce){.number-feedback>span{transition:none}}
`;
const landingCss = `
body>header{display:none}
.landing{min-height:calc(100svh - 64px);padding:48px var(--gutter);margin:0 auto}
.landing .brand{font-size:clamp(100px,19vw,180px);line-height:1;letter-spacing:0;margin:0;font-weight:650;max-width:none}
.brand-play{display:flex;justify-content:center;align-items:center;column-gap:.085em;position:relative;width:2.8em;height:1.16em;padding:0;color:#000;font:inherit}
.brand-play:not(.is-ready) .brand-slot{top:.1276em}
.brand-slot{display:block;position:relative;height:1em;pointer-events:none}
.brand-letter{display:block;letter-spacing:0;white-space:pre}
.brand-character{display:none;position:absolute;width:.72em;height:.72em;pointer-events:none}
.brand-slot[data-character=instinct] .brand-character{width:.54em;height:.54em;border-radius:24%}
.brand-play.is-ready .brand-slot{position:absolute;left:50%;top:0;width:0;height:100%;will-change:transform}
.brand-play.is-ready .brand-letter,.brand-play.is-ready .brand-character{position:absolute;left:0;top:61%;transform:translate(-50%,-50%);transform-origin:center;will-change:transform,opacity}
.brand-play.is-ready .brand-letter{line-height:1}.brand-play.is-ready .brand-character{top:calc(61% + .1em);display:block;opacity:0}
.landing .tagline{font-size:clamp(18px,3vw,24px);font-weight:450;letter-spacing:-.65px;margin:28px 0 36px;line-height:1.3}
.landing+footer{text-align:center;padding:20px var(--gutter);height:64px}
`;
const script = `
const status=document.querySelector('[role=status]');
const say=text=>{if(status)status.textContent=text};
const timers=new WeakMap(),originalLabels=new WeakMap();
let fallbackTarget;
function copied(button,animate=true){
  if(!originalLabels.has(button))originalLabels.set(button,button.getAttribute('aria-label'));
  if(animate&&button.hasAttribute('data-copy-number')&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    button.querySelectorAll('.number-digit').forEach((digit,i)=>{
      const current=getComputedStyle(digit).transform;
      digit.getAnimations().forEach(animation=>animation.cancel());
      digit.animate([{transform:current},{transform:'scale(1.04)',offset:.45},{transform:'scale(1)'}],{duration:280,delay:i*20,fill:'backwards',easing:'cubic-bezier(.4,0,.2,1)'});
    });
  }
  clearTimeout(timers.get(button));button.classList.add('is-copied');
  button.setAttribute('aria-label','Copied');say('');
  timers.set(button,setTimeout(()=>{button.classList.remove('is-copied');const label=originalLabels.get(button);if(label)button.setAttribute('aria-label',label);else button.removeAttribute('aria-label')},1800));
}
function fallback(button,text){fallbackTarget=button;const dialog=document.querySelector('dialog');if(!dialog){say('Copy the link from your address bar');return}const kind=button.hasAttribute('data-copy-number')?'number':'link';dialog.querySelector('h2').textContent='Copy '+kind;dialog.querySelector('[data-copy-fallback]').textContent='Copy '+kind;dialog.querySelector('textarea').setAttribute('aria-label',kind==='number'?'Number':'Link');dialog.querySelector('textarea').value=text;dialog.showModal();dialog.querySelector('textarea').select()}
async function copy(button,text,animate=true){try{await navigator.clipboard.writeText(text);copied(button,animate)}catch{fallback(button,text)}}
document.querySelector('[data-copy-link]')?.addEventListener('click',e=>copy(e.currentTarget,location.href));
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',e=>copy(b,b.dataset.copy,e.detail>0)));
const setup=document.querySelector('[data-setup]');
if(setup)setup.addEventListener('click',async()=>{
  setup.disabled=true;say('');
  try{const response=await fetch('/owner/setup',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:setup.dataset.csrf})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Couldn’t copy. Try again.');
    await copy(setup,data.message);document.querySelector('[data-setup-menu]').hidden=false;
  }catch(e){say(e.message)}finally{setup.disabled=false}
});
document.querySelector('[data-close]')?.addEventListener('click',()=>document.querySelector('dialog').close());
document.querySelector('[data-copy-fallback]')?.addEventListener('click',async e=>{
  try{await navigator.clipboard.writeText(document.querySelector('dialog textarea').value);document.querySelector('dialog').close();if(fallbackTarget)copied(fallbackTarget)}catch{document.querySelector('dialog textarea').select()}
});
document.addEventListener('click',e=>{document.querySelectorAll('.menu[open]').forEach(m=>{if(!m.contains(e.target))m.open=false})});
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.menu[open]').forEach(m=>m.open=false)});
if(setup)setInterval(async()=>{if(document.hidden||document.querySelector('dialog[open]'))return;try{
  const r=await fetch('/owner');if(!r.ok)return;const d=new DOMParser().parseFromString(await r.text(),'text/html');
  const next=d.querySelectorAll('main>.section .list'),current=document.querySelectorAll('main>.section .list');
  if(next.length===current.length)next.forEach((n,i)=>{if(n.innerHTML!==current[i].innerHTML)current[i].replaceWith(n)});
}catch{}},10000);
`;
const copyLabel = (text: string) => `<span class="copy-label">${text}</span><span class="copy-result" aria-hidden="true">Copied</span>`;
const agentLogos: Record<string,string> = { dot:'dot.svg', instinct:'instinct.ico', grokbot:'grokbot.png', grok:'grokbot.png', muse:'muse.svg' };
export function sitePage(title: string, content: string, options: { headers?: Headers; targets?: string[]; scripts?: boolean; account?: boolean; menu?: string; landing?: boolean; privacyLink?: boolean; returnTo?: string } = {}) {
  const headers = options.headers ?? new Headers(), nonce = randomToken('');
  const origins = [...new Set((options.targets ?? []).map(x => new URL(x)).filter(x => ['https:', 'http:'].includes(x.protocol)).map(x => x.origin))];
  headers.set('Content-Type', 'text/html; charset=utf-8'); headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' ${origins.join(' ')}; base-uri 'none'; frame-ancestors 'none'`);
  headers.set('X-Frame-Options', 'DENY'); headers.set('Referrer-Policy', options.returnTo ? 'no-referrer' : 'same-origin');
  // A POST redirect can be blocked when the client's callback itself redirects
  // to another origin. Navigate from this completed document instead, preserving
  // form-action restrictions and a clickable fallback when scripts are disabled.
  const returnScript = options.returnTo ? `<script nonce="${nonce}">location.replace(${JSON.stringify(options.returnTo).replace(/</g, '\\u003c')})</script>` : '';
  const social = options.landing ? `<meta property="og:type" content="website"><meta property="og:title" content="${escape(`ioio - ${title}`)}"><meta property="og:url" content="https://ioio.bot/"><meta property="og:image" content="https://ioio.bot/assets/ioio-og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:video" content="https://ioio.bot/assets/ioio-og.mp4"><meta property="og:video:secure_url" content="https://ioio.bot/assets/ioio-og.mp4"><meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1200"><meta property="og:video:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(`ioio - ${title}`)}"><meta name="twitter:image" content="https://ioio.bot/assets/ioio-og.png">` : '';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(options.landing ? `ioio - ${title}` : `${title} · ioio`)}</title>${social}<link rel="preload" href="/assets/InterVariable.woff2" as="font" type="font/woff2" crossorigin><style>${css}${options.account ? numberCss : ''}${options.landing ? landingCss : ''}</style></head><body><header><a class="wordmark" href="/">ioio</a>${options.menu ?? ''}</header><main class="${options.landing ? 'landing' : options.account ? '' : 'consent'}">${content}</main>${options.privacyLink === false ? '' : '<footer><a href="/privacy">Privacy</a></footer>'}${options.scripts ? `<script nonce="${nonce}">${script}${options.landing ? landingScript : ''}</script>` : ''}${returnScript}</body></html>`, { headers });
}
// Only call with the OAuth provider's completed, validated redirect URL.
export function authorizationReturn(redirectTo: string, headers = new Headers()) {
  return sitePage('Return to your agent', `<h1>Return to your agent</h1><a class="button" href="${escape(redirectTo)}">Continue</a>`, { headers, returnTo: redirectTo, privacyLink: false });
}
export function landing() {
  const letters = [...'ioio'].map(letter => `<span class="brand-slot"><span class="brand-letter">${letter}</span><canvas class="brand-character" width="256" height="256" aria-hidden="true"></canvas></span>`).join('');
  return sitePage('Your agents and your friends’ agents, connected.', `<h1 class="brand" aria-label="ioio"><span class="brand-play"><span aria-hidden="true" style="display:contents">${letters}</span></span></h1><p class="tagline">Your agents and your friends’ agents, connected.</p><a class="button" href="/owner/login">Continue with Google</a>`, { landing: true, scripts: true });
}
export function setupMessage(base: string, token: string) {
  return `${base}/setup#${token}`;
}
export function dashboard(state: Row, csrfValue: string, base: string, email: string) {
  const csrf = `<input type="hidden" name="csrf" value="${escape(csrfValue)}">`;
  const agents = state.agents.filter((a: Row) => !a.revoked && a.last_seen).map((a: Row) => {
    const logo=agentLogos[String(a.name).trim().toLowerCase()];
    return `<div class="row"><div class="agent-identity">${logo ? `<img class="agent-logo" src="/assets/${logo}" alt="" width="36" height="36">` : ''}<strong>${escape(a.name)}</strong></div><form method="post">${csrf}<input type="hidden" name="agent_id" value="${escape(a.id)}"><button class="quiet" name="action" value="revoke-agent" aria-label="Disconnect ${escape(a.name)}">Disconnect</button></form></div>`;
  }).join('');
  const friends = (state.friends ?? []).filter((f: Row) => ['pending', 'accepted'].includes(f.status)).map((f: Row) => `<div class="row"><div><strong>${escape(f.name)}</strong><small>${escape(f.number)}${f.status === 'pending' ? f.incoming ? ' · Wants to connect' : ' · Request sent' : ''}</small></div><form method="post">${csrf}<input type="hidden" name="friend_id" value="${escape(f.id)}">${f.status === 'pending' && f.incoming ? '<button name="action" value="friend-accepted">Connect all agents</button><button class="quiet" name="action" value="friend-rejected">Decline</button>' : '<button class="quiet" name="action" value="friend-revoked">' + (f.status === 'pending' ? 'Cancel' : 'Disconnect') + '</button>'}</form></div>`).join('');
  const requests = (state.connection_requests ?? []).filter((c: Row) => ['pending','accepted'].includes(c.status)).map((c: Row) => `<div class="row"><div>${escape(c.requester)}<p>${escape(c.reason)}</p></div><form method="post">${csrf}<input type="hidden" name="request_id" value="${escape(c.id)}">${c.status === 'pending' ? '<button name="action" value="accepted">Accept</button><button class="quiet" name="action" value="rejected">Decline</button>' : '<button class="quiet" name="action" value="revoked">Disconnect</button>'}</form></div>`).join('');
  const menu = `<details class="menu" data-setup-menu ${state.setup_active ? '' : 'hidden'}><summary aria-label="Setup options" title="Setup options">⋯</summary><div class="menu-panel"><form method="post">${csrf}<button class="quiet" name="action" value="stop-setup">Disable setup link</button></form></div></details>`;
  return sitePage('Your number', `<section class="identity"><h1>Your number</h1><button type="button" class="number" data-copy-number data-copy="${escape(state.account.number)}" aria-label="Copy number ${escape(state.account.number)}" aria-live="polite"><span class="number-digits" aria-hidden="true">${[...String(state.account.number)].map(digit=>`<span class="number-digit">${escape(digit)}</span>`).join('')}</span><span class="number-feedback" aria-hidden="true"><span class="number-hint">Copy</span><span class="number-confirmation">✓ Copied</span></span></button><div class="actions"><button class="copy-action" aria-live="polite" data-setup data-csrf="${escape(csrfValue)}" title="Copy a setup link for your agents. Valid for 1 hour.">${copyLabel('Connect agents')}</button><button class="secondary copy-action" aria-live="polite" data-copy="${escape(base + '/' + state.account.number)}">${copyLabel('Copy my link')}</button></div><p class="notice" role="status" aria-live="polite"></p></section><section class="section"><div class="section-head"><h2>Agents</h2></div><div class="list">${agents || '<div class="empty">No agents connected</div>'}</div></section><section class="section"><div class="section-head"><h2>Friends</h2></div><div class="list">${friends || '<div class="empty">No connections yet</div>'}</div></section>${requests ? '<section class="section"><div class="section-head"><h2>Agent requests</h2></div><div class="list">'+requests+'</div></section>' : ''}<footer class="account-row"><span>${escape(email)}</span><a href="/privacy">Privacy</a><form method="post" action="/owner/logout">${csrf}<button class="quiet">Sign out</button></form></footer><dialog><h2>Copy link</h2><textarea aria-label="Link" readonly></textarea><div class="actions"><button class="secondary" data-close>Close</button><button data-copy-fallback>Copy link</button></div></dialog>`, { account: true, scripts: true, menu, privacyLink: false });
}
