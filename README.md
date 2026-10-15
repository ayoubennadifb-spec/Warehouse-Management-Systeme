# Warehouse Management Systeme — Portique conteneurs

Application locale de supervision d’un portique miniature : inventaire PostgreSQL, visualisation 3D, planification des déplacements, vision par caméra et étude anti-ballant.

## Fonctionnalités

- **Gestion du stockage** : conteneurs, cases au sol, niveaux, camions, missions, réservations et historique des positions.
- **Visualisation** : scène Three.js, vue du dessus et suivi par événements SSE.
- **Trajectoires** : recherche A*, marges autour des obstacles connus et estimation des temps de déplacement.
- **Extraction sous une pile** : relocalisation des bloqueurs du haut vers le bas avant le transfert de la cible.
- **Vision** : YOLO11s Segmentation adapté aux faces des conteneurs, caméra Android/DroidCam et import d’images ou vidéos ; surfaces visibles en pixels².
- **Calibration expérimentale** : repères X/Y et trois hauteurs pour des conteneurs de dimensions connues.
- **Anti-ballant** : laboratoire ZVD avec comparaison animée, courbes X/Y, erreurs de longueur et exports JSON/CSV.

Le logiciel fonctionne en simulation. La liaison matérielle et le contrôle anti-ballant réel doivent être validés sur la maquette. Les observations visuelles n’actualisent pas automatiquement l’inventaire.

## Application principale

Les sources actuelles sont dans **`projet_portique_ contenaire_claude/`**. Le dossier comporte une espace dans son nom : conserver les guillemets dans les commandes.

- Serveur : Fastify / TypeScript, Node.js ≥ 22.18.
- Interface : Vite, Three.js et SVG.
- Base : PostgreSQL.
- Planificateur et vision : Python.

Les dossiers `backend/`, `database/` et `dist/` à la racine conservent l’ancienne version Python pour référence. Sa documentation est dans [docs/ARCHIVE_VERSION_PYTHON.md](docs/ARCHIVE_VERSION_PYTHON.md). L’alternative Docker à la racine concerne cette ancienne version.

## Installation sur un nouveau PC

Prérequis : **Python 3.12, Node.js ≥ 22.18 et PostgreSQL**. Pour la configuration PostgreSQL portable de Windows, `installer.bat` prépare l’environnement local ; son téléchargement de PostgreSQL nécessite Internet. Le dossier `.local/` et les fichiers `.env` sont créés localement et contiennent les données privées.

Pour utiliser un PostgreSQL déjà installé :

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd "projet_portique_ contenaire_claude"
npm.cmd ci
npm.cmd run db:init
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run build
$env:PLANNER_PYTHON = (Resolve-Path "..\.venv\Scripts\python.exe").Path
npm.cmd start
```

`db:init` crée un rôle dédié, les bases applicative et de test et un fichier `.env` local. Suivre ses indications pour le compte administrateur PostgreSQL. Le serveur utilise le port du fichier `.env` (3000 par défaut pour cette installation). Ouvrir l’adresse affichée dans le terminal.

Sur le PC préparé avec le lanceur Windows du projet, **`demarrer.bat`** ouvre http://127.0.0.1:8080 ; **`arreter.bat`** arrête les services en conservant les données.

Guide détaillé : [guide de lancement](projet_portique_%20contenaire_claude/docs/guide-lancement.md).

## Vision et modèle entraîné

Depuis la racine :

```powershell
.\.venv\Scripts\python.exe -m pip install -r "projet_portique_ contenaire_claude/vision/requirements.txt" -r "projet_portique_ contenaire_claude/vision/requirements-yolo.txt"
```

Le modèle utilisé par l’application est inclus dans `projet_portique_ contenaire_claude/vision/models/portique-faces-seg.pt`, avec sa fiche de validation. Il distingue le dessus, le côté long et le côté court. La mAP50 des masques vaut 95,5 % sur la validation synthétique ; les performances sur les conteneurs réels restent à mesurer.

Les scripts Blender et les notebooks Colab permettent de reproduire la génération et l’apprentissage. Les jeux d’images, checkpoints intermédiaires et anciens poids ne font pas partie du dépôt.

- [Module vision](projet_portique_%20contenaire_claude/vision/README.md)
- [Plan qualité vision](colab_vision/PLAN_QUALITE_VISION.md)
- [Notebook de segmentation](colab_vision/Portique_Faces_Segmentation.ipynb)

Les composants Ultralytics et les poids dérivés sont soumis aux conditions de licence applicables d’Ultralytics ; consulter ces conditions avant une redistribution ou un usage commercial.

## Étude anti-ballant

Ouvrir l’onglet **Anti-ballant** dans l’application. Le laboratoire compare une commande de déplacement et une version ZVD dans un modèle pendulaire à longueur constante. Les résultats sont simulés ; le modèle doit être identifié sur la suspension réelle avant intégration aux missions et aux moteurs.

[Modèle, équations et guide d’utilisation](docs/ANTI_BALLANT.md).

## Vérification

Depuis le dossier de l’application principale :

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:antisway
# Serveur déjà lancé, vérification sans écriture dans l’API :
npm.cmd run test:ui:antisway
```

Les autres tests d’intégration utilisent une base dédiée `DATABASE_URL_TEST` qui est réinitialisée pendant les tests. Configurer une base de test distincte avant `npm.cmd test`.

## Données et secrets locaux

Les mots de passe, environnements Python, dépendances, bases PostgreSQL, sauvegardes et médias importés restent sur la machine. Les exemples `.env.example` indiquent les variables à configurer. Les migrations SQL et les scripts de démonstration initialisent une nouvelle base.

[Architecture et version principale](docs/VERSION_PRINCIPALE.md) · [Modèle de données](projet_portique_%20contenaire_claude/docs/modele-donnees.md)
