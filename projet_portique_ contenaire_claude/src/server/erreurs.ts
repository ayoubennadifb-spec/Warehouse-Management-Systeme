/** Erreur métier explicable à l'utilisateur (refus d'une action). */
export class ErreurMetier extends Error {
  code: string;
  statut: number;
  details?: unknown;
  constructor(code: string, message: string, statut = 409, details?: unknown) {
    super(message);
    this.name = 'ErreurMetier';
    this.code = code;
    this.statut = statut;
    this.details = details;
  }
}

const CONTRAINTES: Record<string, [string, string]> = {
  conteneur_emplacement_id_key: ['EMPLACEMENT_OCCUPE', 'Cet emplacement est déjà occupé par un autre conteneur.'],
  conteneur_mission_transfert_id_key: ['TRANSFERT_DEJA_PORTE', 'Cette mission porte déjà un conteneur.'],
  conteneur_code_key: ['CODE_CONTENEUR_EXISTANT', 'Un conteneur porte déjà ce code.'],
  camion_code_key: ['CODE_CAMION_EXISTANT', 'Un camion porte déjà ce code.'],
  reservation_une_active_par_emplacement: ['DESTINATION_RESERVEE', 'Cet emplacement est déjà réservé par une autre mission.'],
  mission_une_active_par_conteneur: ['CONTENEUR_DEJA_EN_MISSION', 'Ce conteneur est déjà engagé dans une mission non terminée.'],
  mission_une_par_unite: ['UNITE_OCCUPEE', 'L’unité de manutention exécute déjà une mission.'],
  visite_un_camion_par_poste: ['POSTE_OCCUPE', 'Ce poste est déjà occupé par un camion.'],
  visite_une_presente_par_camion: ['CAMION_DEJA_PRESENT', 'Ce camion est déjà présent dans la zone.'],
  version_plan_une_active: ['PLAN_DEJA_ACTIF', 'Une autre version de plan est déjà active.'],
  confirmation_source_cle_idempotence_key: ['CONFIRMATION_DEJA_RECUE', 'Cette confirmation a déjà été reçue.'],
};

const CODES_PT: Record<string, string> = {
  PT001: 'EMPILEMENT_SANS_SUPPORT',
  PT002: 'PLAN_INACTIF',
  PT003: 'CAMION_ABSENT',
  PT004: 'CAPACITE_DEPASSEE',
  PT005: 'DEPART_IMPOSSIBLE',
  PT006: 'PLAN_IMMUABLE',
  PT007: 'JOURNAL_IMMUABLE',
  PT008: 'RESERVATION_INCOHERENTE',
};

/** Traduit une erreur PostgreSQL (contrainte, déclencheur) en ErreurMetier lisible. */
export function traduireErreurPg(e: unknown): unknown {
  if (e instanceof ErreurMetier) return e;
  const err = e as { code?: string; constraint?: string; message?: string };
  if (!err || typeof err !== 'object' || !err.code) return e;
  if (err.code in CODES_PT) return new ErreurMetier(CODES_PT[err.code], err.message ?? 'Règle violée', 409);
  if (err.code === '23505' && err.constraint && CONTRAINTES[err.constraint]) {
    const [code, msg] = CONTRAINTES[err.constraint];
    return new ErreurMetier(code, msg, 409);
  }
  if (err.code === '23505' || err.code === '23514' || err.code === '23503') {
    return new ErreurMetier('CONTRAINTE_BASE', `Refus de la base de données : ${err.message} (${err.constraint ?? err.code})`, 409);
  }
  return e;
}
