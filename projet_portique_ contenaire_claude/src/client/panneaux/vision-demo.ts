/**
 * Lightweight, browser-only image analysis for the free public portfolio.
 * HSV segmentation and connected components, NOT YOLO segmentation.
 * No uploads, cameras, Python processes, or database writes.
 */
type Face = { id: number; x: number; y: number; width: number; height: number; area: number; fill: number };
function hsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const hi = Math.max(r,g,b), lo = Math.min(r,g,b), d = hi-lo;
  let h = 0;
  if (d) {
    if (hi===r) h=((g-b)/d)%6;
    else if (hi===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
  }
  return [Math.round(((h*60+360)%360)/2),Math.round(hi ? d/hi*255 : 0),Math.round(hi*255)];
}
export function rendreVisionDemo(root: HTMLElement): void {
  if (root.dataset.initialized) return;
  root.dataset.initialized='true';
  root.innerHTML=`<h2>Vision — analyse d’image (démo gratuite)</h2>
  <p class="note">Traitement entièrement dans votre navigateur. Détection de régions colorées par HSV, <strong>pas d’inférence YOLO</strong>. Aucune image n’est envoyée au serveur.</p>
  <div class="carte vision-controls">
    <label>Image à analyser <input id="demo-file" type="file" accept="image/png,image/jpeg,image/webp,image/bmp"></label>
    <label>Surface minimale (px²) <input id="demo-min" type="number" value="150" min="10" max="100000"></label>
    <label>Saturation minimale (0–255) <input id="demo-sat" type="range" value="65" min="0" max="255"></label>
    <label>Luminosité minimale (0–255) <input id="demo-val" type="range" value="40" min="0" max="255"></label>
    <button id="demo-run">Analyser l’image</button>
    <p id="demo-message" role="status" class="note">Sélectionnez une image pour commencer.</p>
  </div>
  <div class="carte"><canvas id="demo-canvas" style="max-width:100%;height:auto" aria-label="Image annotée"></canvas></div>
  <div class="carte"><h3>Régions détectées</h3><div id="demo-results">Aucune analyse.</div><button id="demo-export" disabled>Exporter les résultats JSON</button></div>`;
  const el=<T extends HTMLElement>(id:string)=>root.querySelector<T>('#'+id)!;
  let faces:Face[]=[];
  let imageName='';
  const analyze=async()=>{
    const file=el<HTMLInputElement>('demo-file').files?.[0];
    if(!file) throw new Error('Sélectionnez une image.');
    if(file.size>8*1024*1024) throw new Error('Image trop volumineuse (8 Mo maximum).');
    const bitmap=await createImageBitmap(file);
    try {
      const scale=Math.min(1,1024/Math.max(bitmap.width,bitmap.height));
      const w=Math.max(1,Math.round(bitmap.width*scale)),h=Math.max(1,Math.round(bitmap.height*scale));
      const canvas=el<HTMLCanvasElement>('demo-canvas');
      canvas.width=w;canvas.height=h;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      if(!ctx) throw new Error('Canvas non disponible.');
      ctx.drawImage(bitmap,0,0,w,h);
      const pixels=ctx.getImageData(0,0,w,h).data;
      const mask=new Uint8Array(w*h);
      const sat=Number(el<HTMLInputElement>('demo-sat').value);
      const val=Number(el<HTMLInputElement>('demo-val').value);
      for(let i=0;i<mask.length;i++){
        const j=i*4;
        const [hue,s,v]=hsv(pixels[j],pixels[j+1],pixels[j+2]);
        // Distinguish colored box faces from neutral backgrounds.
        if(s>=sat&&v>=val&&hue>=0&&hue<=179) mask[i]=1;
      }
      const visited=new Uint8Array(mask.length);
      const queue=new Int32Array(mask.length);
      const minArea=Number(el<HTMLInputElement>('demo-min').value);
      const found:Face[]=[];
      for(let start=0;start<mask.length;start++){
        if(!mask[start]||visited[start])continue;
        let front=0,back=1;queue[0]=start;visited[start]=1;
        let left=w,top=h,right=0,bottom=0,area=0;
        while(front<back){
          const p=queue[front++],x=p%w,y=(p/w)|0;
          area++;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
          const neighbors=[x>0?p-1:-1,x<w-1?p+1:-1,y>0?p-w:-1,y<h-1?p+w:-1];
          for(const n of neighbors)if(n>=0&&mask[n]&&!visited[n]){visited[n]=1;queue[back++]=n;}
        }
        const bw=right-left+1,bh=bottom-top+1,fill=area/(bw*bh);
        if(area>=minArea&&fill>=0.55&&bw>=5&&bh>=5&&left>0&&top>0&&right<w-1&&bottom<h-1){
          found.push({id:found.length+1,x:left,y:top,width:bw,height:bh,area,fill:Math.round(fill*100)/100});
        }
      }
      faces=found.sort((a,b)=>b.area-a.area).slice(0,100).map((f,i)=>({...f,id:i+1}));
      ctx.lineWidth=2;ctx.font='bold 13px sans-serif';
      for(const f of faces){
        ctx.strokeStyle='#19f59a';ctx.strokeRect(f.x,f.y,f.width,f.height);
        ctx.fillStyle='#102d28';ctx.fillRect(f.x,Math.max(0,f.y-20),110,20);
        ctx.fillStyle='#ffffff';ctx.fillText(`#${f.id} · ${f.area} px²`,f.x+3,Math.max(13,f.y-5));
      }
      imageName=file.name;
      el('demo-message').textContent=`${faces.length} région(s) colorée(s) détectée(s). Résultats indicatifs : plusieurs faces peuvent fusionner.`;
      el('demo-results').textContent=faces.length?faces.map(f=>`#${f.id} : ${f.area} px² · rectangle ${f.width} × ${f.height} px · remplissage ${Math.round(f.fill*100)} %`).join(' | '):'Aucune région ne satisfait les seuils. Ajustez la saturation ou la surface minimale.';
      el<HTMLButtonElement>('demo-export').disabled=false;
    }finally{bitmap.close();}
  };
  el('demo-run').addEventListener('click',()=>void analyze().catch(e=>{el('demo-message').textContent=(e as Error).message;}));
  el('demo-export').addEventListener('click',()=>{
    const blob=new Blob([JSON.stringify({image:imageName,method:'browser-hsv-connected-components',not_yolo:true,faces},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='vision-demo-results.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
}
