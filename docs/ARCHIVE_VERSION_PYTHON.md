# Application principale : version Claude fusionnée

Depuis le 2 octobre 2026, ouvrez **demarrer.bat** : il lance l’interface et le serveur de Claude avec nos améliorations. Adresse : http://127.0.0.1:8080. Sources principales : `projet_portique_ contenaire_claude/`. Voir `docs/VERSION_PRINCIPALE.md` et le README de ce dossier.

Les sections ci-dessous décrivent la version Python conservée pour référence.

# Portique Lab

Simulateur interactif du portique miniature, avec stockage **800 × 500 mm**, transport **200 × 500 mm**, grille **7 × 7 × 3** et capacité de **60 conteneurs présents**. Interface française. Aucune solution mécanique n'est imposée.

## Lancement complet sur votre PC

### Windows : lancement en un double-clic

Cette installation locale est prête. Ouvrez **`demarrer.bat`** pour démarrer
PostgreSQL et l’application, puis le navigateur. Ouvrez **`arreter.bat`** pour
les arrêter ; les données sont conservées. Le badge affiche **SIMULATION · POSTGRESQL**.

Sur un nouveau PC Windows avec Python 3.12, exécutez **`installer.bat`** une
première fois. Il prépare l’environnement Python et PostgreSQL 16 portable depuis
[EnterpriseDB](https://www.enterprisedb.com/download-postgresql-binaries).
Node.js est nécessaire uniquement pour les tests JavaScript.

- Application : **http://127.0.0.1:8080**.
- PostgreSQL du projet : `127.0.0.1:5433`, base `portique`.
- Données : `.local/postgres/` ; journaux : `.local/app.log` et `.local/postgres.log`.
- Base de tests distincte : `portique_test`, avec un utilisateur séparé.
- Identifiants générés : `.env` et `.local/`, exclus de l’archive des sources.
- PostgreSQL et ses données sont propres au projet ; les autres installations restent indépendantes.

Gardez `.local/` pour conserver les données. Le lanceur refuse de démarrer si le
port 8080 est occupé par un autre serveur et évite les doubles démarrages.

### Alternative avec Docker Desktop

Installez Docker Desktop puis ouvrez un terminal dans ce dossier :

```sh
docker compose up --build
```

Ouvrez **http://localhost:8080**. Le badge doit afficher **SIMULATION · POSTGRESQL**. PostgreSQL s'exécute sur votre ordinateur. Les tables sont créées au premier lancement et le jeu de démonstration est ajouté une seule fois. Le volume `portique_data` conserve les données lorsque les services sont arrêtés.

```sh
docker compose down
```

Cette commande arrête les services sans effacer le volume. Ne pas ajouter `-v` si vous souhaitez conserver les données.

Les identifiants par défaut sont réservés au développement local : base `portique`, utilisateur `portique`, mot de passe `portique_dev`. Pour les personnaliser **avant la première initialisation**, copiez `.env.example` vers `.env` et modifiez les variables. Les services sont exposés seulement sur 127.0.0.1. Si le port 5432 est déjà utilisé, adaptez son côté gauche dans `compose.yaml` ; l'application Docker continue à joindre `db:5432`.

### Option avec PostgreSQL déjà installé

Prérequis : PostgreSQL 16 ou ultérieur et Python 3.12 ou ultérieur. Créez une base vide et un utilisateur propriétaire. Dans `psql`, avec un compte autorisé :

```sql
CREATE ROLE portique LOGIN PASSWORD 'votre_mot_de_passe';
CREATE DATABASE portique OWNER portique;
```

Copiez `.env.example` en `.env` et adaptez `DATABASE_URL`. Si le mot de passe contient des caractères réservés d'une URL, encodez-les dans cette URL.

Sous Windows PowerShell :

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8080 --workers 1
```

Sous macOS / Linux :

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8080 --workers 1
```

Gardez **un seul processus serveur**, car le moteur de simulation s'exécute dans ce processus. Ouvrez http://localhost:8080. La documentation interactive des routes est à http://localhost:8080/docs.

### Démonstration de l'interface sans base

```sh
python -m http.server 8080 --directory dist
```

L'interface détecte l'absence de l'API et passe en **SIMULATION LOCALE**. Dans ce mode uniquement, les données de démonstration restent dans le navigateur. Ce mode ne remplace pas PostgreSQL. Ne pas ouvrir `index.html` directement en `file://`, car les modules JavaScript nécessitent un serveur HTTP.

## Utilisation

1. Cliquez sur un conteneur dans la scène, ou choisissez-le dans le menu Mission.
2. Choisissez une case ou un plateau de camion libre. Pour une cible sous une pile, cliquez **Calculer le plan**, consultez les étapes, puis **Lancer le dégagement**. Les conteneurs supérieurs sont déplacés automatiquement avant la cible.
3. Utilisez **Suspendre / Reprendre** et le réglage de vitesse.
4. Dans **Transport**, faites arriver un camion vide ou chargé ; utilisez **Départ** pour le faire quitter la zone.
5. Dans **Configuration**, changez les dimensions et les quantités. Consultez l’impact avant application. Appliquer archive l’ancienne configuration et conserve les conteneurs et camions compatibles ; un changement qui supprimerait une position occupée est refusé. L'action est bloquée pendant une mission.
6. Dans **Données**, consultez le modèle et exportez l'état JSON.

Les emplacements sur un camion sont attachés à une **visite**, jamais confondus avec une case au sol. Un camion en transfert ne peut pas partir. Chaque prise concerne le sommet d’une pile ; le dégagement permet d’accéder automatiquement aux niveaux inférieurs ; le niveau de dépôt est déterminé automatiquement. La limite de 60 compte les conteneurs stockés, sur camion et en transit.

## Arborescence

- `dist/` : interface et moteur de démonstration navigateur, sans dépendance de compilation.
- `backend/domain.py` : règles métier et moteur de simulation serveur.
- `backend/repository.py` : transactions et projection de l'état depuis les tables normalisées.
- `backend/app.py` : API FastAPI, flux SSE et interface servie à la même adresse.
- `database/001_schema.sql` : migration PostgreSQL, contraintes et index.
- `docs/CONCEPTION.md` : choix et dictionnaire des données, y compris transport.
- `docs/DIGITAL_TWIN.md` : contrat d'intégration matérielle et limites de cette version.
- `tests/` : tests métier et intégration de persistance.

## Ce qui est réalisé et ce qui reste à intégrer

Réalisé : simulation paramétrable, vue 3D orientable / dessus, dégagement automatique optimisé, annulation avec confirmation des positions incertaines, historique filtré et paginé, piles, sélection, chargement / déchargement, départ camion, transactions PostgreSQL, historique, configurations archivées, pause après redémarrage d'une mission interrompue, flux SSE disponible, lancement et arrêt Windows, calcul A* des trajectoires à partir des obstacles connus et contrôles matériels simulés.

À intégrer : identification réelle des conteneurs, calibration des caméras, détection d'obstacles mobiles, vitesses/accélérations et contraintes mécaniques, confirmations physiques et commande Arduino. Le calcul minimise la distance parmi les trajets de levage, translation à hauteur constante et descente. Les marges et courses utilisées restent des hypothèses de simulation. Voir `docs/TRAJECTORIES.md` et `docs/HARDWARE.md`.

Le bouton de connexion en lecture sert à afficher une API compatible. Le mode `APP_MODE=real` désactive le simulateur et les mutations de démonstration : il ne crée pas de données matérielles. L'adaptateur de télémétrie physique reste à développer avec les capteurs choisis.

## Tests

Installation Windows préparée, application démarrée :

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe scripts\verify_local.py
.\.venv\Scripts\python.exe scripts\check_restart.py
```

La première vérification utilise exclusivement `portique_test`. La seconde arrête
puis relance l’application et vérifie que la scène courante au repos est conservée.

Commandes individuelles :

```sh
node --test tests/domain.test.mjs
python -m unittest discover -s tests -v
```

Les tests de persistance exigent une **base dédiée vide**, désignée par `TEST_DATABASE_URL` ; ils créent des configurations de test mais ne suppriment pas votre base. Ne les exécutez pas contre votre base de travail.

Voir `docs/VALIDATION.md` pour les vérifications réellement exécutées lors de la livraison.

## Fusion et dégagement

Voir `docs/FUSION.md` pour les apports des deux versions et `docs/RETRIEVAL.md` pour les limites précises de l’optimisation.
