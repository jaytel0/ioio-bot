// Render the existing homepage type treatment, with all four letters visible.
// Export canvas#og from this page as PNG after data-ready becomes true.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const html = `<!doctype html><html><head><meta charset="utf-8"><title>ioio OG image</title><style>
@font-face{font-family:Inter;src:url(/InterVariable.woff2);font-weight:100 900}
body{margin:0;background:#fff}canvas{display:block;width:1200px;height:630px}
</style></head><body><canvas id="og" width="1200" height="630" aria-label="ioio"></canvas><a id="download" download="ioio-og-wordmark.png">Download PNG</a><script>
(async()=>{
 await document.fonts.load('650 180px Inter');
 const canvas=document.querySelector('#og'),c=canvas.getContext('2d'),letters=[...'ioio'],gap=180*.085;
 c.fillStyle='#fff';c.fillRect(0,0,1200,630);
 c.font='650 180px Inter';c.fillStyle='#000';
 const widths=letters.map(letter=>c.measureText(letter).width),metrics=c.measureText('ioio');
 let x=(1200-widths.reduce((a,b)=>a+b,0)-gap*3)/2;
 const y=315+(metrics.actualBoundingBoxAscent-metrics.actualBoundingBoxDescent)/2;
 letters.forEach((letter,i)=>{c.fillText(letter,x,y);x+=widths[i]+gap;});
 document.querySelector('#download').href=canvas.toDataURL('image/png');
 canvas.dataset.ready='true';
})();
</script></body></html>`;

createServer(async (request,response)=>{
 if(request.url==='/InterVariable.woff2'){
  response.setHeader('Content-Type','font/woff2');
  response.end(await readFile('src/assets/InterVariable.woff2'));return;
 }
 response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html);
}).listen(8811,'127.0.0.1',()=>console.log('Static OG image: http://127.0.0.1:8811/'));
