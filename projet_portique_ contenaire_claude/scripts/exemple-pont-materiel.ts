/**
 * EXEMPLE de pont matériel — documente le protocole, ne pilote AUCUN matériel.
 * Il se déclare explicitement « TEST » : l'interface affiche « pont de TEST : pas de matériel réel ».
 *
 * Prérequis : serveur lancé avec SOURCE_EVENEMENTS=MATERIEL dans .env.
 *   node scripts/exemple-pont-materiel.ts
 *
 * Ce que fera le vrai pont (automate, microcontrôleur, PC de vision…) :
 *  1. battement toutes les 2 s                       POST /api/materiel/battement
 *  2. prendre la mission EN_ATTENTE la plus ancienne GET  /api/missions  puis POST /api/missions/:id/demarrer
 *  3. envoyer les positions mesurées                 POST /api/materiel/telemetrie   (non stockées)
 *  4. confirmer la prise PUIS le dépôt PHYSIQUES     POST /api/confirmations
 *     avec une clé d'idempotence unique et stable : un renvoi après coupure réseau n'est pas appliqué deux fois.
 *  5. en cas d'arrêt d'urgence / obstacle            POST /api/missions/:id/interrompre
 */
export {};
const B = process.env.API ?? 'http://127.0.0.1:3000';
const post = (u: string, c: unknown) => fetch(B + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) }).then((r) => r.json());

setInterval(() => void post('/api/materiel/battement', { pont: 'exemple-pont', nature: 'TEST' }).catch(() => undefined), 2000);
await post('/api/materiel/battement', { pont: 'exemple-pont', nature: 'TEST' });
console.log('Pont de TEST déclaré. En attente de missions… (Ctrl+C pour arrêter)');

for (;;) {
  const missions: { id: number; statut: string; conteneur_code: string }[] = await (await fetch(`${B}/api/missions`)).json();
  const m = missions.filter((x) => x.statut === 'EN_ATTENTE').sort((a, b) => a.id - b.id)[0];
  if (m) {
    console.log(`Mission M${m.id} (${m.conteneur_code}) : démarrage`);
    await post(`/api/missions/${m.id}/demarrer`, {});
    // Ici le vrai pont commanderait les actionneurs et attendrait les capteurs.
    await new Promise((r) => setTimeout(r, 2000));
    console.log(' prise :', (await post('/api/confirmations', { source: 'MATERIEL', cle: `TEST-M${m.id}-PRISE`, type: 'PRISE', mission_id: m.id, horodatage_source: new Date().toISOString() })).resultat);
    await new Promise((r) => setTimeout(r, 2000));
    console.log(' dépôt :', (await post('/api/confirmations', { source: 'MATERIEL', cle: `TEST-M${m.id}-DEPOT`, type: 'DEPOT', mission_id: m.id, horodatage_source: new Date().toISOString() })).resultat);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
