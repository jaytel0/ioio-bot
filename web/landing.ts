/*! Grok's measured animation engine: Copyright (c) 2026 Jérémy Perret, MIT. See web/vendor/bloub/LICENSE. Other character rendering is an independent reference-based recreation. */
import { CharacterRenderer, prepareCharacters, type Character } from './characters';

const brand=document.querySelector<HTMLButtonElement>('.brand-play');
if(brand)start(brand);
function start(brand:HTMLButtonElement){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const slots=[...brand.querySelectorAll<HTMLElement>('.brand-slot')];
 const letters=slots.map(s=>s.querySelector<HTMLElement>('.brand-letter')!);
 const canvases=slots.map(s=>s.querySelector<HTMLCanvasElement>('canvas')!);
 if(canvases.some(c=>!c.getContext('2d')))return;
 const renderers=canvases.map(c=>new CharacterRenderer(c));
 const states=slots.map(()=>({value:0,velocity:0,target:0,kind:'grok' as Character,since:0}));
 // A scored sequence: little conversations, quick interruptions, long readable rests.
 // Time and all character motion share one clock, so pause really freezes the scene.
 const score:[number,number,Character|null][]=[
  [1.8,1,'grok'],[2.46,0,'alfred'],[2.72,1,null],[3.08,2,'instinct'],
  [4.22,0,null],[4.62,2,null],
  [6.5,3,'muse'],[6.84,1,'felipe'],[8.9,1,null],[9.22,3,null],
  [10.7,0,'grok'],[10.89,1,'alfred'],[11.12,2,'muse'],[11.32,3,'instinct'],
  [13.5,0,null],[13.66,2,null],[13.84,1,null],[14.01,3,null],
 ];
 const duration=17.3;
 let prepared=false,ready=false,paused=false,raf=0,last=0,clock=0,beat=0,cycle=0,size=180;
 let widths=[.21,.54,.21,.54];
 const canRun=()=>ready&&!paused&&!reduced.matches&&!document.hidden;
 const clamp=(x:number)=>Math.max(0,Math.min(1,x));
 function measure(){
  size=parseFloat(getComputedStyle(brand).fontSize);
  widths=letters.map(letter=>parseFloat(getComputedStyle(letter).width)/size);
  renderers.forEach(r=>r.resize(size*.6));
  layout(0);
 }
 function layout(dt:number){
  // Semi-implicit integration in small steps is stable after slow or missed frames.
  const steps=Math.max(1,Math.ceil(dt/.008)),h=dt/steps;
  for(const state of states)for(let i=0;i<steps;i++){
   state.velocity+=(240*(state.target-state.value)-25*state.velocity)*h;
   state.value+=state.velocity*h;
   if(Math.abs(state.value-state.target)<.0001&&Math.abs(state.velocity)<.001){state.value=state.target;state.velocity=0;}
  }
  const advances=states.map((s,i)=>widths[i]+(.665-widths[i])*s.value);
  const total=advances.reduce((a,b)=>a+b,0);let x=-total/2;
  states.forEach((s,i)=>{
   const p=clamp(s.value),letterOpacity=1-clamp(p*2.8),tileOpacity=clamp((p-.15)*2.9);
   slots[i].style.transform=`translate3d(${((x+advances[i]/2)*size).toFixed(3)}px,0,0)`;
   // Letter and tile exchange at the same optical centre, in a short squash.
   letters[i].style.opacity=String(letterOpacity);
   letters[i].style.transform=`translate(-50%,-50%) scale(${1-p*.32},${1-p*.53})`;
   canvases[i].style.opacity=String(tileOpacity);
   canvases[i].style.transform=`translate(-50%,-50%) scale(${.68+s.value*.32},${.57+s.value*.43}) rotate(${(1-p)*(i%2?5:-5)}deg)`;
   if(tileOpacity>0)renderers[i].draw(s.kind,Math.max(0,clock-s.since));
   slots[i].dataset.character=tileOpacity>.01?s.kind:'';
   x+=advances[i];
  });
 }
 function frame(now:number){
  raf=0;if(!canRun())return;
  const dt=last?Math.min((now-last)/1000,.05):0;last=now;clock+=dt;
  const local=clock-cycle*duration;
  while(beat<score.length&&local>=score[beat][0]){
   const [,index,kind]=score[beat++],s=states[index];s.target=kind?1:0;
   if(kind){s.kind=kind;s.since=clock;}
  }
  if(local>=duration){cycle++;beat=0;}
  if(states.some(s=>s.value!==0||s.target!==0))layout(dt);
  raf=requestAnimationFrame(frame);
 }
 function update(){
  cancelAnimationFrame(raf);raf=0;last=0;
  brand.setAttribute('aria-pressed',String(paused));
  brand.setAttribute('aria-label',reduced.matches?'ioio':paused?'Play logo animation':'Pause logo animation');
  brand.disabled=reduced.matches;
  if(reduced.matches){
   clock=0;cycle=0;beat=0;
   states.forEach(s=>{s.value=0;s.target=0;s.velocity=0;});layout(0);
  }else if(canRun())raf=requestAnimationFrame(frame);
 }
 brand.addEventListener('click',()=>{paused=!paused;update();});
 document.addEventListener('visibilitychange',update);
 reduced.addEventListener('change',()=>{if(!reduced.matches&&!prepared)prepare();update();});
 const observer=new ResizeObserver(()=>{if(ready)measure();});observer.observe(brand);
 function prepare(){if(prepared)return;prepareCharacters();prepared=true;}
 document.fonts.ready.then(()=>{
  if(!reduced.matches)prepare();
  // Measure while letters are still in their natural, tightly kerned flex flow.
  measure();brand.classList.add('is-ready');ready=true;layout(0);update();
 }).catch(()=>{/* A readable, static ioio remains if font preparation fails. */});
}
