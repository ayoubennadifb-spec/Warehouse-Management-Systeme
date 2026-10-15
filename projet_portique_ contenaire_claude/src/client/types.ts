/** Types des données reçues de l'API (forme des lignes PostgreSQL renvoyées en JSON). */
export type EtatConteneur = 'EN_PLACE' | 'EN_TRANSFERT' | 'INCERTAINE' | 'SORTI';

export interface Conteneur {
  id: number;
  code: string;
  etat: EtatConteneur;
  demo: boolean;
  emplacement_id: number | null;
  type_emplacement: 'CASE' | 'PLATEAU' | null;
  code_emplacement: string | null;
  code_position: string | null;
  niveau: number | null;
  code_camion: string | null;
  code_poste: string | null;
  x_mm: number | null;
  y_mm: number | null;
  z_mm: number | null;
  mission_transfert_id: number | null;
  motif_incertitude: string | null;
  longueur_mm: number;
  largeur_mm: number;
  hauteur_mm: number;
}

export interface Position {
  id: number;
  ix: number;
  iy: number;
  code: string;
  centre_x_mm: number;
  centre_y_mm: number;
  statut: 'DISPONIBLE' | 'BLOQUEE';
  motif_blocage: string | null;
}

export interface Emplacement {
  id: number;
  code: string;
  position_sol_id: number;
  niveau: number;
  z_base_mm: number;
}

export interface Poste {
  id: number;
  code: string;
  centre_x_mm: number;
  centre_y_mm: number;
  longueur_x_mm: number;
  largeur_y_mm: number;
  cote_cabine: 'X_MIN' | 'X_MAX';
  statut: 'DISPONIBLE' | 'HORS_SERVICE';
  motif_indisponibilite: string | null;
}

export interface Zone {
  id: number;
  code: 'STOCKAGE' | 'TRANSPORT';
  x_min_mm: number;
  x_max_mm: number;
  y_min_mm: number;
  y_max_mm: number;
}

export interface Visite {
  id: number;
  arrivee_le: string;
  plateau_x_mm: number;
  plateau_y_mm: number;
  plateau_z_mm: number;
  camion_id: number;
  camion_code: string;
  demo: boolean;
  poste_id: number;
  poste_code: string;
  centre_x_mm: number;
  centre_y_mm: number;
  cote_cabine: 'X_MIN' | 'X_MAX';
  plateau_emplacement_id: number;
  cabine_longueur_mm: number;
  cabine_largeur_mm: number;
  cabine_hauteur_mm: number;
  plateau_longueur_mm: number;
  plateau_largeur_mm: number;
  plateau_hauteur_mm: number;
}

export interface Mission {
  id: number;
  conteneur_id: number;
  conteneur_code: string;
  type: string;
  statut: 'EN_ATTENTE' | 'EN_COURS' | 'SUSPENDUE' | 'INTERROMPUE' | 'TERMINEE' | 'ANNULEE';
  source_emplacement_id: number;
  destination_emplacement_id: number;
  source_code: string;
  destination_code: string;
  demandee_le: string;
  demarree_le: string | null;
  prise_confirmee_le: string | null;
  depot_confirme_le: string | null;
  interrompue_le: string | null;
  terminee_le: string | null;
  motif_fin: string | null;
  executant: string | null;
}

export interface Evenement {
  id: number;
  uuid: string;
  type: string;
  horodatage: string;
  horodatage_source: string | null;
  source: string;
  gravite: 'INFO' | 'AVERTISSEMENT' | 'ALERTE';
  message: string;
  conteneur_id: number | null;
  mission_id: number | null;
}

export interface Alerte {
  id: number;
  type: string;
  gravite: string;
  message: string;
  statut: string;
  ouverte_le: string;
  mission_id: number | null;
  conteneur_id: number | null;
}

export interface EtatSource {
  mode: 'SIMULATION' | 'MATERIEL';
  connecte: boolean;
  description: string;
  en_pause?: boolean;
  vitesse?: number;
  bloque?: string | null;
  erreur?: string | null;
  mission_id?: number | null;
  materiel?: { pont: string; nature: string; dernier_battement: string; age_s: number } | null;
}

export interface EtatBase {
  ok: boolean;
  latence_ms: number | null;
  erreur: string | null;
  verifie_le: string | null;
}

export interface Parametres {
  libelle: string;
  espace: { longueur_x_mm: number; largeur_y_mm: number };
  zones: { transport_longueur_x_mm: number; transport_cote: 'X_MIN' | 'X_MAX' };
  conteneur: { longueur_mm: number; largeur_mm: number; hauteur_mm: number };
  grille: {
    nb_positions_x: number;
    nb_positions_y: number;
    nb_niveaux_max: number;
    marge_x_mm: number | null;
    espacement_x_mm: number | null;
    marge_y_mm: number | null;
    espacement_y_mm: number | null;
  };
  capacite: { nb_conteneurs_max: number; perimetre: 'ZONE' | 'STOCKAGE' };
  camion: {
    cabine_longueur_mm: number;
    cabine_largeur_mm: number;
    cabine_hauteur_mm: number;
    plateau_longueur_mm: number;
    plateau_largeur_mm: number;
    plateau_hauteur_mm: number;
  };
  postes: { nb_postes: number; cote_cabine: 'X_MIN' | 'X_MAX'; positions: { code: string; centre_x_mm: number; centre_y_mm: number }[] | null };
}

export interface Repartition {
  marge_debut: number;
  espacement: number;
  marge_fin: number;
  pas: number;
  auto: boolean;
}

export interface Plan {
  id: number;
  numero: number;
  libelle: string;
  statut: string;
  nb_niveaux_max: number;
  nb_conteneurs_max: number;
  perimetre_capacite: string;
  parametres: Parametres;
  active_le: string | null;
  geometrie: {
    zones: Zone[];
    positions: Position[];
    emplacements: Emplacement[];
    postes: Poste[];
    type_conteneur: { longueur_mm: number; largeur_mm: number; hauteur_mm: number; code: string };
    type_camion: Record<string, number | string | boolean>;
    repartition_x: Repartition | null;
    repartition_y: Repartition | null;
    avertissements: string[];
    hauteur_pile_max: number;
  };
}

export interface Indicateurs {
  conteneurs_presents: number;
  conteneurs_stockage: number;
  conteneurs_camions: number;
  conteneurs_transfert: number;
  conteneurs_incertains: number;
  nb_conteneurs_max: number;
  perimetre_capacite: string;
  emplacements_total: number;
  emplacements_occupes: number;
  positions_sol_total: number;
  postes_total: number;
  postes_occupes: number;
  postes_disponibles: number;
  missions_en_cours: number;
  missions_en_attente: number;
  missions_interrompues: number;
  alertes_ouvertes: number;
}

export interface Etat {
  operation: {id:number;statut:string;indice:number;plan:any}|null;
  genere_le: string;
  dernier_evenement_id: number;
  mode: 'SIMULATION' | 'MATERIEL';
  source: EtatSource;
  base: EtatBase;
  plan: Plan | null;
  conteneurs: Conteneur[];
  visites: Visite[];
  visites_recentes: {
    id: number;
    statut: string;
    arrivee_le: string;
    depart_le: string | null;
    motif_refus: string | null;
    code_conteneur_annonce: string | null;
    camion_code: string;
    poste_code: string | null;
    conteneur_arrivee: string | null;
    conteneur_depart: string | null;
  }[];
  missions: Mission[];
  trajets: { mission_id: number; version: number; algorithme: string; optimise: boolean; points: { x: number; y: number; z: number; type: string }[] }[];
  reservations: { emplacement_id: number; mission_id: number; role: string }[];
  unite: { id: number; code: string; description: string; x_mm: number | null; y_mm: number | null; z_mm: number | null; position_le: string | null; source_position: string | null } | null;
  alertes: Alerte[];
  evenements: Evenement[];
  versions: {
    id: number;
    numero: number;
    libelle: string;
    statut: string;
    cree_le: string;
    active_le: string | null;
    archivee_le: string | null;
    parametres: Parametres;
    nb_positions_sol: number;
    nb_emplacements: number;
    nb_postes: number;
  }[];
  indicateurs: Indicateurs | null;
  demo: boolean;
}

export interface Telemetrie {
  source: string;
  t: string;
  x: number;
  y: number;
  z: number;
  mission_id: number | null;
  conteneur_porte_id: number | null;
  etape: string;
  progression: number | null;
  en_pause: boolean;
}

export interface Raison {
  code: string;
  message: string;
}

export interface Destinations {
  source: Raison[];
  destinations: { emplacement_id: number; code: string; type: 'CASE' | 'PLATEAU'; raisons: Raison[] }[];
}

export type Selection =
  | { type: 'conteneur'; id: number }
  | { type: 'position'; id: number }
  | { type: 'visite'; id: number }
  | null;

/** Mode d'interaction en cours sur la scène */
export type ModeScene =
  | { type: 'normal' }
  | { type: 'destination'; conteneurId: number; choix: number | null }
  | { type: 'declaration'; conteneurId: number; choix: number | null }
  | { type: 'source_pour_camion'; plateauId: number; camion: string };
