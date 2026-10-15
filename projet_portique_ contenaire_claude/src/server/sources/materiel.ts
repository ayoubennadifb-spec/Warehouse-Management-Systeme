/**
 * Source d'événements MATÉRIELLE (mode connecté) — squelette prêt pour le futur pont matériel.
 * Elle n'exécute rien elle-même : un processus « pont » (automate, microcontrôleur, PC de vision…)
 *  - signale sa présence : POST /api/materiel/battement  { pont, nature: 'REEL' | 'TEST' }
 *  - démarre une mission  : POST /api/missions/:id/demarrer
 *  - envoie la télémétrie : POST /api/materiel/telemetrie { x, y, z, ... }  (non stockée)
 *  - confirme prise/dépôt : POST /api/confirmations { source: 'MATERIEL', cle, type, mission_id }
 * Sans battement depuis 10 s, le matériel est affiché « non connecté ». Aucune valeur n'est inventée.
 */
import type { Diffuseur } from '../temps-reel.ts';
import type { EtatSource, SourceEvenements } from './types.ts';

const DELAI_S = 10;

export class SourceMateriel implements SourceEvenements {
  readonly mode = 'MATERIEL' as const;
  private dernier: { pont: string; nature: 'REEL' | 'TEST'; recu: number } | null = null;
  private diff: Diffuseur;

  constructor(diff: Diffuseur) {
    this.diff = diff;
  }

  async demarrer(): Promise<void> {}
  async arreter(): Promise<void> {}

  battement(pont: string, nature: 'REEL' | 'TEST'): void {
    const etaitConnecte = this.etat().connecte;
    this.dernier = { pont, nature, recu: Date.now() };
    if (!etaitConnecte) this.diff.signalerSource();
  }

  telemetrie(data: Record<string, unknown>): void {
    if (!this.etat().connecte) return;
    this.diff.telemetrie({ ...data, source: 'MATERIEL', nature: this.dernier!.nature, recu_le: new Date().toISOString() });
  }

  etat(): EtatSource {
    const age = this.dernier ? (Date.now() - this.dernier.recu) / 1000 : null;
    const connecte = age !== null && age < DELAI_S;
    return {
      mode: 'MATERIEL',
      connecte,
      description: connecte
        ? `Pont matériel « ${this.dernier!.pont} » connecté${this.dernier!.nature === 'TEST' ? ' (pont de TEST : pas de matériel réel)' : ''}.`
        : this.dernier
          ? `Matériel non connecté : dernier signal il y a ${Math.round(age!)} s.`
          : 'Aucun matériel connecté : aucun signal reçu depuis le démarrage du serveur.',
      materiel: this.dernier
        ? { pont: this.dernier.pont, nature: this.dernier.nature, dernier_battement: new Date(this.dernier.recu).toISOString(), age_s: Math.round(age!) }
        : null,
    };
  }
}
