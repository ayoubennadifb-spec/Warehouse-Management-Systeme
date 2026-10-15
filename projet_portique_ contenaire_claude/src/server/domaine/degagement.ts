import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RACINE } from '../config.ts';
import { une, toutes, type Requeteur, type Client } from '../db.ts';
import { chargerEtat } from './etat.ts';
import { creerMission } from './missions.ts';
import { chargerContexte, evaluerSource, evaluerDestination } from './regles.ts';
import { ErreurMetier } from '../erreurs.ts';
import { journaliser } from './journal.ts';

export function empreinte(e:any):string {return createHash('sha256').update(JSON.stringify([e.plan?.id,e.conteneurs,e.visites,e.reservations,e.missions.filter((m:any)=>['EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE'].includes(m.statut)),e.unite?.x_mm,e.unite?.y_mm,e.unite?.z_mm])).digest('hex');}
export async function calculer(b:any):Promise<any>{
 const bundled=path.resolve(RACINE,'../.venv/Scripts/python.exe');
 const python=process.env.PLANNER_PYTHON??(existsSync(bundled)?bundled:'python');
 return new Promise((resolve,reject)=>{
  const child=spawn(python,[path.join(RACINE,'planner/bridge.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';let error='';
  const timer=setTimeout(()=>{child.kill();reject(new ErreurMetier('CALCUL_TROP_LONG','Le calcul a dépassé deux minutes. Réduisez la grille.',409));},120000);
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(code||result.error)reject(new ErreurMetier('PLAN_IMPOSSIBLE',result.error??error,409));else resolve(result);}catch{reject(new Error('Planificateur indisponible : '+error));}});
  child.stdin.end(JSON.stringify(b));
 });
}
export function destination(e:any,id:number):string{
 const em=e.plan.geometrie.emplacements.find((x:any)=>x.id===id);
 if(em){const pos=e.plan.geometrie.positions.find((x:any)=>x.id===em.position_sol_id);return 'slot:'+pos.code;}
 const visit=e.visites.find((x:any)=>x.plateau_emplacement_id===id);if(visit)return 'truck:'+visit.camion_code;
 throw new ErreurMetier('DESTINATION_ABSENTE','Destination absente du plan.',409);
}
export async function preparer(q:Requeteur,containerId:number,destId:number){
 const ctx=await chargerContexte(q);const reasons=[...evaluerSource(ctx,containerId).filter(x=>x.code!=='PAS_AU_SOMMET'),...evaluerDestination(ctx,containerId,destId)];
 if(reasons.length)throw new ErreurMetier('DEGAGEMENT_REFUSE',reasons.map(x=>x.message).join(' '),409);
 if(await une(q,"SELECT 1 FROM mission WHERE statut IN ('EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE') LIMIT 1"))throw new ErreurMetier('MISSION_ACTIVE','Terminez les missions avant de calculer un dégagement.',409);
 const e=await chargerEtat(q);const v=e.conteneurs.find(x=>x.id===containerId)!;
 const plan=await calculer({mode:'retrieval',state:e,container:v.code,destination:destination(e,destId)});
 plan.revision=empreinte(e);
 for(const step of plan.steps){step.containerId=e.conteneurs.find(x=>x.code===step.container)!.id;step.destinationId=await emplacement(q,step,step.waypoints.at(-1).z);}
 return plan;
}
async function emplacement(q:Requeteur,step:any,z:number){
 const [kind,code]=step.destination.split(':');
 if(kind==='truck')return (await une(q,"SELECT e.id FROM emplacement e JOIN camion c ON c.id=e.camion_id JOIN visite_camion v ON v.camion_id=c.id WHERE c.code=$1 AND v.statut='PRESENTE'",[code])).id;
 return (await une(q,"SELECT e.id FROM emplacement e JOIN position_sol p ON p.id=e.position_sol_id JOIN version_plan v ON v.id=p.version_plan_id WHERE v.statut='ACTIVE' AND p.code=$1 AND abs(e.z_base_mm-$2)<0.01",[code,z])).id;
}
export async function lancer(c:Client,containerId:number,destId:number,plan:any){
 // Use a transaction-consistent native snapshot without opening a nested transaction.
 const fingerprint=await empreinteCourante(c);
 if(plan.revision!==fingerprint)throw new ErreurMetier('PLAN_PERIME','La scène a changé : recalculez le plan.',409);
 if(await une(c,"SELECT 1 FROM operation_degagement WHERE statut='EN_COURS'"))throw new ErreurMetier('OPERATION_ACTIVE','Un dégagement est déjà en cours.',409);
 const op=await une(c,'INSERT INTO operation_degagement(cible_id,destination_id,plan) VALUES($1,$2,$3) RETURNING *',[containerId,destId,JSON.stringify(plan)]);
 await journaliser(c,{type:'DEGAGEMENT_LANCE',source:'SIMULATION',conteneur_id:containerId,message:`Dégagement planifié : ${plan.steps.length} transfert(s), ${Math.round(plan.totalDistanceMm)} mm, ${plan.estimatedSeconds.toFixed(1)} s estimées.`});
 await avancerOperation(c);return op;
}
export async function empreinteCourante(c:Client){return empreinte(await lireEtatTransaction(c));}
// Exported native snapshot reader avoids chargerEtat's BEGIN when already inside a write transaction.
import { lireEtatTransaction } from './etat.ts';
export async function avancerOperation(c:Client){
 const op=await une(c,"SELECT * FROM operation_degagement WHERE statut='EN_COURS' FOR UPDATE");if(!op)return;
 if(op.mission_id){const m=await une(c,'SELECT statut FROM mission WHERE id=$1',[op.mission_id]);
  if(m.statut==='TERMINEE')op.indice++;
  else if(['INTERROMPUE','ANNULEE'].includes(m.statut)){await c.query("UPDATE operation_degagement SET statut=$2 WHERE id=$1",[op.id,m.statut]);await journaliser(c,{type:'DEGAGEMENT_ARRETE',source:'SYSTEME',message:'Dégagement arrêté ; positions déjà confirmées conservées.'});return;}
  else return;
 }
 if(op.indice>=op.plan.steps.length){await c.query("UPDATE operation_degagement SET statut='TERMINEE',indice=$2 WHERE id=$1",[op.id,op.indice]);await journaliser(c,{type:'DEGAGEMENT_TERMINE',source:'SIMULATION',message:'Cible extraite ; positions des conteneurs dégagés enregistrées.'});return;}
 const step=op.plan.steps[op.indice];
 try {const mission=await creerMission(c,{conteneur_id:step.containerId,destination_emplacement_id:step.destinationId},'SYSTEME');await c.query('UPDATE operation_degagement SET indice=$2,mission_id=$3 WHERE id=$1',[op.id,op.indice,mission.id]);}
 catch(error){throw error;}
}
