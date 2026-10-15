# Guide de lancement local

Tout fonctionne en local : PostgreSQL local, serveur Node local, interface servie par ce serveur.
Rien n'est déployé en ligne.

## 1. Prérequis

| Outil | Version | Vérification |
|---|---|---|
| Node.js | ≥ 22.18 (testé 24.14) — exécute le TypeScript directement | `node --version` |
| PostgreSQL | testé 13.3 (toute version ≥ 13 convient) | service `postgresql-x64-13` démarré |
| Navigateur | Edge, Chrome ou Firefox récent (WebGL pour la vue 3D) | — |

`psql` n'est pas nécessaire. Le mot de passe du super-utilisateur `postgres` (choisi à l'installation de PostgreSQL)
est demandé **une seule fois** par `npm run db:init`.

## 2. Installation (PowerShell)

```powershell
cd "C:\Users\ayoub\Emines\S7\Robotique\projet_portique_ contenaire_claude"
npm install
npm run db:init
```

`db:init` :
1. demande hôte (`localhost`), port (`5432`), utilisateur administrateur (`postgres`) et son mot de passe (saisie masquée, jamais enregistrée) ;
2. crée le rôle **`portique_app`** avec un mot de passe aléatoire, et les bases **`portique`** et **`portique_test`** (UTF8) ;
3. écrit **`.env`** (ignoré par git) avec `DATABASE_URL` et `DATABASE_URL_TEST`.

Variante non interactive : `$env:PGADMIN_URL = "postgres://postgres:MOTDEPASSE@localhost:5432/postgres"; npm run db:init`
(puis fermez la fenêtre PowerShell pour effacer la variable).

Préférez-vous créer la base vous-même ? Copiez `.env.example` en `.env` et renseignez une URL valide.

```powershell
npm run db:migrate
npm run db:seed
npm run build
npm start
```

Ouvrez **http://127.0.0.1:3000**. Arrêt : `Ctrl+C`.

## 3. Mode développement

```powershell
npm run dev
```
Interface sur **http://127.0.0.1:5173** (rechargement à chaud) ; le serveur API redémarre à chaque modification
de `src/server` ou `src/shared`.

## 4. Configuration (`.env`)

| Variable | Défaut | Rôle |
|---|---|---|
| `DATABASE_URL` | — | connexion de l'application (rôle dédié) |
| `DATABASE_URL_TEST` | — | base des tests, **effacée** à chaque exécution |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | serveur local (accessible seulement depuis ce PC) |
| `SOURCE_EVENEMENTS` | `SIMULATION` | `MATERIEL` pour attendre un pont matériel |

Paramètres de la maquette : `config/maquette.defaut.json` (plan initial), puis onglet **Paramètres** de l'interface.
Paramètres de simulation (vitesses illustratives) : `config/simulation.json`.

## 5. Utilisation rapide

- **Transférer** : cliquer un conteneur (3D) ou une pile (vue du dessus) → *Choisir une destination* → case verte → *Lancer le transfert*.
  Survoler une case grisée explique le refus.
- **Camions** : onglet *Camions* → *Faire arriver* (vide ou avec conteneur) ; *Décharger…*, *Charger…*, *Départ*.
- **Simulation** : *Pause* / *Reprendre*, vitesse, *Incident simulé* (interrompt la mission en cours).
- **Position incertaine** : bandeau d'alerte → *Déclarer la position* (constat de l'opérateur).
- **Paramètres** : modifier → *Vérifier* → *Enregistrer comme nouvelle version* → lire l'analyse → *Activer*.

## 6. Tests

```powershell
npm test          # 33 tests : géométrie, règles métier, versions de plan, API/SSE/redémarrage
npm run build
npm run test:ui   # Edge ou Chrome sans fenêtre, 4 tailles d'écran, captures dans tests/ui/captures
```

## 7. Dépannage

| Symptôme | Cause probable / solution |
|---|---|
| `DATABASE_URL manquant` | lancer `npm run db:init` ou créer `.env` |
| « l'authentification par mot de passe a échoué » | mot de passe `postgres` erroné à `db:init` ; ou `.env` modifié à la main |
| `Connexion PostgreSQL impossible … ECONNREFUSED` | service PostgreSQL arrêté : *services.msc* → `postgresql-x64-13` → Démarrer |
| `La base contient déjà des données` (db:seed) | normal si déjà chargée ; repartir de zéro : `npm run db:reset -- --oui` |
| page « Interface non construite » | `npm run build` |
| port 3000 occupé | mettre `PORT=3001` dans `.env` |
| bandeau « Connexion perdue » | serveur arrêté ou base injoignable ; reprise automatique à la reconnexion |
| vue 3D vide | WebGL désactivé dans le navigateur ; la vue du dessus reste utilisable |
