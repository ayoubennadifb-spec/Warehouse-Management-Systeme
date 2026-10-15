import { randomUUID } from 'node:crypto';
import type { Client, Requeteur } from '../db.ts';
import { une, toutes } from '../db.ts';
import { ErreurMetier } from '../erreurs.ts';
import { journaliser, resoudreAlertes, type Source } from './journal.ts';
import { chargerContexte, evaluerDestination, evaluerSource, type Raison } from './regles.ts';

export async function detailConteneur(q: Requeteur, id: number) {
  const c = await une(
    q,
    `SELECT l.*, t.longueur_mm, t.largeur_mm, t.hauteur_mm, t.code AS type_code,
            c.derniere_x_mm, c.derniere_y_mm, c.derniere_z_mm, c.cree_le
       FROM v_conteneur_localisation l JOIN conteneur c ON c.id = l.id
       JOIN type_conteneur t ON t.id = c.type_conteneur_id WHERE l.id = $1`,
    [id],
  );
  if (!c) throw new ErreurMetier('CONTENEUR_INCONNU', `Conteneur ${id} introuvable.`, 404);
  const historique = await toutes(
    q,
    `SELECT h.etat, h.debut, h.fin, h.x_mm, h.y_mm, h.z_mm, h.mission_id, e.code AS emplacement
       FROM historique_localisation h LEFT JOIN emplacement e ON e.id = h.emplacement_id
      WHERE h.conteneur_id = $1 ORDER BY h.debut DESC, h.id DESC LIMIT 25`,
    [id],
  );
  const mission = await une(
    q,
    `SELECT id, statut, prise_confirmee_le FROM mission WHERE conteneur_id = $1
        AND statut IN ('EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE')`,
    [id],
  );
  let accessibilite: Raison[] = [];
  if (c.etat !== 'SORTI') {
    try {
      accessibilite = evaluerSource(await chargerContexte(q), id);
    } catch {
      accessibilite = [];
    }
  }
  return { ...c, historique, mission_active: mission, accessibilite };
}

/** Toutes les destinations du plan actif (+ plateaux des camions présents), avec les raisons de refus. */
export async function destinationsPossibles(q: Requeteur, conteneurId: number) {
  const ctx = await chargerContexte(q);
  const c = ctx.conteneurs.get(conteneurId);
  const incertain = c?.etat === 'INCERTAINE';
  // Pour une déclaration de position : les réservations « gelées » par ses propres missions seront
  // libérées, et une position bloquée ou la capacité n'empêchent pas de constater la réalité.
  const propres = new Set<number>();
  if (incertain) {
    const r = await toutes(
      q,
      `SELECT r.emplacement_id FROM reservation r JOIN mission m ON m.id = r.mission_id
        WHERE r.statut = 'ACTIVE' AND m.conteneur_id = $1 AND m.statut IN ('ANNULEE','TERMINEE','INTERROMPUE')`,
      [conteneurId],
    );
    for (const x of r) propres.add(x.emplacement_id);
    for (const id of propres) ctx.reservation.delete(id);
  }
  const source = incertain ? [] : evaluerSource(ctx, conteneurId);
  const destinations = [...ctx.emplacements.values()].map((e) => ({
    emplacement_id: e.id,
    code: e.code,
    type: e.type,
    raisons: evaluerDestination(ctx, conteneurId, e.id).filter((r) => !incertain || !['POSITION_BLOQUEE', 'CAPACITE'].includes(r.code)),
  }));
  return { source, destinations };
}

/**
 * L'opérateur déclare la position réelle d'un conteneur INCERTAIN (confirmation manuelle).
 * Libère les réservations « gelées » de ses missions et clôt une mission interrompue.
 */
export async function declarerPosition(
  c: Client,
  conteneurId: number,
  d: { emplacement_id?: number | null; sorti?: boolean; commentaire?: string | null },
  source: Source = 'OPERATEUR',
) {
  const cont = await une(c, 'SELECT * FROM conteneur WHERE id = $1 FOR UPDATE', [conteneurId]);
  if (!cont) throw new ErreurMetier('CONTENEUR_INCONNU', 'Conteneur introuvable.', 404);
  if (cont.etat !== 'INCERTAINE')
    throw new ErreurMetier('POSITION_NON_INCERTAINE', `${cont.code} n’est pas en position incertaine (${cont.etat}).`);
  const missions = await toutes(
    c,
    `UPDATE mission SET statut = 'ANNULEE', terminee_le = now(), motif_fin = 'Clôturée par déclaration de position'
      WHERE conteneur_id = $1 AND statut = 'INTERROMPUE' RETURNING id`,
    [conteneurId],
  );
  await c.query(
    `UPDATE trajet SET statut = 'ABANDONNE' WHERE statut IN ('PLANIFIE','EN_COURS') AND mission_id = ANY($1::int[])`,
    [missions.map((m) => m.id)],
  );
  await c.query(
    `UPDATE reservation r SET statut = 'LIBEREE', liberee_le = now(), motif_liberation = 'Position déclarée'
       FROM mission m WHERE m.id = r.mission_id AND m.conteneur_id = $1 AND r.statut = 'ACTIVE'
        AND m.statut IN ('ANNULEE','TERMINEE')`,
    [conteneurId],
  );
  let ou: string;
  if (d.sorti) {
    await c.query(`UPDATE conteneur SET etat = 'SORTI', motif_incertitude = NULL WHERE id = $1`, [conteneurId]);
    ou = 'sorti de la zone';
  } else {
    if (!d.emplacement_id) throw new ErreurMetier('EMPLACEMENT_REQUIS', 'Choisissez l’emplacement réel ou « sorti de la zone ».', 422);
    const ctx = await chargerContexte(c);
    // Une position bloquée ou une capacité n'empêchent pas de constater la réalité physique.
    const raisons = evaluerDestination(ctx, conteneurId, d.emplacement_id).filter((r) => !['POSITION_BLOQUEE', 'CAPACITE'].includes(r.code));
    if (raisons.length) throw new ErreurMetier('DECLARATION_IMPOSSIBLE', raisons.map((r) => r.message).join(' '), 409, { raisons });
    await c.query(`UPDATE conteneur SET etat = 'EN_PLACE', emplacement_id = $2, motif_incertitude = NULL WHERE id = $1`, [
      conteneurId,
      d.emplacement_id,
    ]);
    ou = `à ${ctx.emplacements.get(d.emplacement_id)!.code}`;
  }
  const conf = await une(
    c,
    `INSERT INTO confirmation (source, cle_idempotence, type, conteneur_id, resultat, donnees)
     VALUES ('OPERATEUR', $1, 'POSITION_DECLAREE', $2, 'APPLIQUEE', $3) RETURNING id`,
    [`OP-${randomUUID()}`, conteneurId, JSON.stringify({ emplacement_id: d.emplacement_id ?? null, sorti: !!d.sorti, commentaire: d.commentaire ?? null })],
  );
  await resoudreAlertes(c, { conteneur_id: conteneurId });
  for (const m of missions) await resoudreAlertes(c, { mission_id: m.id });
  await journaliser(c, {
    type: 'POSITION_DECLAREE',
    source,
    conteneur_id: conteneurId,
    emplacement_id: d.emplacement_id ?? null,
    confirmation_id: conf.id,
    message: `Position de ${cont.code} déclarée par l’opérateur : ${ou}${d.commentaire ? ` (${d.commentaire})` : ''}.`,
  });
}

export async function bloquerPosition(c: Client, positionId: number, motif: string | null, source: Source): Promise<void> {
  const p = await une(
    c,
    `SELECT p.* FROM position_sol p JOIN version_plan v ON v.id = p.version_plan_id WHERE p.id = $1 AND v.statut = 'ACTIVE'`,
    [positionId],
  );
  if (!p) throw new ErreurMetier('POSITION_INCONNUE', 'Position introuvable dans le plan actif.', 404);
  const m = motif?.trim() || null;
  await c.query(`UPDATE position_sol SET statut = $2, motif_blocage = $3 WHERE id = $1`, [positionId, m ? 'BLOQUEE' : 'DISPONIBLE', m]);
  await journaliser(c, {
    type: m ? 'POSITION_BLOQUEE' : 'POSITION_DEBLOQUEE',
    source,
    message: m ? `Position ${p.code} bloquée : ${m}.` : `Position ${p.code} débloquée.`,
  });
}
