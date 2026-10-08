import {CharacterRenderer,prepareCharacters,type Character} from './characters';
prepareCharacters();
const kinds:Character[]=['alfred','felipe','muse','grok','instinct'];
const canvas=document.querySelector('canvas')!;
const c=canvas.getContext('2d')!;
const renderers=kinds.map(()=>{const el=document.createElement('canvas');const renderer=new CharacterRenderer(el);renderer.resize(256);return renderer;});
let time=0,last=0,playing=true;
function frame(now:number){const dt=last?(now-last)/1000:0;last=now;if(playing)time+=Math.min(dt,.05);draw();requestAnimationFrame(frame);}
function draw(){
 c.fillStyle='white';c.fillRect(0,0,canvas.width,canvas.height);
 renderers.forEach((r,i)=>{r.draw(kinds[i],time);c.save();c.beginPath();c.roundRect(24+i*276,20,256,256,60);c.clip();c.drawImage(r.canvas,24+i*276,20,256,256);c.restore();c.fillStyle='#000';c.font='18px sans-serif';c.fillText(kinds[i],24+i*276,307);});
 document.querySelector('output')!.textContent=time.toFixed(2)+' s';
}
document.querySelector('#pause')!.addEventListener('click',()=>{playing=!playing;});
document.querySelector('input')!.addEventListener('input',e=>{time=Number((e.target as HTMLInputElement).value);playing=false;draw();});
document.querySelector('#record')!.addEventListener('click',()=>{
 const button=document.querySelector<HTMLButtonElement>('#record')!;button.disabled=true;time=0;playing=true;
 const stream=canvas.captureStream(30),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks:Blob[]=[];
 recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));a.download='ioio-character-study.webm';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);stream.getTracks().forEach(t=>t.stop());button.disabled=false;};recorder.start();setTimeout(()=>recorder.stop(),10000);
});
requestAnimationFrame(frame);
