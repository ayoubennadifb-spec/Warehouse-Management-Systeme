/**
 * Camions, postes et visites.
 * Camion = entité stable (code) ; poste = place de stationnement d'un plan ; visite = un passage
 * d'un camion (arrivée → départ), éventuellement REFUSÉE (tracée, sans poste).
 */
import type { Client } from '../db.ts';
import { une, toutes } from '../db.ts';
import { ErreurMetier } from '../erreurs.ts';
import { geometrieCamion } from '../../shared/geometrie.ts';
import { journaliser, type Source } from './journal.ts';
import { exigerPlanActif } from './plans.ts';

export interface DemandeArrivee {
  camion_code: string;
  conteneur_code?: string | null;
  poste_code?: string | null;
  demo?: boolean;
}

export type ResultatArrivee =
  | { accepte: true; visite_id: number; poste_code: string; camion_id: number; conteneur_id: number | null }
  | { accepte: false; visite_id: number; code: string; motif: string };

export async function arriveeCamion(c: Client, d: DemandeArrivee, source: Source): Promise<ResultatArrivee> {
  const plan = await exigerPlanActif(c);
  const code = d.camion_code.trim();
  if (!code) throw new ErreurMetier('CODE_CAMION_VIDE', 'Le code du camion est obligatoire.', 422);
  let camion = await une(c, 'SELECT * FROM camion WHERE code = $1', [code]);
  if (!camion) camion = await une(c, 'INSERT INTO camion (code, type_camion_id, demo) VALUES ($1,$2,$3) RETURNING *', [code, plan.type_camion_id, !!d.demo]);
  const codeCont = d.conteneur_code?.trim() || null;

  const refuser = async (cd: string, motif: string): Promise<ResultatArrivee> => {
    const v = await une(
      c,
      `INSERT INTO visite_camion (camion_id, version_plan_id, statut, code_conteneur_annonce, motif_refus)
       VALUES ($1,$2,'REFUSEE',$3,$4) RETURNING id`,
      [camion.id, plan.id, codeCont, motif],
    );
    await journaliser(c, {
      type: 'ARRIVEE_REFUSEE',
      source,
      gravite: 'AVERTISSEMENT',
      camion_id: camion.id,
      visite_id: v.id,
      message: `Arrivée du camion ${code} refusée : ${motif}`,
    });
    return { accepte: false, visite_id: v.id, code: cd, motif };
  };

  const present = await une(
    c,
    `SELECT pt.code FROM visite_camion v JOIN poste_transport pt ON pt.id = v.poste_id WHERE v.camion_id = $1 AND v.statut = 'PRESENTE'`,
    [camion.id],
  );
  if (present) return refuser('CAMION_DEJA_PRESENT', `ce camion est déjà présent au poste ${present.code}.`);

  const postes = await toutes(
    c,
    `SELECT pt.*, (v.id IS NOT NULL) AS occupe FROM poste_transport pt
       LEFT JOIN visite_camion v ON v.poste_id = pt.id AND v.statut = 'PRESENTE'
      WHERE pt.version_plan_id = $1 ORDER BY pt.code`,
    [plan.id],
  );
  let poste;
  if (d.poste_code) {
    poste = postes.find((p) => p.code === d.poste_code);
    if (!poste) return refuser('POSTE_INCONNU', `le poste ${d.poste_code} n’existe pas dans le plan actif.`);
    if (poste.statut !== 'DISPONIBLE') return refuser('POSTE_HORS_SERVICE', `le poste ${poste.code} est hors service (${poste.motif_indisponibilite}).`);
    if (poste.occupe) return refuser('POSTE_OCCUPE', `le poste ${poste.code} est déjà occupé.`);
  } else {
    poste = postes.find((p) => p.statut === 'DISPONIBLE' && !p.occupe);
    if (!poste) {
      const hs = postes.filter((p) => p.statut !== 'DISPONIBLE').length;
      return refuser(
        'AUCUN_POSTE_DISPONIBLE',
        `aucun poste disponible (${postes.filter((p) => p.occupe).length}/${postes.length} occupés${hs ? `, ${hs} hors service` : ''}).`,
      );
    }
  }
  const tc = await une(c, 'SELECT * FROM type_camion WHERE id = $1', [camion.type_camion_id]);
  const longueur = tc.cabine_longueur_mm + tc.plateau_longueur_mm;
  const largeur = Math.max(tc.cabine_largeur_mm, tc.plateau_largeur_mm);
  if (longueur > poste.longueur_x_mm + 1e-6 || largeur > poste.largeur_y_mm + 1e-6)
    return refuser('CAMION_TROP_GRAND', `le camion (${longueur} × ${largeur} mm) ne tient pas au poste ${poste.code} (${poste.longueur_x_mm} × ${poste.largeur_y_mm} mm).`);

  let conteneur = null;
  if (codeCont) {
    conteneur = await une(c, 'SELECT * FROM conteneur WHERE code = $1', [codeCont]);
    if (conteneur && conteneur.etat !== 'SORTI') return refuser('CONTENEUR_DEJA_PRESENT', `le conteneur ${codeCont} est déjà enregistré dans la zone (${conteneur.etat}).`);
    if (plan.perimetre_capacite === 'ZONE') {
      const n = (await une(c, `SELECT count(*)::int AS n FROM conteneur WHERE etat <> 'SORTI'`)).n;
      if (n + 1 > plan.nb_conteneurs_max)
        return refuser('CAPACITE', `capacité atteinte : ${n}/${plan.nb_conteneurs_max} conteneurs déjà présents dans la zone.`);
    }
    const typeId = conteneur?.type_conteneur_id ?? plan.type_conteneur_id;
    const t = await une(c, 'SELECT * FROM type_conteneur WHERE id = $1', [typeId]);
    if (t.longueur_mm > tc.plateau_longueur_mm + 1e-6 || t.largeur_mm > tc.plateau_largeur_mm + 1e-6)
      return refuser('PLATEAU_TROP_PETIT', `le plateau ne peut pas porter un conteneur de ${t.longueur_mm} × ${t.largeur_mm} mm.`);
  }

  const g = geometrieCamion(poste.centre_x_mm, poste.centre_y_mm, poste.cote_cabine, tc);
  const v = await une(
    c,
    `INSERT INTO visite_camion (camion_id, poste_id, version_plan_id, statut, code_conteneur_annonce, plateau_x_mm, plateau_y_mm, plateau_z_mm)
     VALUES ($1,$2,$3,'PRESENTE',$4,$5,$6,$7) RETURNING id`,
    [camion.id, poste.id, plan.id, codeCont, g.plateau.x, g.plateau.y, g.plateau.z],
  );
  const plateau = await une(
    c,
    `INSERT INTO emplacement (type, code, camion_id) VALUES ('PLATEAU', $1, $2)
     ON CONFLICT (camion_id) DO UPDATE SET code = emplacement.code RETURNING id`,
    [`PLATEAU-${code}`, camion.id],
  );
  let conteneurId: number | null = null;
  if (codeCont) {
    if (conteneur) {
      await c.query(`UPDATE conteneur SET etat = 'EN_PLACE', emplacement_id = $2 WHERE id = $1`, [conteneur.id, plateau.id]);
      conteneurId = conteneur.id;
    } else {
      const n = await une(
        c,
        `INSERT INTO conteneur (code, type_conteneur_id, etat, emplacement_id, demo) VALUES ($1,$2,'EN_PLACE',$3,$4) RETURNING id`,
        [codeCont, plan.type_conteneur_id, plateau.id, !!d.demo],
      );
      conteneurId = n.id;
    }
    await c.query('UPDATE visite_camion SET conteneur_arrivee_id = $2 WHERE id = $1', [v.id, conteneurId]);
  }
  await journaliser(c, {
    type: 'CAMION_ARRIVE',
    source,
    camion_id: camion.id,
    visite_id: v.id,
    conteneur_id: conteneurId,
    message: `Camion ${code} arrivé au poste ${poste.code}${codeCont ? ` avec le conteneur ${codeCont}` : ' (vide)'}.`,
  });
  return { accepte: true, visite_id: v.id, poste_code: poste.code, camion_id: camion.id, conteneur_id: conteneurId };
}

export async function departCamion(c: Client, visiteId: number, source: Source): Promise<{ conteneur_code: string | null }> {
  const v = await une(
    c,
    `SELECT v.*, k.code AS camion_code, pt.code AS poste_code FROM visite_camion v
       JOIN camion k ON k.id = v.camion_id LEFT JOIN poste_transport pt ON pt.id = v.poste_id
      WHERE v.id = $1 FOR UPDATE OF v`,
    [visiteId],
  );
  if (!v) throw new ErreurMetier('VISITE_INCONNUE', `Visite ${visiteId} introuvable.`, 404);
  if (v.statut !== 'PRESENTE') throw new ErreurMetier('VISITE_TERMINEE', `Le camion ${v.camion_code} n’est pas présent (visite ${v.statut}).`);
  const plateau = await une(c, 'SELECT id FROM emplacement WHERE camion_id = $1', [v.camion_id]);
  const engage = plateau
    ? await une(
        c,
        `SELECT r.mission_id, m.statut, c.code FROM reservation r JOIN mission m ON m.id = r.mission_id
           JOIN conteneur c ON c.id = m.conteneur_id WHERE r.emplacement_id = $1 AND r.statut = 'ACTIVE'`,
        [plateau.id],
      )
    : null;
  if (engage)
    throw new ErreurMetier(
      'CAMION_EN_TRANSFERT',
      `Départ refusé : le camion ${v.camion_code} est impliqué dans la mission M${engage.mission_id} (${engage.code}, ${engage.statut}). Terminez ou annulez d’abord cette mission.`,
    );
  const cont = plateau ? await une(c, 'SELECT id, code FROM conteneur WHERE emplacement_id = $1', [plateau.id]) : null;
  if (cont) await c.query(`UPDATE conteneur SET etat = 'SORTI', emplacement_id = NULL WHERE id = $1`, [cont.id]);
  await c.query(`UPDATE visite_camion SET statut = 'PARTIE', depart_le = now(), conteneur_depart_id = $2 WHERE id = $1`, [visiteId, cont?.id ?? null]);
  await journaliser(c, {
    type: 'CAMION_PARTI',
    source,
    camion_id: v.camion_id,
    visite_id: visiteId,
    conteneur_id: cont?.id ?? null,
    message: `Camion ${v.camion_code} parti du poste ${v.poste_code}${cont ? ` avec ${cont.code} (sorti de la zone)` : ' à vide'}.`,
  });
  return { conteneur_code: cont?.code ?? null };
}

export async function statutPoste(c: Client, posteId: number, horsService: boolean, motif: string | null, source: Source): Promise<void> {
  const p = await une(c, 'SELECT pt.*, v.statut AS vstat FROM poste_transport pt JOIN version_plan v ON v.id = pt.version_plan_id WHERE pt.id = $1', [posteId]);
  if (!p || p.vstat !== 'ACTIVE') throw new ErreurMetier('POSTE_INCONNU', 'Poste introuvable dans le plan actif.', 404);
  if (horsService && !motif?.trim()) throw new ErreurMetier('MOTIF_REQUIS', 'Indiquez le motif de mise hors service.', 422);
  await c.query(`UPDATE poste_transport SET statut = $2, motif_indisponibilite = $3 WHERE id = $1`, [
    posteId,
    horsService ? 'HORS_SERVICE' : 'DISPONIBLE',
    horsService ? motif!.trim() : null,
  ]);
  await journaliser(c, {
    type: horsService ? 'POSTE_HORS_SERVICE' : 'POSTE_REMIS_EN_SERVICE',
    source,
    message: horsService ? `Poste ${p.code} hors service : ${motif}.` : `Poste ${p.code} remis en service.`,
  });
}
