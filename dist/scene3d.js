// Adapted from Claude's Scene3D: orthographic mm coordinates, OrbitControls,
// selectable volumes and an abstract handling indicator. Uses the shared state.
import * as THREE from './vendor/three.module.js';
import {OrbitControls} from './vendor/OrbitControls.js';
import {slots,position,bayPosition,movingPosition} from './core.js?v=5';

export class Scene3D {
  constructor(host,onSelect){
    this.host=host;this.onSelect=onSelect;this.signature='';this.routeKey='';
    this.canvas=document.createElement('canvas');this.canvas.id='scene3d';this.canvas.setAttribute('aria-label','Vue 3D du stockage. Faites glisser pour tourner et utilisez la molette pour zoomer.');
    this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));host.prepend(this.canvas);
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#eef4f6');
    this.camera=new THREE.OrthographicCamera(-600,600,350,-350,.1,10000);this.camera.up.set(0,0,1);
    this.controls=new OrbitControls(this.camera,this.canvas);this.controls.enableDamping=true;this.controls.maxPolarAngle=Math.PI/2-.03;
    this.controls.minZoom=.4;this.controls.maxZoom=6;
    this.fixed=new THREE.Group();this.route=new THREE.Group();this.scene.add(this.fixed,this.route);
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x7f97a7,2.5));
    const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(-400,-700,1400);this.scene.add(light);
    this.raycaster=new THREE.Raycaster();this.pointer=new THREE.Vector2();this.pickable=[];
    this.tooltip=document.createElement('div');this.tooltip.className='scene-tooltip';this.tooltip.hidden=true;host.append(this.tooltip);
    this.canvas.addEventListener('pointerdown',e=>{this.down={x:e.clientX,y:e.clientY};});
    this.canvas.addEventListener('pointerup',e=>{if(this.down&&Math.hypot(e.clientX-this.down.x,e.clientY-this.down.y)<5){const hit=this.hit(e);if(hit)this.onSelect(hit);}});
    this.canvas.addEventListener('pointermove',e=>{const hit=this.hit(e);this.tooltip.hidden=!hit;if(hit){this.tooltip.textContent=hit.title;const r=this.canvas.getBoundingClientRect();this.tooltip.style.left=Math.min(r.width-150,e.clientX-r.left+10)+'px';this.tooltip.style.top=(e.clientY-r.top+10)+'px';}});
    this.canvas.addEventListener('pointerleave',()=>this.tooltip.hidden=true);
    new ResizeObserver(()=>this.resize()).observe(host);this.controls.addEventListener('end',()=>this.resize());this.reset();
  }
  hit(e){const r=this.canvas.getBoundingClientRect();this.pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);this.raycaster.setFromCamera(this.pointer,this.camera);return this.raycaster.intersectObjects(this.pickable,false)[0]?.object.userData;}
  clear(group){while(group.children.length){const object=group.children[0];group.remove(object);object.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material]){m.map?.dispose();m.dispose();}}});}}
  box(group,x,y,z,l,w,h,color,data){const mesh=new THREE.Mesh(new THREE.BoxGeometry(l,w,h),new THREE.MeshStandardMaterial({color,roughness:.78}));mesh.position.set(x+l/2,y+w/2,z+h/2);group.add(mesh);const edges=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.45}));mesh.add(edges);if(data){mesh.userData=data;this.pickable.push(mesh);}return mesh;}
  label(group,text,x,y,z,size=18){const c=document.createElement('canvas');c.width=256;c.height=64;const ctx=c.getContext('2d');ctx.font='600 32px Segoe UI';ctx.fillStyle='#244a5c';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,128,32);const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false}));sprite.position.set(x,y,z);sprite.scale.set(size*4,size,1);group.add(sprite);}
  reset(){const c=this.config||{length:1000,width:500};this.center=new THREE.Vector3(c.length/2,c.width/2,0);this.camera.position.set(this.center.x-700,this.center.y-1000,900);this.camera.zoom=1;this.controls.target.copy(this.center);this.controls.update();this.resize();}
  resize(){const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;this.renderer.setSize(w,h,false);const aspect=w/h,c=this.config||{length:1000,width:500,levels:3,containerHeight:50};this.camera.updateMatrixWorld(true);let half=1;for(const x of [-45,c.length+45])for(const y of [-45,c.width+45])for(const z of [0,c.levels*c.containerHeight]){const p=new THREE.Vector3(x,y,z).applyMatrix4(this.camera.matrixWorldInverse);half=Math.max(half,Math.abs(p.y),Math.abs(p.x)/aspect);}half*=1.08;this.camera.left=-half*aspect;this.camera.right=half*aspect;this.camera.top=half;this.camera.bottom=-half;this.camera.updateProjectionMatrix();}
  rotate(){const v=this.camera.position.clone().sub(this.controls.target);v.applyAxisAngle(new THREE.Vector3(0,0,1),Math.PI/6);this.camera.position.copy(this.controls.target).add(v);this.controls.update();this.resize();}
  zoom(factor){this.camera.zoom=Math.max(.4,Math.min(6,this.camera.zoom*factor));this.camera.updateProjectionMatrix();}
  update(s,selected){
    const c=s.config,signature=JSON.stringify([c,s.containers,s.trucks,selected]);
    if(signature!==this.signature){
      const resized=JSON.stringify(c)!==JSON.stringify(this.config);this.config=c;this.signature=signature;this.clear(this.fixed);this.pickable=[];
      this.box(this.fixed,0,0,-12,c.length,c.width,12,'#c4d5dc');
      this.box(this.fixed,0,0,-.8,c.transportLength,c.width,.5,'#e3dfd4');
      for(const p of slots(c)){
        this.box(this.fixed,p.x,p.y,0,c.containerLength,c.containerWidth,.4,'#e4edf1',{slot:p.id,title:`Case ${p.id} · X ${Math.round(p.x)} / Y ${Math.round(p.y)} mm`});
        this.label(this.fixed,p.id,p.x+c.containerLength/2,p.y+c.containerWidth/2,1,12);
      }
      for(let i=0;i<c.bays;i++){const p=bayPosition(c,i);this.label(this.fixed,'Q'+(i+1),c.transportLength/2,p.y-15,1,15);}
      for(const t of s.trucks){const p=bayPosition(c,t.bay);this.box(this.fixed,p.x-c.cabinLength,p.y,1,c.cabinLength,c.containerWidth,30,'#bc895c');this.box(this.fixed,p.x,p.y,0,c.containerLength,c.containerWidth,4,'#e5b87e');this.label(this.fixed,t.id,p.x-c.cabinLength/2,p.y+c.containerWidth/2,34,15);}
      for(const v of s.containers){if(!['stored','truck'].includes(v.state))continue;const p=position(s,v);const color=v.id===selected?'#32b998':s.operation?.blockers?.includes(v.id)&&['running','paused'].includes(s.operation.status)?'#bc9162':'#5488ab';this.box(this.fixed,p.x,p.y,p.z,c.containerLength,c.containerWidth,c.containerHeight,color,{container:v.id,title:`${v.id} · ${v.slot?'case '+v.slot+' / niveau '+v.level:'camion '+v.truck}`});this.label(this.fixed,v.id,p.x+c.containerLength/2,p.y+c.containerWidth/2,p.z+c.containerHeight+2,13);}
      this.label(this.fixed,'TRANSPORT',c.transportLength/2,-35,0,18);this.label(this.fixed,'STOCKAGE',c.transportLength+(c.length-c.transportLength)/2,-35,0,18);
      if(resized)this.reset();
    }
    const m=s.mission,key=JSON.stringify([m?.id,m?.waypoints,m?.interrupted]);
    if(key!==this.routeKey){this.routeKey=key;this.clear(this.route);this.carried=null;this.indicator=null;
      if(m){const h=c.levels*c.containerHeight+c.containerHeight*1.2;const points=m.waypoints||[m.start,{...m.start,z:h},{...m.end,z:h},m.end];const geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(p.x+c.containerLength/2,p.y+c.containerWidth/2,p.z+c.containerHeight)));const line=new THREE.Line(geometry,new THREE.LineDashedMaterial({color:'#0a9b7e',dashSize:8,gapSize:5}));line.computeLineDistances();this.route.add(line);
        this.carried=this.box(this.route,0,0,0,c.containerLength,c.containerWidth,c.containerHeight,m.interrupted?'#d34e4e':'#32b998');
        const geom=new THREE.BoxGeometry(c.containerLength*.8,c.containerWidth*.8,8);this.indicator=new THREE.LineSegments(new THREE.EdgesGeometry(geom),new THREE.LineBasicMaterial({color:'#7752ac'}));geom.dispose();this.route.add(this.indicator);
      }
    }
    if(m&&this.carried){const p=movingPosition(s);this.carried.position.set(p.x+c.containerLength/2,p.y+c.containerWidth/2,p.z+c.containerHeight/2);this.carried.visible=m.progress>=(m.pickupProgress??.15);this.indicator.position.set(p.x+c.containerLength/2,p.y+c.containerWidth/2,p.z+c.containerHeight+10);}
    this.controls.update();this.renderer.render(this.scene,this.camera);
  }
}
