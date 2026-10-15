import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {nouvelleBase,tx,positionDeHauteur,emp,pile} from './aide.ts';
import {chargerEtat} from '../src/server/domaine/etat.ts';
import {preparer,lancer,avancerOperation} from '../src/server/domaine/degagement.ts';
import {demarrerMission,confirmer,annuler} from '../src/server/domaine/missions.ts';
import {une} from '../src/server/db.ts';
let pool:pg.Pool;
before(async()=>{pool=await nouvelleBase();});after(async()=>pool.end());
test('aperçu natif, deux bloqueurs, positions enregistrées avant le transfert suivant',async()=>{
 const origin=await positionDeHauteur(pool,3);const codes=await pile(pool,origin);const e=await chargerEtat(pool);const target=e.conteneurs.find(v=>v.code===codes[0])!;
 const dest=await positionDeHauteur(pool,0);const destId=await emp(pool,dest+'-N1');
 const plan=await preparer(pool,target.id,destId);
 assert.deepEqual((await chargerEtat(pool)).conteneurs,e.conteneurs);
 assert.deepEqual(plan.steps.map((x:any)=>x.container),[codes[2],codes[1],codes[0]]);
 assert.ok(plan.emptyDistanceMm>0);assert.equal(plan.totalDistanceMm,plan.loadedDistanceMm+plan.emptyDistanceMm);
 await tx(pool,c=>lancer(c,target.id,destId,plan));
 for(let i=0;i<3;i++){
  const op=await une(pool,"SELECT * FROM operation_degagement WHERE statut='EN_COURS'");
  await tx(pool,async c=>{await demarrerMission(c,op.mission_id,'SIMULATION');await confirmer(c,{source:'SIMULATION',cle:'DG-'+i+'-P',type:'PRISE',mission_id:op.mission_id});await confirmer(c,{source:'SIMULATION',cle:'DG-'+i+'-D',type:'DEPOT',mission_id:op.mission_id});await avancerOperation(c);});
  const state=await chargerEtat(pool);assert.equal(state.conteneurs.find(v=>v.code===plan.steps[i].container)!.emplacement_id,plan.steps[i].destinationId);
 }
 const state=await chargerEtat(pool);assert.equal(state.operation.statut,'TERMINEE');assert.equal(state.conteneurs.find(v=>v.id===target.id)!.emplacement_id,destId);
 assert.equal(state.reservations.length,0);
});
test('aperçu périmé refusé et annulation arrête les étapes restantes',async()=>{
 const e=await chargerEtat(pool);const target=e.conteneurs.find(v=>v.type_emplacement==='CASE'&&!e.conteneurs.some(u=>u.code_position===v.code_position&&u.niveau!>v.niveau!))!;
 const dest=await positionDeHauteur(pool,0);const destId=await emp(pool,dest+'-N1');const plan=await preparer(pool,target.id,destId);
 await assert.rejects(tx(pool,c=>lancer(c,target.id,destId,{...plan,revision:'obsolete'})),/scène a changé/);
 await tx(pool,c=>lancer(c,target.id,destId,plan));
 const op=await une(pool,"SELECT * FROM operation_degagement WHERE statut='EN_COURS'");
 await tx(pool,async c=>{await annuler(c,op.mission_id,'test','OPERATEUR');await avancerOperation(c);});
 assert.equal((await chargerEtat(pool)).operation.statut,'ANNULEE');
});
