# Évolution vers le matériel réel (jumeau numérique)

## Principe

La simulation et le matériel sont deux **sources d'événements** interchangeables (`src/server/sources/`).
Elles appellent les mêmes services métier, écrivent dans les mêmes tables et produisent les mêmes événements.
Passer au matériel, c'est remplacer la source simulée par un **pont matériel**, sans réécrire la base, l'API ni l'interface.

```
SOURCE_EVENEMENTS=MATERIEL   (dans .env)
```

Dans ce mode, le serveur n'exécute plus rien lui-même. L'interface affiche « MODE CONNECTÉ », et l'état du matériel
(« aucun matériel connecté » tant qu'aucun battement n'est reçu). Aucune valeur n'est jamais inventée.

## Protocole du pont matériel (déjà implémenté côté serveur)

| Étape | Requête | Remarque |
|---|---|---|
| Présence | `POST /api/materiel/battement` `{ pont, nature: "REEL" \| "TEST" }` | toutes les 2 s ; absent depuis 10 s ⇒ « non connecté » |
| Lire le travail | `GET /api/missions` | missions `EN_ATTENTE`, ordre de demande |
| Démarrer | `POST /api/missions/:id/demarrer` | |
| Position mesurée | `POST /api/materiel/telemetrie` `{ x, y, z, mission_id, conteneur_porte_id, etape }` | diffusée à l'interface, non stockée |
| Prise physique | `POST /api/confirmations` `{ source: "MATERIEL", cle, type: "PRISE", mission_id, horodatage_source }` | `cle` unique et **stable** : renvoyée à l'identique après une coupure réseau, elle n'est appliquée qu'une fois |
| Dépôt physique | idem avec `type: "DEPOT"` | |
| Incident | `POST /api/missions/:id/interrompre` `{ motif }` | arrêt d'urgence, obstacle, perte de capteur… |

Exemple exécutable (déclaré `TEST`, ne pilote rien) : `scripts/exemple-pont-materiel.ts`.

## Étapes conseillées

1. **Pont minimal** (PC ou Raspberry Pi relié à l'automate ou au microcontrôleur) : battement + confirmations de prise et de dépôt
   issues de **capteurs** (fin de course, présence conteneur), pas d'un minuteur.
2. **Télémétrie** des axes (codeurs) pour animer la scène en temps réel.
3. **Recalage du plan** : mesurer les centres réels des positions et des postes ; créer une version de plan
   (les coordonnées sont stockées case par case, elles peuvent s'écarter de la grille théorique).
4. **Inventaire initial réel** : remplacer la démonstration (`npm run db:reset -- --oui --sans-demo` : plan actif, aucun conteneur).
   Dans cette V1, un conteneur entre dans la zone par l'arrivée d'un camion chargé puis un déchargement ;
   un écran ou un script d'**import d'inventaire** (positions constatées) reste à écrire.
5. **Sécurité** : toute perte de battement pendant une mission doit conduire le pont à arrêter le mouvement ;
   le serveur l'affiche, et l'opérateur décide de la reprise.

## Vision et obstacles (préparé)

- `camera` et `calibration_camera` : pose de chaque caméra dans le repère de la maquette (mm), une calibration valide par caméra.
- `observation_obstacle` : boîte englobante 3D, classe `HUMAIN`/`OBJET`/`INCONNU`, confiance, identifiant de suivi, modèle IA.
- `alerte` peut référencer l'observation déclenchante.
- `trajet` / `point_trajet` versionnés : un nouvel obstacle ⇒ interruption ⇒ nouveau trajet (`motif_calcul`,
  `observation_declenchante_id`, `remplace_trajet_id`).

Comportement de départ proposé :
- **humain détecté** dans le volume de travail ⇒ interruption immédiate + alerte critique ; la reprise exige un acquittement opérateur
  (un détour ne suffit pas à autoriser la reprise) ;
- **objet** ⇒ interruption, réévaluation du trajet ; le nouveau trajet n'est exécuté qu'après validation.

L'algorithme d'optimisation, le modèle IA et le critère d'optimisation restent à choisir (voir [hypothèses](hypotheses.md)).
Le simulateur actuel (`SIMULATION_LINEAIRE`, `optimise = false`) sert de référence de comparaison.

## Mise à jour temps réel

SSE suffit pour l'interface locale (serveur → navigateur). Si un pont a besoin d'un canal bidirectionnel à faible latence
(commandes vers l'automate), on ajoutera un WebSocket ou une liaison série/MQTT **entre le pont et le serveur**,
sans changer le contrat avec l'interface.
