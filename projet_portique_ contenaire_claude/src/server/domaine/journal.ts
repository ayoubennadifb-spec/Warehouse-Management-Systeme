import type { Client } from '../db.ts';

export type Source = 'SIMULATION' | 'MATERIEL' | 'OPERATEUR' | 'SYSTEME';
export type Gravite = 'INFO' | 'AVERTISSEMENT' | 'ALERTE';

export interface NouvelEvenement {
  type: string;
  message: string;
  source: Source;
  gravite?: Gravite;
  horodatage_source?: string | null;
  version_plan_id?: number | null;
  conteneur_id?: number | null;
  mission_id?: number | null;
  visite_id?: number | null;
  camion_id?: number | null;
  emplacement_id?: number | null;
  confirmation_id?: number | null;
  donnees?: Record<string, unknown>;
}

/** Ajoute un événement au journal (append-only). La notification temps réel part au COMMIT. */
export async function journaliser(c: Client, e: NouvelEvenement): Promise<number> {
  const r = await c.query(
    `INSERT INTO evenement (type, message, source, gravite, horodatage_source, version_plan_id, conteneur_id,
                            mission_id, visite_id, camion_id, emplacement_id, confirmation_id, donnees)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      e.type,
      e.message,
      e.source,
      e.gravite ?? 'INFO',
      e.horodatage_source ?? null,
      e.version_plan_id ?? null,
      e.conteneur_id ?? null,
      e.mission_id ?? null,
      e.visite_id ?? null,
      e.camion_id ?? null,
      e.emplacement_id ?? null,
      e.confirmation_id ?? null,
      JSON.stringify(e.donnees ?? {}),
    ],
  );
  return r.rows[0].id;
}

export async function ouvrirAlerte(
  c: Client,
  a: { type: string; gravite: 'INFO' | 'AVERTISSEMENT' | 'CRITIQUE'; message: string; mission_id?: number | null; conteneur_id?: number | null; donnees?: object },
): Promise<number> {
  const r = await c.query(
    `INSERT INTO alerte (type, gravite, message, mission_id, conteneur_id, donnees) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [a.type, a.gravite, a.message, a.mission_id ?? null, a.conteneur_id ?? null, JSON.stringify(a.donnees ?? {})],
  );
  return r.rows[0].id;
}

/** Résout les alertes ouvertes liées à un conteneur et/ou une mission. */
export async function resoudreAlertes(c: Client, f: { conteneur_id?: number; mission_id?: number }): Promise<void> {
  await c.query(
    `UPDATE alerte SET statut = 'RESOLUE', resolue_le = now()
      WHERE statut <> 'RESOLUE' AND (($1::int IS NOT NULL AND conteneur_id = $1) OR ($2::int IS NOT NULL AND mission_id = $2))`,
    [f.conteneur_id ?? null, f.mission_id ?? null],
  );
}
