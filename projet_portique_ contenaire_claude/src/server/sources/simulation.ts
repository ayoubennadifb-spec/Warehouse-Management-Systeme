import { calculer, destination, avancerOperation } from '../domaine/degagement.ts';
import { chargerEtat } from '../domaine/etat.ts';
/**
 * Source d'événements SIMULÉE : une unité de manutention abstraite exécute les missions une par une
 * et produit des confirmations SIMULÉES (source = 'SIMULATION', clés d'idempotence stables).
 *
 * Trajets A* avec obstacles connus, approche à vide et profil d’accélération provisoire.
 * Confirmations simulées ; la géométrie mécanique reste à calibrer.
 */
import type pg from 'pg';
import { transaction, une } from '../db.ts';
import type { ConfigSimulation } from '../config.ts';
import type { Diffuseur } from '../temps-reel.ts';
import type { EtatSource, SourceEvenements } from './types.ts';
import {
  confirmer,
  demarrerMission,
  enregistrerTrajet,
  interrompre,
  lireMission,
  majPositionUnite,
  reprendre,
  suspendre,
  unite,
  type Point3,
} from '../domaine/missions.ts';

type Etape =
  | { type: 'MOUVEMENT'; cible: Point3; vitesse: number; duree?: number; depart?: Point3; libelle: string }
  | { type: 'PRISE' | 'DEPOT'; duree: number; libelle: string };

interface Tache {
  missionId: number;
  conteneurId: number;
  etapes: Etape[];
  i: number;
  attente: number;
  porte: boolean;
  trajetVersion: number;
  suspendue: boolean;
  total: number;
}

export class SimulationSource implements SourceEvenements {
  readonly mode = 'SIMULATION' as const;
  private pool: pg.Pool;
  private diff: Diffuseur;
  private cfg: ConfigSimulation;
  private pos: Point3 = { x: 0, y: 0, z: 0 };
  private tache: Tache | null = null;
  private pause = false;
  private vitesse = 1;
  private bloque: string | null = null;
  private erreur: string | null = null;
  private occupe = false;
  private minuterie: NodeJS.Timeout | null = null;
  private dernierTick = performance.now();
  private derniereVerif = 0;
  private derniereTelemetrie = 0;

  constructor(pool: pg.Pool, diff: Diffuseur, cfg: ConfigSimulation) {
    this.pool = pool;
    this.diff = diff;
    this.cfg = cfg;
  }

  async demarrer(): Promise<void> {
    await this.recupererApresRedemarrage();
    const u = await unite(this.pool).catch(() => null);
    if (u && u.x_mm !== null) this.pos = { x: u.x_mm, y: u.y_mm!, z: u.z_mm! };
    else {this.pos = { x: this.cfg.position_repos.x_mm, y: this.cfg.position_repos.y_mm, z: await this.hauteurPassage() };await transaction(this.pool,c=>majPositionUnite(c,this.pos,'SIMULATION'));}
    this.dernierTick = performance.now();
    this.minuterie = setInterval(() => void this.tick(), this.cfg.periode_tick_ms);
  }

  async arreter(): Promise<void> {
    if (this.minuterie) clearInterval(this.minuterie);
    this.minuterie = null;
  }

  etat(): EtatSource {
    return {
      mode: 'SIMULATION',
      connecte: true,
      description: 'Simulation : unité de manutention abstraite, confirmations simulées (aucun matériel).',
      en_pause: this.pause,
      vitesse: this.vitesse,
      bloque: this.bloque,
      erreur: this.erreur,
      mission_id: this.tache?.missionId ?? null,
    };
  }

  /** Après un redémarrage, l'exécution en mémoire est perdue : on le dit, sans rien inventer. */
  private async recupererApresRedemarrage(): Promise<void> {
    await transaction(this.pool, async (c) => {
      const r = await c.query(`SELECT id FROM mission WHERE statut = 'EN_COURS' AND executant = 'SIMULATION'`);
      for (const m of r.rows)
        await interrompre(c, m.id, 'Redémarrage du serveur : exécution simulée perdue, état réel non garanti', 'SYSTEME');
    });
  }

  private async hauteurPassage(): Promise<number> {
    const p = await une(
      this.pool,
      `SELECT v.nb_niveaux_max * t.hauteur_mm AS h FROM version_plan v JOIN type_conteneur t ON t.id = v.type_conteneur_id WHERE v.statut = 'ACTIVE'`,
    );
    return (p?.h ?? 150) + this.cfg.degagement_mm;
  }

  // ------------------------------------------------------------------ commandes
  async mettreEnPause(): Promise<void> {
    this.pause = true;
    if (this.tache && !this.tache.suspendue) {
      await transaction(this.pool, (c) => suspendre(c, this.tache!.missionId, 'SIMULATION', this.pos)).catch(() => undefined);
      this.tache.suspendue = true;
    }
    this.diff.signalerSource();
  }

  async reprendreSimulation(): Promise<void> {
    this.pause = false;
    this.dernierTick = performance.now();
    if (this.tache?.suspendue) {
      await transaction(this.pool, (c) => reprendre(c, this.tache!.missionId, 'SIMULATION')).catch(() => undefined);
      this.tache.suspendue = false;
    }
    this.diff.signalerSource();
  }

  definirVitesse(f: number): void {
    this.vitesse = Math.min(Math.max(f, 0.25), 20);
    this.diff.signalerSource();
  }

  async incident(motif: string): Promise<number> {
    if (!this.tache) throw new Error('Aucune mission en cours d’exécution.');
    const id = this.tache.missionId;
    this.tache = null;
    await transaction(this.pool, (c) => interrompre(c, id, motif, 'SIMULATION', this.pos));
    return id;
  }

  // ------------------------------------------------------------------ boucle
  private async tick(): Promise<void> {
    if (this.occupe) return;
    this.occupe = true;
    const t = performance.now();
    const dt = ((t - this.dernierTick) / 1000) * this.vitesse;
    this.dernierTick = t;
    try {
      if (!this.tache) {
        if (t - this.derniereVerif > 400) {
          this.derniereVerif = t;
          await this.chercherTravail();
        }
      } else {
        if (t - this.derniereVerif > 400) {
          this.derniereVerif = t;
          await this.verifierStatut();
        }
        if (this.tache && !this.pause && !this.tache.suspendue) await this.avancer(dt);
      }
      this.erreur = null;
    } catch (e) {
      this.erreur = (e as Error).message;
    } finally {
      this.occupe = false;
    }
    this.emettreTelemetrie(t);
  }

  private emettreTelemetrie(t: number): void {
    const periode = 1000 / (this.tache && !this.pause ? this.cfg.frequence_telemetrie_hz : 1);
    if (t - this.derniereTelemetrie < periode) return;
    this.derniereTelemetrie = t;
    const e = this.tache ? this.tache.etapes[this.tache.i] : null;
    this.diff.telemetrie({
      source: 'SIMULATION',
      t: new Date().toISOString(),
      x: Math.round(this.pos.x * 10) / 10,
      y: Math.round(this.pos.y * 10) / 10,
      z: Math.round(this.pos.z * 10) / 10,
      mission_id: this.tache?.missionId ?? null,
      conteneur_porte_id: this.tache?.porte ? this.tache.conteneurId : null,
      etape: e?.libelle ?? (this.bloque ? 'bloquée' : 'au repos'),
      progression: this.tache ? Math.min(this.tache.i / this.tache.total, 1) : null,
      en_pause: this.pause || !!this.tache?.suspendue,
    });
  }

  private async verifierStatut(): Promise<void> {
    const m = await une(this.pool, 'SELECT statut FROM mission WHERE id = $1', [this.tache!.missionId]);
    if (!m || !['EN_COURS', 'SUSPENDUE'].includes(m.statut)) {
      this.tache = null; // annulée, interrompue ou terminée par ailleurs
      return;
    }
    this.tache!.suspendue = m.statut === 'SUSPENDUE';
  }

  private async chercherTravail(): Promise<void> {
    await transaction(this.pool,c=>avancerOperation(c));
    if (this.pause) return;
    const enCours = await une(this.pool, `SELECT id FROM mission WHERE statut = 'EN_COURS' ORDER BY id LIMIT 1`);
    if (enCours) {
      await this.preparer(enCours.id, 'Reprise de la mission');
      return;
    }
    const b = await une(
      this.pool,
      `SELECT (SELECT string_agg('M' || id, ', ') FROM mission WHERE statut = 'INTERROMPUE') AS interrompues,
              (SELECT string_agg(code, ', ') FROM conteneur WHERE etat = 'INCERTAINE') AS incertains,
              (SELECT string_agg('M' || id, ', ') FROM mission WHERE statut = 'SUSPENDUE') AS suspendues`,
    );
    const bloque = b.interrompues
      ? `File arrêtée : mission(s) interrompue(s) ${b.interrompues} à traiter.`
      : b.incertains
        ? `File arrêtée : position incertaine (${b.incertains}) à déclarer.`
        : b.suspendues
          ? `Mission ${b.suspendues} suspendue : reprenez-la pour continuer.`
          : null;
    if (bloque !== this.bloque) {
      this.bloque = bloque;
      this.diff.signalerSource();
    }
    if (bloque) return;
    const suivante = await une(this.pool, `SELECT id FROM mission WHERE statut = 'EN_ATTENTE' ORDER BY demandee_le, id LIMIT 1`);
    if (!suivante) return;
    await transaction(this.pool, (c) => demarrerMission(c, suivante.id, 'SIMULATION'));
    await this.preparer(suivante.id, 'Trajet initial');
  }

  private async preparer(missionId: number, motif: string): Promise<void> {
    const m = await lireMission(this.pool, missionId);
    const src = await une(this.pool, 'SELECT * FROM coord_emplacement($1)', [m.source_emplacement_id]);
    const dst = await une(this.pool, 'SELECT * FROM coord_emplacement($1)', [m.destination_emplacement_id]);
    if (dst?.x === null || dst?.x === undefined) throw new Error(`Destination de M${missionId} sans coordonnées.`);
    const porte = !!m.prise_confirmee_le;
    const state=await chargerEtat(this.pool);
    const plan=await calculer(porte?{mode:'resume',state,start:{x:this.pos.x-state.plan!.parametres.conteneur.longueur_mm/2,y:this.pos.y-state.plan!.parametres.conteneur.largeur_mm/2,z:this.pos.z},end:{x:dst.x-state.plan!.parametres.conteneur.longueur_mm/2,y:dst.y-state.plan!.parametres.conteneur.largeur_mm/2,z:dst.z}}:{mode:'move',state,container:m.conteneur_code,destination:destination(state,m.destination_emplacement_id),position:{x_mm:this.pos.x,y_mm:this.pos.y,z_mm:this.pos.z}});
    const step=plan.steps[0];const etapes:Etape[]=[];const pts:(Point3&{type:string})[]=[{...this.pos,type:'DEPART'}];
    const append=(points:Point3[],durations:number[],label:string)=>{
      for(let i=1;i<points.length;i++){
        const depart=points[i-1],cible=points[i];const distance=Math.hypot(cible.x-depart.x,cible.y-depart.y,cible.z-depart.z);
        const vertical=Math.abs(cible.z-depart.z)>.01;
        etapes.push({type:'MOUVEMENT',cible,depart,duree:durations[i-1],vitesse:vertical?50:100,libelle:label});pts.push({...cible,type:'PASSAGE'});
      }
    };
    if(!porte){append(step.emptyWaypoints,step.emptySegmentSeconds,'Approche à vide');etapes.push({type:'PRISE',duree:1,libelle:'prise'});pts.push({...step.waypoints[0],type:'PRISE'});}
    append(step.waypoints,step.loadedSegmentSeconds,'Transport en charge');etapes.push({type:'DEPOT',duree:1,libelle:'dépôt'});pts.push({...step.waypoints.at(-1),type:'DEPOT'});
    const duree=step.estimatedSeconds;
    const t = await transaction(this.pool, (c) =>
      enregistrerTrajet(c, missionId, pts, { algorithme: 'ASTAR_CYCLE_COMPLET', motif, duree_estimee_s: Math.round(duree * 10) / 10 }),
    );
    await this.pool.query('UPDATE trajet SET optimise=true WHERE id=$1',[t.id]);
    this.tache = { missionId, conteneurId: m.conteneur_id, etapes, i: 0, attente: 0, porte, trajetVersion: t.version, suspendue: false, total: etapes.length };
    this.bloque = null;
    this.diff.signalerSource();
  }

  private async avancer(dt: number): Promise<void> {
    const tache = this.tache!;
    let reste = dt;
    while (reste > 0 && this.tache === tache && tache.i < tache.etapes.length) {
      const e = tache.etapes[tache.i];
      if (e.type === 'MOUVEMENT') {
        const start=e.depart??this.pos;const dx=e.cible.x-start.x,dy=e.cible.y-start.y,dz=e.cible.z-start.z;
        const distance=Math.hypot(dx,dy,dz);const duration=e.duree??distance/e.vitesse;
        const used=Math.min(reste,Math.max(0,duration-tache.attente));tache.attente+=used;reste-=used;
        const acceleration=Math.abs(dz)>.01?100:200;
        const peak=Math.min(e.vitesse,Math.sqrt(distance*acceleration));const ramp=peak/acceleration;
        const t=Math.min(tache.attente,duration);
        const traveled=t<ramp?.5*acceleration*t*t:t>duration-ramp?distance-.5*acceleration*(duration-t)**2:peak*(t-ramp/2);
        const ratio=distance?Math.min(1,Math.max(0,traveled/distance)):1;
        this.pos={x:start.x+dx*ratio,y:start.y+dy*ratio,z:start.z+dz*ratio};
        if(tache.attente>=duration-1e-8){this.pos={...e.cible};tache.attente=0;tache.i++;}
        else reste=0;
      } else {
        tache.attente += reste;
        if (tache.attente < e.duree) return;
        reste = tache.attente - e.duree;
        tache.attente = 0;
        const r = await transaction(this.pool, (c) =>
          confirmer(c, {
            source: 'SIMULATION',
            cle: `SIM-M${tache.missionId}-T${tache.trajetVersion}-${e.type}`,
            type: e.type as 'PRISE' | 'DEPOT',
            mission_id: tache.missionId,
            horodatage_source: new Date().toISOString(),
            position: this.pos,
          }),
        );
        if (r.resultat === 'REJETEE') {
          this.tache = null;
          await transaction(this.pool, (c) => interrompre(c, tache.missionId, `Confirmation simulée rejetée : ${r.motif}`, 'SIMULATION', this.pos)).catch(
            () => undefined,
          );
          return;
        }
        if (e.type === 'PRISE') tache.porte = true;
        else tache.porte = false;
        tache.i++;
      }
    }
    if (this.tache === tache && tache.i >= tache.etapes.length) {
      this.tache = null;
      await transaction(this.pool, (c) => majPositionUnite(c, this.pos, 'SIMULATION'));
      this.diff.signalerSource();
    }
  }
}
