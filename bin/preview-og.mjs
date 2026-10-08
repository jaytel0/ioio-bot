// Capture the real homepage renderer as a 15-second social-preview loop.
// The capture-only cue list returns to a static Instinct/letters arrangement,
// so both ends meet cleanly. Production animation logic is untouched.
import {build} from 'esbuild';
import {readFile,mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'ioio-og-'));
await build({entryPoints:['src/ui.ts'],bundle:true,platform:'node',format:'esm',outfile:join(dir,'ui.mjs')});
const {landing}=await import(join(dir,'ui.mjs'));
let source=await readFile('web/landing.ts','utf8');
const edits=[
 ['const initialSlot = Math.floor(Math.random() * slots.length);','const initialSlot = 0;'],
 ["kind: 'grok' as Character","kind: 'instinct' as Character"],
 ['const brand = document.querySelector',`const captureScore = (): {cues: Cue[];duration:number} => ({cues:[[1,2,'grok'],[3,2,null],[4.1,3,'alfred'],[6.1,3,null],[7.2,2,'felipe'],[9.2,2,null],[10.3,3,'muse'],[12.3,3,null]],duration:15});\nconst brand = document.querySelector`],
];
for(const [from,to] of edits){if(!source.includes(from))throw new Error('Homepage capture anchor changed: '+from);source=source.replace(from,to);}
source=source.replaceAll('phrase(currentCast())','captureScore()');
const result=await build({stdin:{contents:source,resolveDir:process.cwd()+'/web',loader:'ts'},bundle:true,write:false,format:'iife',target:'es2022'});
const original=JSON.parse((await readFile('src/generated/landing-script.ts','utf8')).match(/export const landingScript = (.+);/)[1]);
const captureScript=`
window.recordOG=async()=>{
 while(!document.querySelector('.brand-play.is-ready'))await new Promise(r=>requestAnimationFrame(r));
 const output=document.createElement('canvas');output.width=1200;output.height=630;
 const c=output.getContext('2d');
 const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
 const stream=output.captureStream(60),recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6000000}),chunks=[];
 let start=0,frames=0;
 return new Promise(resolve=>{
 recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
 recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());const bytes=new Uint8Array(await new Blob(chunks,{type:mime}).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));resolve({data:btoa(binary),mime,frames,width:1200,height:630});};
 function draw(now){
  const stage=document.querySelector('.brand-play'),stageRect=stage.getBoundingClientRect(),size=parseFloat(getComputedStyle(stage).fontSize);
  const dx=600-(stageRect.left+stageRect.width/2),dy=315-stageRect.top-size*.72;
  c.setTransform(1,0,0,1,0,0);c.fillStyle='#fff';c.fillRect(0,0,1200,630);
  for(const slot of document.querySelectorAll('.brand-slot')){
   const character=slot.dataset.character,el=slot.querySelector(character?'canvas':'.brand-letter'),rect=el.getBoundingClientRect();
   if(character){c.save();if(character==='instinct'){c.beginPath();c.roundRect(rect.left+dx,rect.top+dy,rect.width,rect.height,rect.width*.24);c.clip();}c.drawImage(el,rect.left+dx,rect.top+dy,rect.width,rect.height);c.restore();}
   else{const style=getComputedStyle(el),scale=new DOMMatrix(style.transform).a;c.save();c.translate(rect.left+rect.width/2+dx,rect.top+rect.height/2+dy);c.scale(scale,scale);c.font=style.fontWeight+' '+size+'px '+style.fontFamily;c.textAlign='center';c.fillStyle='#000';const metrics=c.measureText(el.textContent);c.fillText(el.textContent,0,(metrics.fontBoundingBoxAscent-metrics.fontBoundingBoxDescent)/2);c.restore();}
  }
  frames++;if(!start){start=now;recorder.start();}if(now-start>=15000)recorder.stop();else requestAnimationFrame(draw);
 }
 requestAnimationFrame(draw);
 });
};`;
createServer(async(req,res)=>{
 if(req.url==='/assets/InterVariable.woff2'){res.setHeader('Content-Type','font/woff2');res.end(await readFile('src/assets/InterVariable.woff2'));return;}
 const response=landing();let html=await response.text();
 if(!html.includes(original))throw new Error('Generated homepage script changed; rebuild landing before capture');
 const nonce=html.match(/<script nonce="([^"]+)"/)[1];
 html=html.replace(original,result.outputFiles[0].text).replace('</body>',`<script nonce="${nonce}">${captureScript}</script></body>`);
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(html);
}).listen(8810,'127.0.0.1',()=>console.log('OG capture: http://127.0.0.1:8810/ · call recordOG()'));
