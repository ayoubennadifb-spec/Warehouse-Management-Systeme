/**
 * Une SOURCE D'ÉVÉNEMENTS exécute les missions et produit les confirmations.
 * - SimulationSource : unité de manutention simulée dans le serveur (confirmations simulées).
 * - SourceMateriel    : attend un pont matériel (confirmations physiques via l'API).
 * Les deux passent par les MÊMES services métier (missions.confirmer, interrompre…),
 * donc par les mêmes règles, la même base et les mêmes événements.
 */
export interface EtatSource {
  mode: 'SIMULATION' | 'MATERIEL';
  connecte: boolean;
  description: string;
  en_pause?: boolean;
  vitesse?: number;
  bloque?: string | null;
  erreur?: string | null;
  mission_id?: number | null;
  materiel?: { pont: string; nature: 'REEL' | 'TEST'; dernier_battement: string; age_s: number } | null;
}

export interface SourceEvenements {
  readonly mode: 'SIMULATION' | 'MATERIEL';
  demarrer(): Promise<void>;
  arreter(): Promise<void>;
  etat(): EtatSource;
}
