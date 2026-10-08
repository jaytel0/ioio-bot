// Local-only review surface. This file and /study are never routed by the Worker.
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'ioio-review-'));
await build({entryPoints:['src/ui.ts'],bundle:true,platform:'node',format:'esm',outfile:join(dir,'ui.mjs')});
const {landing}=await import(join(dir,'ui.mjs'));
const study=await build({entryPoints:['web/study.ts'],bundle:true,write:false,target:'es2022',format:'iife'});
const verify=await build({entryPoints:['web/verify.ts'],bundle:true,write:false,target:'es2022',format:'iife'});
const studyHtml=`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ioio · character study</title><style>body{font:15px sans-serif;margin:32px;background:white}canvas{display:block;width:100%;max-width:1400px}button{padding:12px;margin:10px 8px 0 0}input{width:320px}output{margin:16px}</style><canvas width="1400" height="330"></canvas><button id="pause">Pause / play</button><button id="record">Record 10 seconds</button><input aria-label="Animation time" type="range" min="0" max="10" step=".01" value="0"><output></output><script>${study.outputFiles[0].text}</script></html>`;
createServer(async(req,res)=>{try{if(req.url?.startsWith('/study')){res.setHeader('Content-Type','text/html');res.end(studyHtml);}else if(req.url==='/assets/google-g.svg'){res.setHeader('Content-Type','image/svg+xml');res.end(await readFile('src/assets/google-g.svg'));}else if(req.url==='/assets/InterVariable.woff2'){res.setHeader('Content-Type','font/woff2');res.end(await readFile('src/assets/InterVariable.woff2'));}else{const response=landing();res.writeHead(response.status,Object.fromEntries(response.headers));let html=await response.text();if(req.url?.startsWith('/verify')){const nonce=html.match(/<script nonce="([^"]+)"/)[1];html=html.replace('</body>',`<script nonce="${nonce}">${verify.outputFiles[0].text}</script></body>`);}res.end(html);}}catch(error){res.writeHead(500);res.end(String(error));}}).listen(8800,'127.0.0.1',()=>console.log('ioio preview: http://127.0.0.1:8800 · character study: /study'));
