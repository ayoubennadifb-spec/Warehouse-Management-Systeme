# Version principale adoptée — fusion du 2 octobre 2026

Cette application est désormais la version principale. Depuis le dossier parent, double-cliquez sur **demarrer.bat** ; **arreter.bat** arrête le serveur et PostgreSQL en conservant les données. Adresse : http://127.0.0.1:8080.

Choisissez un conteneur, y compris sous une pile, puis une destination. Cliquez **Calculer le plan complet**, vérifiez les dégagements, distances à vide/en charge et durée estimée, puis **Lancer le transfert**. Le panneau Missions affiche la progression ; les nouvelles positions sont enregistrées après chaque dépôt.

Le serveur reste Fastify/TypeScript et la base utilise le modèle original de Claude. Le calcul Python intégré utilise la géométrie native, A*, un profil de vitesse et d’accélération provisoire, et la position persistée du préhenseur. Voir `../docs/VERSION_PRINCIPALE.md` pour les hypothèses et la provenance des données. Python 3.12 et Node.js ≥22.18 sont nécessaires ; PLANNER_PYTHON permet de choisir Python. Les tests effacent exclusivement DATABASE_URL_TEST, qui doit être une base dédiée.

# Portique conteneurs — mémoire PostgreSQL, simulation et interface (V1)

Application **locale** pour le portique miniature de manutention de conteneurs (projet étudiant, cellule informatique).
Elle tient la **mémoire du système** dans PostgreSQL, simule les déplacements, gère les camions,
et affiche l'espace de travail **à l'échelle** (vue 3D isométrique + vue du dessus).
Elle est conçue pour devenir le **jumeau numérique** de la maquette : la même API et la même base
accepteront les confirmations du matériel réel à la place de la simulation.

> ⚠ Le jeu de données chargé par défaut est une **démonstration** (codes `DEMO-…`) : il ne représente
> pas le mapping réel de la maquette. Les trajets animés sont des **trajets de simulation**
> (montée – translation – descente), ni optimisés ni validés. Aucun mécanisme (rails, courroies,
> crochet, pince…) n'est représenté : l'« unité de manutention » est un indicateur abstrait.

## Démarrage rapide (Windows, PowerShell)

Prérequis : Node.js ≥ 22.18 (testé avec 24.14) et PostgreSQL local (testé avec 13.3).

```powershell
cd "C:\Users\ayoub\Emines\S7\Robotique\projet_portique_ contenaire_claude"
npm install
npm run db:init      # crée le rôle portique_app + bases portique et portique_test, écrit .env
                     # (demande le mot de passe du super-utilisateur postgres, sans l'enregistrer)
npm run db:migrate   # applique db/migrations/*.sql
npm run db:seed      # plan initial + jeu de démonstration
npm run build        # construit l'interface
npm start            # → http://127.0.0.1:3000
```

Guide détaillé, dépannage et mode développement : [docs/guide-lancement.md](docs/guide-lancement.md).

## Ce que permet la V1

- Base PostgreSQL relationnelle : versions de plan, zones, positions au sol, emplacements par niveau,
  conteneurs, camions, postes, visites, missions, réservations, confirmations, journal d'événements,
  historique des localisations ; tables prêtes pour caméras, calibrations, obstacles, trajets, alertes.
- Règles garanties **par la base** (contraintes et déclencheurs) et expliquées par l'API :
  un conteneur par emplacement, empilement avec support, retrait au sommet, réservations exclusives,
  un conteneur par plateau, un camion par poste, départ interdit pendant un transfert, capacité.
- Missions avec séparation **demande / prise confirmée / dépôt confirmé**, suspension, reprise,
  interruption (position incertaine signalée), annulation sans « retour fictif ».
- Camions : arrivée vide ou chargée, affectation de poste, refus tracé, chargement, déchargement, départ.
- Paramètres modifiables dans l'interface (géométrie vérifiée, nouvelle version de plan, analyse d'impact).
- Temps réel par SSE : reprise après coupure, détection des données anciennes, mode simulation / connecté visible.

## Arborescence

```
config/              paramètres initiaux de la maquette et de la simulation (JSON, sans secret)
db/migrations/       schéma SQL versionné (001 base, 002 règles d'intégrité, 003 extensions futures)
src/shared/          géométrie paramétrable (fonctions pures, testées)
src/server/          API Fastify, règles métier (domaine/), temps réel, sources d'événements (sources/)
src/client/          interface (Vite + TypeScript + Three.js + SVG)
scripts/             db:init, migrations, démo, réinitialisation, dev, exemple de pont matériel
tests/               tests géométrie, domaine, plans, API (node:test) + test navigateur (tests/ui)
docs/                architecture, modèle de données, hypothèses, vérifications, évolution matériel
```

## Commandes

| Commande | Rôle |
|---|---|
| `npm run db:init` | crée rôle + bases, écrit `.env` (une seule fois) |
| `npm run db:migrate` | applique les migrations en attente |
| `npm run db:seed` | plan initial + démonstration (base vide uniquement) |
| `npm run db:reset -- --oui` | **efface tout** puis migrations + démonstration |
| `npm run build` / `npm start` | construit puis lance l'application (port 3000) |
| `npm run dev` | développement : API relancée à chaque modification + Vite (port 5173) |
| `npm test` | tests automatiques (utilisent `portique_test`, qui est vidée) |
| `npm run test:ui` | test dans Edge/Chrome + captures d'écran (`tests/ui/captures/`) |
| `npm run typecheck` | vérification TypeScript |

## Documentation

- [Architecture et repère](docs/architecture.md)
- [Modèle relationnel et dictionnaire des données](docs/modele-donnees.md)
- [Hypothèses et points à décider](docs/hypotheses.md)
- [Vérifications réalisées et restantes](docs/verifications.md)
- [Évolution vers le matériel réel](docs/evolution-materiel.md)
