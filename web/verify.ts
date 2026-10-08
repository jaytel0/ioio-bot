// Development-only browser measurement. Injected by preview-landing, never the Worker.
const output=document.createElement('output');output.id='verification';output.style.cssText='position:fixed;left:12px;bottom:12px;max-width:calc(100% - 24px);font:11px monospace;background:#fff;padding:8px;border:1px solid #ddd;z-index:20';document.body.append(output);
const samples:{at:number;left:number;right:number;overflow:boolean;word:boolean;centers:number[];characters:string[]}[]=[];
let start=0,previous=0,maxStep=0,frameGaps:number[]=[];
const shifts:number[]=[];
try{new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!(entry as PerformanceEntry&{hadRecentInput:boolean}).hadRecentInput)shifts.push((entry as PerformanceEntry&{value:number}).value);}).observe({type:'layout-shift',buffered:true});}catch{}
function sample(now:number){
 if(!document.querySelector('.brand-play.is-ready')){requestAnimationFrame(sample);return;}
 if(!start)start=now;
 const all=[...document.querySelectorAll<HTMLElement>('.brand-letter,.brand-character')],visible=all.filter(e=>Number(getComputedStyle(e).opacity)>.05),rects=visible.map(e=>e.getBoundingClientRect());
 const centers=[...document.querySelectorAll<HTMLElement>('.brand-slot')].map(e=>e.getBoundingClientRect().x);
 if(samples.length){const last=samples[samples.length-1];maxStep=Math.max(maxStep,...centers.map((x,i)=>Math.abs(x-last.centers[i])));frameGaps.push(now-previous);}previous=now;
 samples.push({at:now-start,left:Math.min(...rects.map(r=>r.left)),right:Math.max(...rects.map(r=>r.right)),overflow:document.documentElement.scrollWidth>innerWidth,word:all.filter(e=>e.classList.contains('brand-letter')).every(e=>Number(getComputedStyle(e).opacity)===1),centers,characters:[...document.querySelectorAll<HTMLElement>('.brand-slot')].map(e=>e.dataset.character||'')});
 if(now-start<18000){output.textContent='Measuring full cycle… '+((now-start)/1000).toFixed(1)+'s';requestAnimationFrame(sample);}else{
 frameGaps.sort((a,b)=>a-b);
 const results={viewport:[innerWidth,innerHeight],samples:samples.length,clipped:samples.some(s=>s.left<0||s.right>innerWidth),overflow:samples.some(s=>s.overflow),wordFrames:samples.filter(s=>s.word).length,characters:[...new Set(samples.flatMap(s=>s.characters).filter(Boolean))],maxFrameStepPx:+maxStep.toFixed(2),p95FrameMs:+frameGaps[Math.floor(frameGaps.length*.95)].toFixed(2),layoutShift:shifts.reduce((a,b)=>a+b,0),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};
 output.textContent=JSON.stringify(results);output.dataset.complete='true';
 }
}
requestAnimationFrame(sample);
