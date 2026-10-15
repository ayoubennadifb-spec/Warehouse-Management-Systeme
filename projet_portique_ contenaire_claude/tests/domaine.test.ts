import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { nouvelleBase, tx, emp, cont, pile, positionDeHauteur } from './aide.ts';
import { une } from '../src/server/db.ts';
import { ErreurMetier } from '../src/server/erreurs.ts';
import { annuler, confirmer, creerMission, demarrerMission, interrompre, reprendre } from '../src/server/domaine/missions.ts';
import { arriveeCamion, departCamion } from '../src/server/domaine/camions.ts';
import { declarerPosition } from '../src/server/domaine/conteneurs.ts';

let pool: pg.Pool;
before(async () => {
  pool = await nouvelleBase();
});
after(async () => {
  await pool.end();
});

const cle = (() => {
  let i = 0;
  return () => `TEST-${++i}`;
})();

async function refus(p: Promise<unknown>, code: string | RegExp): Promise<ErreurMetier> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ErreurMetier, `ErreurMetier attendue, reçu : ${(e as Error).message}`);
    if (typeof code === 'string') assert.equal(e.code, code, e.message);
    else assert.match(e.code, code, e.message);
    return e;
  }
  assert.fail(`Refus ${code} attendu, mais l'action a réussi`);
}

/** Exécute une mission complète avec confirmations simulées. */
async function executer(missionId: number): Promise<void> {
  await tx(pool, (c) => demarrerMission(c, missionId, 'SIMULATION'));
  const p = await tx(pool, (c) => confirmer(c, { source: 'SIMULATION', cle: cle(), type: 'PRISE', mission_id: missionId }));
  assert.equal(p.resultat, 'APPLIQUEE', p.motif ?? '');
  const d = await tx(pool, (c) => confirmer(c, { source: 'SIMULATION', cle: cle(), type: 'DEPOT', mission_id: missionId }));
  assert.equal(d.resultat, 'APPLIQUEE', d.motif ?? '');
}

describe('géométrie en base', () => {
  test('49 positions au sol et 147 emplacements générés pour le plan actif', async () => {
    const r = await une(pool, `SELECT * FROM v_capacite_plan WHERE statut = 'ACTIVE'`);
    assert.equal(Number(r.nb_positions_sol), 49);
    assert.equal(Number(r.nb_emplacements), 147);
    const z = await pool.query(`SELECT code, x_min_mm, x_max_mm, y_max_mm FROM zone z JOIN version_plan v ON v.id = z.version_plan_id AND v.statut='ACTIVE' ORDER BY x_min_mm`);
    assert.deepEqual(z.rows.map((x) => [x.code, x.x_min_mm, x.x_max_mm, x.y_max_mm]), [['STOCKAGE', 0, 800, 500], ['TRANSPORT', 800, 1000, 500]]);
  });
});

describe('règles d’empilement', () => {
  test('dépôt sans support refusé (règle métier et base)', async () => {
    const vide = await positionDeHauteur(pool, 0);
    const haut = await positionDeHauteur(pool, 1);
    const sommet = (await pile(pool, haut))[0];
    const c = await cont(pool, sommet);
    const e = await refus(tx(pool, async (k) => creerMission(k, { conteneur_id: c.id, destination_emplacement_id: await emp(pool, `${vide}-N2`) }, 'OPERATEUR')), 'MISSION_REFUSEE');
    assert.match(e.message, /pas de support/);
    // Écriture directe en base : refusée par le déclencheur différé
    const n2 = await emp(pool, `${vide}-N2`);
    await refus(
      tx(pool, (k) => k.query(`INSERT INTO conteneur (code, type_conteneur_id, etat, emplacement_id) VALUES ('FLOTTANT', 1, 'EN_PLACE', $1)`, [n2])),
      'EMPILEMENT_SANS_SUPPORT',
    );
  });

  test('retrait direct seulement au sommet ; retrait du dessous refusé en base', async () => {
    const p3 = await positionDeHauteur(pool, 3);
    const [bas, , haut] = await pile(pool, p3);
    const vide = await positionDeHauteur(pool, 0);
    const e = await refus(
      tx(pool, async (k) => creerMission(k, { conteneur_id: (await cont(pool, bas)).id, destination_emplacement_id: await emp(pool, `${vide}-N1`) }, 'OPERATEUR')),
      'MISSION_REFUSEE',
    );
    assert.match(e.message, new RegExp(`déplacez d’abord .*${haut}`));
    await refus(tx(pool, (k) => k.query(`UPDATE conteneur SET etat = 'SORTI', emplacement_id = NULL WHERE code = $1`, [bas])), 'EMPILEMENT_SANS_SUPPORT');
  });

  test('un seul conteneur par emplacement (contrainte unique)', async () => {
    const p1 = await positionDeHauteur(pool, 1);
    await refus(
      tx(pool, async (k) => k.query(`INSERT INTO conteneur (code, type_conteneur_id, etat, emplacement_id) VALUES ('DOUBLON', 1, 'EN_PLACE', $1)`, [await emp(pool, `${p1}-N1`)])),
      'EMPLACEMENT_OCCUPE',
    );
  });
});

describe('transferts', () => {
  test('stockage → stockage : demande, prise confirmée, dépôt confirmé', async () => {
    const src = await positionDeHauteur(pool, 2);
    const dst = await positionDeHauteur(pool, 0);
    const code = (await pile(pool, src))[1];
    const c0 = await cont(pool, code);
    const m = await tx(pool, async (k) => creerMission(k, { conteneur_id: c0.id, destination_emplacement_id: await emp(pool, `${dst}-N1`) }, 'OPERATEUR'));
    assert.equal(m.type, 'STOCKAGE_VERS_STOCKAGE');
    // La demande ne modifie pas la position enregistrée
    assert.equal((await cont(pool, code)).code_emplacement, `${src}-N2`);
    const res = await pool.query(`SELECT role FROM reservation WHERE mission_id = $1 AND statut = 'ACTIVE' ORDER BY role`, [m.id]);
    assert.deepEqual(res.rows.map((r) => r.role), ['DESTINATION', 'SOURCE']);
    await tx(pool, (k) => demarrerMission(k, m.id, 'SIMULATION'));
    await tx(pool, (k) => confirmer(k, { source: 'SIMULATION', cle: cle(), type: 'PRISE', mission_id: m.id }));
    const enTransfert = await cont(pool, code);
    assert.equal(enTransfert.etat, 'EN_TRANSFERT');
    assert.equal(enTransfert.emplacement_id, null);
    await tx(pool, (k) => confirmer(k, { source: 'SIMULATION', cle: cle(), type: 'DEPOT', mission_id: m.id }));
    const fin = await cont(pool, code);
    assert.equal(fin.etat, 'EN_PLACE');
    assert.equal(fin.code_emplacement, `${dst}-N1`);
    assert.deepEqual(await pile(pool, src), [(await pile(pool, src))[0]]);
    const h = await pool.query(`SELECT etat FROM historique_localisation WHERE conteneur_id = $1 ORDER BY id`, [c0.id]);
    assert.deepEqual(h.rows.map((r) => r.etat).slice(-3), ['EN_PLACE', 'EN_TRANSFERT', 'EN_PLACE']);
    assert.equal((await une(pool, `SELECT count(*)::int AS n FROM reservation WHERE mission_id = $1 AND statut = 'ACTIVE'`, [m.id])).n, 0);
  });

  test('déchargement camion → stockage puis départ du camion vide', async () => {
    const t01 = await cont(pool, 'DEMO-T01');
    assert.equal(t01.type_emplacement, 'PLATEAU');
    const dst = await positionDeHauteur(pool, 0);
    const m = await tx(pool, async (k) => creerMission(k, { conteneur_id: t01.id, destination_emplacement_id: await emp(pool, `${dst}-N1`) }, 'OPERATEUR'));
    assert.equal(m.type, 'CAMION_VERS_STOCKAGE');
    const visite = await une(pool, `SELECT v.id FROM visite_camion v JOIN camion k ON k.id = v.camion_id WHERE k.code = 'DEMO-CAM-1' AND v.statut = 'PRESENTE'`);
    const e = await refus(tx(pool, (k) => departCamion(k, visite.id, 'OPERATEUR')), 'CAMION_EN_TRANSFERT');
    assert.match(e.message, /impliqué dans la mission/);
    await executer(m.id);
    assert.equal((await cont(pool, 'DEMO-T01')).code_emplacement, `${dst}-N1`);
    const r = await tx(pool, (k) => departCamion(k, visite.id, 'OPERATEUR'));
    assert.equal(r.conteneur_code, null);
  });

  test('chargement stockage → camion puis départ chargé (conteneur sorti)', async () => {
    const a = await tx(pool, (k) => arriveeCamion(k, { camion_code: 'TEST-CHARGE', conteneur_code: null }, 'OPERATEUR'));
    assert.equal(a.accepte, true);
    const src = await positionDeHauteur(pool, 1);
    const code = (await pile(pool, src))[0];
    const m = await tx(pool, async (k) => creerMission(k, { conteneur_id: (await cont(pool, code)).id, destination_emplacement_id: await emp(pool, 'PLATEAU-TEST-CHARGE') }, 'OPERATEUR'));
    assert.equal(m.type, 'STOCKAGE_VERS_CAMION');
    await executer(m.id);
    assert.equal((await cont(pool, code)).code_camion, 'TEST-CHARGE');
    const r = await tx(pool, (k) => departCamion(k, (a as any).visite_id, 'OPERATEUR'));
    assert.equal(r.conteneur_code, code);
    assert.equal((await cont(pool, code)).etat, 'SORTI');
    // Un même camion peut revenir : nouvelle visite
    const b = await tx(pool, (k) => arriveeCamion(k, { camion_code: 'TEST-CHARGE', conteneur_code: code }, 'OPERATEUR'));
    assert.equal(b.accepte, true);
    assert.equal((await une(pool, `SELECT count(*)::int AS n FROM visite_camion v JOIN camion k ON k.id = v.camion_id WHERE k.code = 'TEST-CHARGE'`)).n, 2);
    await tx(pool, (k) => k.query(`SELECT 1`));
    // repart avec le conteneur pour la suite
    await tx(pool, (k) => departCamion(k, (b as any).visite_id, 'OPERATEUR'));
  });
});

describe('conflits', () => {
  test('même destination réservée deux fois : refus', async () => {
    const dst = await positionDeHauteur(pool, 0);
    const [p1, p2] = [await positionDeHauteur(pool, 1), await positionDeHauteur(pool, 1, [await positionDeHauteur(pool, 1)])];
    const c1 = await cont(pool, (await pile(pool, p1))[0]);
    const c2 = await cont(pool, (await pile(pool, p2))[0]);
    const d = await emp(pool, `${dst}-N1`);
    const m = await tx(pool, (k) => creerMission(k, { conteneur_id: c1.id, destination_emplacement_id: d }, 'OPERATEUR'));
    const e = await refus(tx(pool, (k) => creerMission(k, { conteneur_id: c2.id, destination_emplacement_id: d }, 'OPERATEUR')), 'MISSION_REFUSEE');
    assert.match(e.message, /réservé par la mission/);
    // même conteneur dans deux missions
    const autre = await positionDeHauteur(pool, 0, [dst]);
    const e2 = await refus(tx(pool, async (k) => creerMission(k, { conteneur_id: c1.id, destination_emplacement_id: await emp(pool, `${autre}-N1`) }, 'OPERATEUR')), 'MISSION_REFUSEE');
    assert.match(e2.message, /déjà engagé/);
    // empiler sur un conteneur qui va partir : refus
    const e3 = await refus(tx(pool, async (k) => creerMission(k, { conteneur_id: c2.id, destination_emplacement_id: await emp(pool, `${p1}-N2`) }, 'OPERATEUR')), 'MISSION_REFUSEE');
    assert.match(e3.message, /Un dépôt est prévu|engagé dans la mission/);
    await tx(pool, (k) => annuler(k, m.id, 'test', 'OPERATEUR'));
  });

  test('demandes simultanées sur la même destination : une seule acceptée', async () => {
    const dst = await emp(pool, `${await positionDeHauteur(pool, 0)}-N1`);
    const sommets = await pool.query(
      `SELECT c.id FROM conteneur c JOIN emplacement e ON e.id = c.emplacement_id
        WHERE e.type = 'CASE' AND NOT EXISTS (SELECT 1 FROM emplacement e2 JOIN conteneur c2 ON c2.emplacement_id = e2.id
                                              WHERE e2.position_sol_id = e.position_sol_id AND e2.niveau > e.niveau)
        ORDER BY c.id LIMIT 8`,
    );
    const r = await Promise.allSettled(sommets.rows.map((s) => tx(pool, (k) => creerMission(k, { conteneur_id: s.id, destination_emplacement_id: dst }, 'OPERATEUR'))));
    const ok = r.filter((x) => x.status === 'fulfilled');
    assert.equal(ok.length, 1, 'exactement une mission acceptée');
    await tx(pool, (k) => annuler(k, (ok[0] as PromiseFulfilledResult<any>).value.id, 'test', 'OPERATEUR'));
  });

  test('arrivée refusée sans poste disponible, et tracée', async () => {
    const libres = await pool.query(`SELECT count(*)::int AS n FROM poste_transport pt JOIN version_plan v ON v.id = pt.version_plan_id AND v.statut='ACTIVE'
      WHERE NOT EXISTS (SELECT 1 FROM visite_camion x WHERE x.poste_id = pt.id AND x.statut = 'PRESENTE')`);
    const ids: number[] = [];
    for (let i = 0; i < libres.rows[0].n; i++) {
      const a = await tx(pool, (k) => arriveeCamion(k, { camion_code: `REMPLI-${i}` }, 'OPERATEUR'));
      assert.equal(a.accepte, true);
      ids.push((a as any).visite_id);
    }
    const r = await tx(pool, (k) => arriveeCamion(k, { camion_code: 'EN-TROP', conteneur_code: 'X-1' }, 'OPERATEUR'));
    assert.equal(r.accepte, false);
    assert.equal((r as any).code, 'AUCUN_POSTE_DISPONIBLE');
    const v = await une(pool, `SELECT statut, motif_refus, poste_id FROM visite_camion WHERE id = $1`, [r.visite_id]);
    assert.equal(v.statut, 'REFUSEE');
    assert.equal(v.poste_id, null);
    assert.equal(await cont(pool, 'X-1'), null, 'le conteneur annoncé n’est pas entré');
    for (const id of ids) await tx(pool, (k) => departCamion(k, id, 'OPERATEUR'));
  });

  test('capacité configurée respectée à l’arrivée d’un camion chargé', async () => {
    await pool.query(`ALTER TABLE version_plan DISABLE TRIGGER version_plan_proteger`);
    const n = (await une(pool, `SELECT count(*)::int AS n FROM conteneur WHERE etat <> 'SORTI'`)).n;
    await pool.query(`UPDATE version_plan SET nb_conteneurs_max = $1 WHERE statut = 'ACTIVE'`, [n]);
    await pool.query(`ALTER TABLE version_plan ENABLE TRIGGER version_plan_proteger`);
    const r = await tx(pool, (k) => arriveeCamion(k, { camion_code: 'CAPA', conteneur_code: 'CAPA-1' }, 'OPERATEUR'));
    assert.equal(r.accepte, false);
    assert.equal((r as any).code, 'CAPACITE');
    // la base refuse aussi l'écriture directe
    await refus(
      tx(pool, (k) => k.query(`INSERT INTO conteneur (code, type_conteneur_id, etat, motif_incertitude) VALUES ('CAPA-2', 1, 'INCERTAINE', 'test')`)),
      'CAPACITE_DEPASSEE',
    );
    await pool.query(`ALTER TABLE version_plan DISABLE TRIGGER version_plan_proteger`);
    await pool.query(`UPDATE version_plan SET nb_conteneurs_max = 60 WHERE statut = 'ACTIVE'`);
    await pool.query(`ALTER TABLE version_plan ENABLE TRIGGER version_plan_proteger`);
  });
});

describe('confirmations et interruptions', () => {
  test('confirmation reçue deux fois : appliquée une seule fois', async () => {
    const src = await positionDeHauteur(pool, 1);
    const code = (await pile(pool, src))[0];
    const m = await tx(pool, async (k) => creerMission(k, { conteneur_id: (await cont(pool, code)).id, destination_emplacement_id: await emp(pool, `${await positionDeHauteur(pool, 0)}-N1`) }, 'OPERATEUR'));
    await tx(pool, (k) => demarrerMission(k, m.id, 'MATERIEL'));
    const a = await tx(pool, (k) => confirmer(k, { source: 'MATERIEL', cle: 'CTRL-42', type: 'PRISE', mission_id: m.id }));
    const b = await tx(pool, (k) => confirmer(k, { source: 'MATERIEL', cle: 'CTRL-42', type: 'PRISE', mission_id: m.id }));
    assert.equal(a.resultat, 'APPLIQUEE');
    assert.equal(b.deja_recue, true);
    assert.equal(b.confirmation_id, a.confirmation_id);
    assert.equal((await une(pool, `SELECT count(*)::int AS n FROM evenement WHERE type = 'PRISE_CONFIRMEE' AND mission_id = $1`, [m.id])).n, 1);
    // dépôt avant prise / dépôt en double : rejet tracé
    const d1 = await tx(pool, (k) => confirmer(k, { source: 'MATERIEL', cle: 'CTRL-43', type: 'DEPOT', mission_id: m.id }));
    const d2 = await tx(pool, (k) => confirmer(k, { source: 'MATERIEL', cle: 'CTRL-44', type: 'DEPOT', mission_id: m.id }));
    assert.equal(d1.resultat, 'APPLIQUEE');
    assert.equal(d2.resultat, 'REJETEE');
  });

  test('interruption après la prise : conteneur incertain, réservations conservées, reprise possible', async () => {
    const src = await positionDeHauteur(pool, 1);
    const code = (await pile(pool, src))[0];
    const dstCode = `${await positionDeHauteur(pool, 0)}-N1`;
    const m = await tx(pool, async (k) => creerMission(k, { conteneur_id: (await cont(pool, code)).id, destination_emplacement_id: await emp(pool, dstCode) }, 'OPERATEUR'));
    await tx(pool, (k) => demarrerMission(k, m.id, 'SIMULATION'));
    await tx(pool, (k) => confirmer(k, { source: 'SIMULATION', cle: cle(), type: 'PRISE', mission_id: m.id, position: { x: 100, y: 100, z: 180 } }));
    await tx(pool, (k) => interrompre(k, m.id, 'arrêt d’urgence simulé', 'SIMULATION', { x: 300, y: 200, z: 180 }));
    const c1 = await cont(pool, code);
    assert.equal(c1.etat, 'INCERTAINE');
    assert.deepEqual([c1.x_mm, c1.y_mm, c1.z_mm], [300, 200, 180]);
    assert.equal((await une(pool, `SELECT count(*)::int AS n FROM reservation WHERE mission_id = $1 AND statut = 'ACTIVE'`, [m.id])).n, 2);
    assert.ok((await une(pool, `SELECT 1 FROM alerte WHERE mission_id = $1 AND statut = 'OUVERTE'`, [m.id])));
    await refus(tx(pool, (k) => reprendre(k, m.id, 'OPERATEUR')), 'CONFIRMATION_REQUISE');
    await tx(pool, (k) => reprendre(k, m.id, 'OPERATEUR', { conteneur_toujours_tenu: true }));
    assert.equal((await cont(pool, code)).etat, 'EN_TRANSFERT');
    await tx(pool, (k) => confirmer(k, { source: 'SIMULATION', cle: cle(), type: 'DEPOT', mission_id: m.id }));
    assert.equal((await cont(pool, code)).code_emplacement, dstCode);
  });

  test('annulation après la prise : pas de retour automatique au départ, puis déclaration', async () => {
    const src = await positionDeHauteur(pool, 1);
    const code = (await pile(pool, src))[0];
    const m = await tx(pool, async (k) => creerMission(k, { conteneur_id: (await cont(pool, code)).id, destination_emplacement_id: await emp(pool, `${await positionDeHauteur(pool, 0)}-N1`) }, 'OPERATEUR'));
    await tx(pool, (k) => demarrerMission(k, m.id, 'SIMULATION'));
    await tx(pool, (k) => confirmer(k, { source: 'SIMULATION', cle: cle(), type: 'PRISE', mission_id: m.id }));
    await tx(pool, (k) => annuler(k, m.id, 'annulation opérateur', 'OPERATEUR'));
    const c1 = await cont(pool, code);
    assert.equal(c1.etat, 'INCERTAINE');
    assert.equal(c1.emplacement_id, null, 'ne réapparaît pas à la source');
    assert.deepEqual(await pile(pool, src), []);
    // la source reste réservée tant que la position n'est pas déclarée
    await refus(tx(pool, async (k) => declarerPosition(k, c1.id, { emplacement_id: await emp(pool, `${await positionDeHauteur(pool, 3)}-N1`) })), 'DECLARATION_IMPOSSIBLE');
    await tx(pool, async (k) => declarerPosition(k, c1.id, { emplacement_id: await emp(pool, `${src}-N1`), commentaire: 'constaté à la source' }));
    const c2 = await cont(pool, code);
    assert.equal(c2.etat, 'EN_PLACE');
    assert.equal(c2.code_emplacement, `${src}-N1`);
    assert.equal((await une(pool, `SELECT count(*)::int AS n FROM reservation WHERE mission_id = $1 AND statut = 'ACTIVE'`, [m.id])).n, 0);
  });

  test('journal des événements en ajout seul', async () => {
    await refus(tx(pool, (k) => k.query(`DELETE FROM evenement`)), 'JOURNAL_IMMUABLE');
  });
});
