import { api } from '../api.ts';
import { esc } from '../util.ts';

export function brancherCalibration(root: HTMLElement): void {
  const section = document.createElement('details'); section.className = 'carte';
  section.innerHTML = `<summary>Calibration — trois hauteurs</summary>
    <p>Mesurez un conteneur identique aux autres. Pour chaque niveau, placez des repères à la hauteur de sa face supérieure (h, 2h, 3h). Cliquez sur au moins quatre repères non alignés et bien répartis, puis indiquez leurs coordonnées X/Y réelles dans le repère du portique.</p>
    <p class="note">Pour couvrir tout le plateau, répartissez les repères sur toute la zone utilisée à chaque hauteur. La caméra, le zoom, la résolution et son orientation doivent rester fixes. Cette calibration expérimentale ne corrige pas la distorsion de l’objectif ; vérifiez les résultats avec une règle.</p>
    <div class="cal-dimensions"><label>Longueur (mm)<input id="cal-length" type="number" min="0.1" step="0.1"></label><label>Largeur (mm)<input id="cal-width" type="number" min="0.1" step="0.1"></label><label>Hauteur h (mm)<input id="cal-height" type="number" min="0.1" step="0.1"></label></div>
    <label>Niveau à calibrer <select id="cal-level"><option value="1">1 — face à Z = h</option><option value="2">2 — face à Z = 2h</option><option value="3">3 — face à Z = 3h</option></select></label>
    <button id="cal-freeze">Figer une image pour les repères</button><p class="note">La capture continue. Seule cette image de calibration est figée. Un clic ajoute un repère ; ses coordonnées réelles sont modifiables dans le tableau.</p>
    <label>X réel du prochain repère (mm)<input id="cal-x" type="number" step="0.1" value="0"></label><label>Y réel du prochain repère (mm)<input id="cal-y" type="number" step="0.1" value="0"></label>
    <canvas id="cal-image" hidden style="width:100%;height:auto;cursor:crosshair"></canvas>
    <div id="cal-points" class="vision-table"></div><p id="cal-progress"></p>
    <div class="boutons"><button id="cal-clear" class="secondaire">Effacer les repères de ce niveau</button><button id="cal-reset" class="secondaire">Nouvelle calibration</button><button id="cal-save">Calculer et sauvegarder les trois niveaux</button></div>
    <p id="cal-message" role="status"></p>`;
  root.querySelector('#vision-images')!.after(section);
  const q = <T extends HTMLElement = HTMLElement>(id: string) => section.querySelector<T>('#'+id)!;
  let profile: any = { levels: [1,2,3].map(level => ({ level, points: [] })) };
  let image: HTMLImageElement | null = null;
  let frozenLevel = 0;
  let working = false;
  const message = (text: string) => { q('cal-message').textContent = text; };
  const level = () => Number(q<HTMLSelectElement>('cal-level').value);
  const points = () => profile.levels.find((l: any) => l.level === level()).points;
  const draw = () => {
    const canvas = q<HTMLCanvasElement>('cal-image');
    canvas.hidden = !image || frozenLevel !== level();
    if (canvas.hidden || !image) return;
    const ctx = canvas.getContext('2d')!;ctx.drawImage(image,0,0);
    ctx.fillStyle = '#00ff55'; ctx.font = '16px sans-serif';
    points().forEach((p: any,i: number) => {ctx.beginPath();ctx.arc(p.pixel[0],p.pixel[1],5,0,Math.PI*2);ctx.fill();ctx.fillText(String(i+1),p.pixel[0]+8,p.pixel[1]-8);});
  };
  const render = () => {
    q('cal-points').innerHTML = `<table><thead><tr><th>Repère</th><th>Pixel u/v</th><th>X (mm)</th><th>Y (mm)</th><th></th></tr></thead><tbody>${points().map((p: any,i: number) => `<tr><td>${i+1}</td><td>${p.pixel.join(', ')}</td>${[0,1].map(axis => `<td><input type="number" step="0.1" data-point="${i}" data-axis="${axis}" value="${p.world[axis]}" aria-label="Coordonnée ${axis===0?'X':'Y'} repère ${i+1}"></td>`).join('')}<td><button data-remove="${i}" class="secondaire">Retirer</button></td></tr>`).join('')}</tbody></table>`;
    q('cal-progress').textContent = profile.levels.map((l: any) => `Niveau ${l.level} : ${l.points.length} repères`).join(' · ');
    draw();
  };
  q('cal-level').addEventListener('change',render);
  q('cal-points').addEventListener('change', e => {const input=e.target as HTMLInputElement;if(input.dataset.point!==undefined) points()[Number(input.dataset.point)].world[Number(input.dataset.axis)] = Number(input.value);});
  q('cal-points').addEventListener('click', e => {const b=(e.target as HTMLElement).closest<HTMLElement>('[data-remove]');if(b){points().splice(Number(b.dataset.remove),1);render();}});
  q('cal-reset').addEventListener('click', () => {profile={levels:[1,2,3].map(level=>({level,points:[]}))}; image=null;render();message('Nouveaux repères à saisir. La calibration enregistrée reste active jusqu’à la sauvegarde des nouveaux niveaux.');});
  q('cal-clear').addEventListener('click', () => {profile.levels.find((l: any)=>l.level===level()).points=[];render();});
  q('cal-freeze').addEventListener('click', async () => {
    if(working)return;working=true;message('Capture de référence…');
    try {
      const shot=await api.post<any>('/api/vision/calibration/snapshot');const obs=shot.observation;
      const source={kind:obs.source.kind,camera_index:obs.source.camera_index ?? null};
      if(profile.resolution && (JSON.stringify(profile.resolution)!==JSON.stringify(obs.resolution) || JSON.stringify(profile.source)!==JSON.stringify(source))) throw Error('Source ou résolution différente. Rechargez la caméra utilisée pour les repères existants.');
      profile.resolution=obs.resolution;profile.source=source;
      const next=new Image();next.src=shot.image;await next.decode();image=next;frozenLevel=level();
      const canvas=q<HTMLCanvasElement>('cal-image');canvas.width=obs.resolution.width;canvas.height=obs.resolution.height;render();
      message('Image figée. Cliquez sur vos repères connus au niveau sélectionné.');
    }catch(e){message((e as Error).message);}finally{working=false;}
  });
  q<HTMLCanvasElement>('cal-image').addEventListener('click',e=>{
    if(!image || frozenLevel!==level())return;
    const canvas=q<HTMLCanvasElement>('cal-image');const bounds=canvas.getBoundingClientRect();
    const world=[Number(q<HTMLInputElement>('cal-x').value),Number(q<HTMLInputElement>('cal-y').value)];
    if(!world.every(Number.isFinite)){message('Coordonnées réelles invalides.');return;}
    points().push({pixel:[Math.round((e.clientX-bounds.left)*canvas.width/bounds.width),Math.round((e.clientY-bounds.top)*canvas.height/bounds.height)],world});render();
  });
  q('cal-save').addEventListener('click',async()=>{
    if(working)return;working=true;
    try {
      const container_mm=Object.fromEntries(['length','width','height'].map(k=>[k,Number(q<HTMLInputElement>('cal-'+k).value)]));
      const data=await api.post<any>('/api/vision/calibration',{...profile,container_mm});profile=data.profile;render();
      message('Calibration sauvegardée et appliquée au flux. Erreurs d’ajustement : '+profile.levels.map((l: any)=>`niveau ${l.level} = ${l.fit_error_mm} mm`).join(' · ')+'. Ce résultat ne remplace pas une vérification avec une distance indépendante.');
    }catch(e){message((e as Error).message);}finally{working=false;}
  });
  void api.get<any>('/api/vision/calibration').then(saved=>{
    if(!saved)return;profile=saved;['length','width','height'].forEach(k=>{q<HTMLInputElement>('cal-'+k).value=String(saved.container_mm[k]);});render();message('Calibration enregistrée chargée. Les repères et paramètres sont modifiables.');
  }).catch(e=>message(e.message));
  render();
}

export function realMeasurement(d: any): string {
  const r=d.real;
  if(!r || r.status==='uncalibrated')return 'Non calibré';
  if(r.status!=='estimated')return 'Incertain : '+esc(r.reason);
  return `Niveau ${r.level} · X ${r.x_mm}, Y ${r.y_mm} mm · Z face ${r.z_top_mm} mm · ${r.length_mm} × ${r.width_mm} mm · ${r.area_mm2} mm² · écart dimensions ${Math.round(r.relative_error*1000)/10} % (estimation)`;
}
