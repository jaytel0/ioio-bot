import { BotEngine } from './vendor/bloub/engine';
import type { StateId } from './vendor/bloub/states';

export type Character = 'alfred' | 'felipe' | 'muse' | 'grok' | 'instinct';
type Ctx = CanvasRenderingContext2D;
const TAU = Math.PI * 2;
const backgrounds: Record<Character, string> = {alfred:'#fff5ce',felipe:'#d5f0fc',muse:'#f8f7f4',grok:'#f5f5f3',instinct:'#f7f4ee'};
const layers = new Map<string, HTMLCanvasElement>();
const clamp = (v:number) => Math.max(0,Math.min(1,v));
function random(seed:number) { return () => {seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15,1|seed); t ^= t + Math.imul(t ^ t >>> 7,61|t); return ((t ^ t >>> 14) >>> 0)/4294967296;}; }
function ellipse(c:Ctx,x:number,y:number,rx:number,ry:number,fill:string|CanvasGradient,angle=0){c.beginPath();c.ellipse(x,y,rx,ry,angle,0,TAU);c.fillStyle=fill;c.fill();}
function radial(c:Ctx,x:number,y:number,r:number,stops:[number,string][]) { const g=c.createRadialGradient(x,y,0,x,y,r); for(const [p,color] of stops)g.addColorStop(p,color);return g; }
function layer(name:string,draw:(c:Ctx)=>void){ let v=layers.get(name);if(!v){v=document.createElement('canvas');v.width=v.height=608;const c=v.getContext('2d')!;c.scale(2,2);c.translate(16,16);draw(c);layers.set(name,v);}return v; }
function paint(c:Ctx,name:string,x=0,y=0){c.drawImage(layers.get(name)!,x-16,y-16,304,304);}

/** Seeded individual fibres, groomed over a curved surface. All pixels are made
 * here; no downloaded image, video, sprite sheet or raster texture is shipped. */
function fur(c:Ctx,path:Path2D,options:{seed:number;color:[number,number,number];count?:number;length?:number;cx?:number;cy?:number;rx?:number;ry?:number;flow?:'hood'|'down'|'radial'}){
 const {seed,color,count=21000,length=5,cx=128,cy=147,rx=106,ry=122,flow='radial'}=options;
 const rng=random(seed);
 // Build a shallow curved volume from the silhouette's horizontal sections.
 // Its normals light both the undercoat and each fibre, instead of a flat fill.
 const n=280,depth=new Float32Array(n*n),inside=new Uint8Array(n*n);
 const transform=c.getTransform();
 for(let y=0;y<n;y++){
  let left=n,right=0;
  for(let x=0;x<n;x++)if(c.isPointInPath(path,transform.a*x+transform.c*y+transform.e,transform.b*x+transform.d*y+transform.f)){inside[y*n+x]=1;left=Math.min(left,x);right=Math.max(right,x);}
  const mid=(left+right)/2,r=(right-left)/2;
  if(r>0)for(let x=left;x<=right;x++)depth[y*n+x]=Math.sqrt(Math.max(0,r*r-(x-mid)**2))*.74;
 }
 if(seed===32){
  // Felipe is a union of cloud lobes, so the light wraps each puff separately.
  const lobes=[[125,145,108,89,80],[177,99,54,42,38],[217,173,35,34,34],[163,213,53,33,47],[86,212,49,36,43],[34,174,35,40,30]];
  for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(inside[y*n+x]){
   let z=0;
   for(const [lx,ly,rx,ry,rz] of lobes){const d=((x-lx)/rx)**2+((y-ly)/ry)**2,v=d<1?Math.sqrt(1-d)*rz:0,h=Math.max(8-Math.abs(z-v),0)/8;z=Math.max(z,v)+h*h*h*8/6;}
   depth[y*n+x]=z;
  }
 }
 // Smooth the section sampling before differentiating: no scanline bands.
 const scratch=new Float32Array(n*n),kernel=[1,4,6,4,1];
 for(let pass=0;pass<3;pass++){
  for(let y=2;y<n-2;y++)for(let x=2;x<n-2;x++){let v=0;for(let k=-2;k<=2;k++)v+=depth[y*n+x+k]*kernel[k+2];scratch[y*n+x]=v/16;}
  for(let y=2;y<n-2;y++)for(let x=2;x<n-2;x++){let v=0;for(let k=-2;k<=2;k++)v+=scratch[(y+k)*n+x]*kernel[k+2];depth[y*n+x]=v/16;}
 }
 const lighting=(x:number,y:number)=>{
  const ix=Math.max(1,Math.min(n-2,Math.round(x))),iy=Math.max(1,Math.min(n-2,Math.round(y))),k=iy*n+ix;
  const nx=-(depth[k+1]-depth[k-1])*.5,ny=-(depth[k+n]-depth[k-n])*.5;
  const inv=1/Math.hypot(nx,ny,1),diffuse=Math.max(0,(-.48*nx-.52*ny+.76)*inv);
  return .61+diffuse*.51;
 };
 const base=c.createLinearGradient(20,40,230,210);
 base.addColorStop(0,`rgb(${color.map(v=>Math.min(255,v*1.07)).join(',')})`);
 base.addColorStop(1,`rgb(${color.map(v=>v*.72).join(',')})`);
 c.fillStyle=base;c.fill(path);
 c.lineCap='round';
 // Fine dense fibres; stable seeds avoid shimmering between animation frames.
 for(let i=0;i<count*2.5;i++){
  const x=rng()*268-6,y=rng()*290-8;
  if(x<1||y<1||x>=n-1||y>=n-1||!inside[Math.round(y)*n+Math.round(x)])continue;
  const nx=(x-cx)/rx,ny=(y-cy)/ry;
  let a=Math.atan2(ny*.8,nx);
  if(flow==='down')a=Math.PI/2+nx*.72;
  if(flow==='hood')a=y<164?Math.atan2((y-99)/69,(x-128)/75):Math.PI/2+nx*.55;
  a+=(rng()-.5)*.65;
  const len=length*(.42+rng()*.8),tone=(rng()-.5)*.13,l=lighting(x,y)+tone;
  const dx=Math.cos(a),dy=Math.sin(a),curl=(rng()-.5)*.8;
  c.strokeStyle=`rgb(${color.map(v=>Math.min(255,Math.round(v*l))).join(',')})`;
  c.lineWidth=.18+rng()*.27;c.beginPath();c.moveTo(x-dx*len*.2,y-dy*len*.2);
  c.quadraticCurveTo(x+dx*len*.4-dy*curl,y+dy*len*.4+dx*curl,x+dx*len,y+dy*len);c.stroke();
 }

}
const pear=new Path2D('M 147 54 C 180 52 197 89 205 117 C 216 151 247 174 244 211 C 242 245 212 268 163 274 C 121 278 59 272 37 246 C 12 218 34 175 59 149 C 92 117 104 57 147 54 Z');
const cloud=new Path2D('M 67 91 C 75 66 110 59 130 74 C 154 54 193 64 204 89 C 226 90 238 116 228 137 C 252 154 253 181 233 197 C 237 222 209 240 185 231 C 162 254 129 250 111 238 C 80 255 46 235 43 216 C 15 218 0 193 13 169 C -5 145 11 117 40 116 C 40 103 51 92 67 91 Z');
const hood=new Path2D('M 128 24 C 196 21 215 71 216 121 C 217 156 218 178 234 213 L 246 278 L 12 278 L 27 208 C 43 176 40 149 42 111 C 44 55 68 25 128 24 Z');
const face=new Path2D('M 128 51 C 175 50 190 75 192 111 C 195 145 184 157 164 161 C 141 165 104 165 86 161 C 65 157 62 143 65 114 C 66 75 82 51 128 51 Z');
const arm=new Path2D('M 58 162 C 42 151 27 174 19 205 C 13 231 12 251 21 257 C 32 266 47 247 56 219 C 64 193 70 172 58 162 Z');

export function prepareCharacters(){
 layer('alfred',c=>fur(c,pear,{seed:12,color:[255,214,38],cx:141,cy:150,rx:124,ry:151,length:4.6,count:30000}));
 layer('felipe',c=>fur(c,cloud,{seed:32,color:[28,174,245],cx:131,cy:132,rx:148,ry:135,length:3.8,count:32000}));
 layer('beret',c=>{
  const p=new Path2D('M 32 97 C 31 63 75 39 129 43 C 175 46 209 72 201 93 C 192 115 67 124 38 113 Z');
  fur(c,p,{seed:95,color:[37,35,34],cx:100,cy:71,rx:111,ry:53,length:1.7,count:16000});
  c.save();c.translate(88,43);c.rotate(-.25);ellipse(c,0,0,11,14,radial(c,-4,-5,22,[[0,'#383735'],[1,'#111111']]));c.restore();
 });
 layer('muse',c=>fur(c,hood,{seed:51,color:[239,228,204],length:5.4,count:34000,flow:'hood'}));
 layer('arm',c=>fur(c,arm,{seed:14,color:[233,218,192],length:4.7,count:23000,flow:'down',cx:43,cy:205,rx:34,ry:74}));
 layer('face',c=>{
  c.save();c.shadowColor='#8e74484a';c.shadowBlur=3;c.shadowOffsetY=1;
  c.fillStyle=radial(c,145,90,110,[[0,'#fff0cd'],[.65,'#f7e7c0'],[1,'#d0b589']]);c.fill(face);c.restore();
  c.save();c.clip(face);
  for(const x of [86,166])ellipse(c,x,132,23,23,radial(c,x,132,23,[[0,'#dc936e96'],[.5,'#e6a17a65'],[1,'#ebc49d00']]));
  c.restore();
 });
 layer('bow',c=>{
  c.save();c.translate(139,251);c.rotate(.06);
  for(const side of [-1,1]){c.save();c.scale(side,1);const p=new Path2D('M 1 -2 C 14 -12 44 -26 48 -17 C 51 -8 49 17 46 21 C 41 27 14 10 1 5 Z');c.fillStyle=radial(c,20,-15,54,[[0,'#363735'],[.5,'#151714'],[1,'#060806']]);c.fill(p);c.strokeStyle='#ffffff0d';c.lineWidth=.45;for(let i=0;i<26;i++){c.beginPath();c.moveTo(4,1);c.lineTo(45,-17+i*1.4);c.stroke();}c.restore();}
  ellipse(c,0,1,6,15,'#151815');c.restore();
 });
}
function blink(t:number,offset=0){const p=(t+offset)%4.9;return 1-.96*Math.exp(-Math.pow((p-2.45)/.065,2));}
function glossyEye(c:Ctx,x:number,y:number,rx:number,ry:number,open=1,angle=0){
 c.save();c.translate(x,y);c.rotate(angle);c.scale(1,open);
 ellipse(c,0,0,rx,ry,'#433b2e');
 ellipse(c,0,-.4,rx*.88,ry*.91,radial(c,-rx*.22,-ry*.3,ry*1.7,[[0,'#2b2822'],[.5,'#0a0908'],[.76,'#161310'],[1,'#645644']]));
 ellipse(c,rx*.28,-ry*.42,rx*.26,ry*.22,'#fff9e1a0',-.3);
 ellipse(c,-rx*.34,-ry*.62,rx*.08,ry*.08,'#ffffffb0');c.restore();
}
function alfred(c:Ctx,t:number){
 const turn=Math.sin(t*1.9)*2.2,look=Math.sin(t*1.3)*3;
 c.save();c.translate(128,224);c.rotate(Math.sin(t*1.4)*.017);c.scale(1+Math.sin(t*2)*.009,1-Math.sin(t*2)*.009);c.translate(-128,-224);
 paint(c,'alfred');paint(c,'bow');
 c.save();c.translate(140+turn,145);c.rotate(.24+Math.sin(t*1.4)*.018);
 c.strokeStyle='#1b1c15';c.lineCap='round';c.lineWidth=7;
 c.beginPath();c.moveTo(-70,-2);c.lineTo(-81,-2);c.moveTo(68,-2);c.lineTo(80,-2);c.stroke();
 for(const x of [-37,35]){
  const rx=x<0?30:28,ry=x<0?33:31;
  c.save();c.shadowColor='#56431960';c.shadowBlur=4;c.shadowOffsetY=3;
  ellipse(c,x,0,rx+3,ry+3,'#161c18');c.restore();
  ellipse(c,x,0,rx-2,ry-2,radial(c,x-8,-10,39,[[0,'#fffef4'],[.62,'#f9f9ef'],[1,'#a4a594']]));
  c.save();c.beginPath();c.ellipse(x,0,rx-3,ry-3,0,0,TAU);c.clip();
  glossyEye(c,x-9+look,-10,11,16,blink(t));
  if(blink(t)<.9){c.fillStyle='#f1eee0';c.fillRect(x-rx,-ry,rx*2,(ry*2)*(1-blink(t))*.5);c.fillRect(x-rx,ry-(ry*2)*(1-blink(t))*.5,rx*2,ry);}
  c.restore();
  c.strokeStyle='#fff9b166';c.lineWidth=1.1;c.beginPath();c.ellipse(x-1,-1,rx+1,ry+1,0,Math.PI*.95,Math.PI*1.85);c.stroke();
 }
 c.strokeStyle='#121a16';c.lineWidth=6;c.beginPath();c.moveTo(-5,-4);c.quadraticCurveTo(0,-9,5,-4);c.stroke();c.restore();c.restore();
}
function felipe(c:Ctx,t:number){
 const nod=Math.sin(t*2)*1.6;
 c.save();c.translate(128,198);c.rotate(-.06+Math.sin(t*1.5)*.025);c.scale(1+Math.sin(t*2)*.014,1-Math.sin(t*2)*.012);c.translate(-128,-198);
 paint(c,'felipe');c.save();c.translate(132,83+nod);c.rotate(-.28+Math.sin(t*1.5+.4)*.018);c.translate(-128,-85);paint(c,'beret');c.restore();
 const gaze=Math.sin(t*1.45)*2;
 glossyEye(c,166+gaze,151+nod,10,18,blink(t,.8),-.12);
 glossyEye(c,195+gaze*.7,143+nod,7.3,16.2,blink(t,.8),-.13);c.restore();
}
function muse(c:Ctx,t:number){
 const breath=Math.sin(t*2)*.007;
 c.save();c.translate(128,254);c.scale(1+breath,1-breath);c.translate(-128,-254);
 paint(c,'arm');
 // The lifted hand has its own shoulder pivot and wrist rhythm.
 const phase=t%5,up=clamp((phase-.3)/.55),down=1-clamp((phase-2.6)/.75),lift=up*up*(3-2*up)*down*down*(3-2*down);
 c.save();c.translate(206,185);c.scale(-1,1);c.rotate(lift*(2.75+Math.sin(t*7)*.15));c.translate(-48,-178);paint(c,'arm');c.restore();
 paint(c,'muse');
 c.save();c.translate(128,119);c.rotate(Math.sin(t*1.8)*.016);c.translate(-128,-119);paint(c,'face');
 const gaze=Math.sin(t*1.7)*1.1,open=blink(t,1.1);
 glossyEye(c,97+gaze,114,7.2,8.2,open);glossyEye(c,159+gaze,114,7.2,8.2,open);
 c.strokeStyle='#59401f';c.lineWidth=1.8;c.lineCap='round';c.beginPath();c.moveTo(119,127);c.bezierCurveTo(123,132.8,133,133.2,138,127);c.stroke();
 c.strokeStyle='#fff2d28a';c.lineWidth=.7;c.beginPath();c.moveTo(120,130);c.quadraticCurveTo(129,138,138,130);c.stroke();c.restore();c.restore();
}

const bodyBounds = new Map<Character,{cx:number;cy:number;height:number}>();
export class CharacterRenderer {
 private c: Ctx;
 private grok=new BotEngine(83,'idle');
 private grokState:StateId='idle';
 private lastGrokTime=-1;
 constructor(readonly canvas:HTMLCanvasElement){this.c=canvas.getContext('2d')!;}
 resize(size:number){const resolution=Math.min(512,Math.max(192,Math.ceil(size*Math.min(devicePixelRatio,3))));if(this.canvas.width!==resolution){this.canvas.width=this.canvas.height=resolution;}}
 draw(kind:Character,t:number){
  const c=this.c;c.setTransform(this.canvas.width/256,0,0,this.canvas.height/256,0,0);c.clearRect(0,0,256,256);
  if(kind==='instinct'){
   c.fillStyle=backgrounds.instinct;c.fillRect(0,0,256,256);
   // The approved path, at 88% of its original internal size.
   c.save();c.translate(128,128);c.scale(1.76,1.76);c.translate(-64,-64);c.fillStyle='#07100d';c.fill(new Path2D('M53 21h22c-5.2 8.2-5.9 14.7-5.9 23.4v39.2c0 8.7.7 15.2 5.9 23.4H53c5.2-8.2 5.9-14.7 5.9-23.4V44.4c0-8.7-.7-15.2-5.9-23.4Z'));c.restore();
  }else{
   const bounds=this.bounds(kind);
   // A .72em canvas with a 192/256 silhouette matches the o's .54em ink height.
   c.save();c.translate(128,128);c.scale(192/bounds.height,192/bounds.height);c.translate(-bounds.cx,-bounds.cy);
   this.drawRaw(kind,t);c.restore();
  }
 }
 private drawRaw(kind:Character,t:number){
  if(kind==='alfred')alfred(this.c,t);else if(kind==='felipe')felipe(this.c,t);else if(kind==='muse')muse(this.c,t);else this.drawGrok(t);
 }
 private bounds(kind:Character){
  let bounds=bodyBounds.get(kind);
  if(!bounds){
   const sample=document.createElement('canvas');sample.width=sample.height=512;
   const renderer=new CharacterRenderer(sample),c=renderer.c;
   c.setTransform(512/320,0,0,512/320,0,0);c.translate(32,16);renderer.drawRaw(kind,0);
   const pixels=c.getImageData(0,0,512,512).data;
   let left=512,right=0,top=512,bottom=0;
   for(let y=0;y<512;y++)for(let x=0;x<512;x++)if(pixels[(y*512+x)*4+3]>63){left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1);}
   bounds={cx:(left+right)/2*320/512-32,cy:(top+bottom)/2*320/512-16,height:(bottom-top)*320/512};
   bodyBounds.set(kind,bounds);
  }
  return bounds;
 }
 private drawGrok(t:number){
  if(t<this.lastGrokTime){this.grok=new BotEngine(83,'idle');this.grokState='idle';}
  this.lastGrokTime=t;
  const state:StateId=t%7<2.3?'idle':t%7<3.7?'wink':'idle';
  if(state!==this.grokState){this.grok.setState(state,t);this.grokState=state;}
  const f=this.grok.sample(t),c=this.c;c.save();c.translate(128,128);
  c.globalAlpha=f.bodyAlpha;c.fillStyle='#000';c.fill(new Path2D(f.bodyPath));c.clip(new Path2D(f.bodyPath));
  for(const eye of f.eyes){c.save();const m=eye.matrix.match(/[-\d.]+(?:e[-+]?\d+)?/g)!.map(Number);c.transform(m[0],m[1],m[2],m[3],m[4],m[5]);c.globalAlpha=eye.alpha;c.fillStyle=backgrounds.grok;c.fill(new Path2D(eye.d));c.restore();}
  c.restore();
 }
}
