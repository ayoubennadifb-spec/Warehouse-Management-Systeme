# Générer des images 3D pour YOLO

Dimensions actuelles : **200 × 90 × 90 mm**. Le lot initial de vingt images est dans `.local/synthetic-containers-200x90x90` à la racine du projet. Il contient 58 boîtes annotées, 15 images d’entraînement et 5 de validation synthétique, avec quelques scènes vides. Ce lot sert à vérifier le générateur et les annotations ; il ne constitue pas un modèle entraîné ou validé sur le téléphone.

## Utilisation simple

Double-cliquer sur `generer_images_vision.bat` à la racine du projet. Le programme utilise Blender installé sur le PC, génère vingt nouvelles images dans un dossier daté, puis vérifie les annotations et crée `apercu_annotations.jpg`. Il travaille en arrière-plan de Blender et ne modifie pas la scène déjà ouverte.

Pour examiner une scène dans Blender : File > Open, choisir le fichier `preview_scene.blend` du dossier généré. La touche du pavé numérique 0 montre la vue de la caméra ; F12 refait le rendu. Les coordonnées sont exprimées en mètres dans Blender, et les dimensions indiquées dans le script en millimètres sont converties.

## Script Blender

`generate_blender.py` peut être ouvert dans l’espace Scripting. Il est conçu pour être lancé avec des paramètres depuis la ligne de commande :

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --python 'projet_portique_ contenaire_claude\vision\synthetic\generate_blender.py' -- --output '.local\mon-dataset' --count 20 --length-mm 200 --width-mm 90 --height-mm 90
```

Le lanceur `scripts/generate_vision_data.py` crée automatiquement un dossier distinct pour éviter de mélanger les lots. Exemple pour un lot plus grand, après examen des premières images :

```powershell
.\.venv\Scripts\python.exe scripts\generate_vision_data.py --count 500 --length-mm 200 --width-mm 90 --height-mm 90
```

## Résultats

- `images/train` et `images/val` : rendus PNG 640 × 480.
- `labels/train` et `labels/val` : annotations YOLO Pose, classe unique container, boîte englobante et quatre coins du dessus.
- `metadata` : dimensions physiques, pose de caméra, niveau et positions 3D exactes, visibilité des coins.
- `container-pose.yaml` : configuration du jeu de données.
- `preview_scene.blend` : exemple modifiable, avec plusieurs piles.
- `apercu_annotations.jpg` : orange = cadre de la boîte ; vert = coins visibles du dessus.
- `verification.json` : compte des images et annotations vérifiées.

Ordre des quatre coins : coin le plus haut dans l’image, puis sens horaire. Les coins cachés sont marqués visibilité 0 et exclus de la perte de position ; leur vérité 3D reste dans les métadonnées. Les cadres correspondent à la projection complète du volume (boîtes amodales), y compris une partie cachée par une autre boîte. Les boîtes totalement cachées sont exclues des annotations. Éviter les objets coupés par les limites de l’image ; contrôler les scènes lors de changements de dimensions.

Ce premier générateur utilise des boîtes simples et des matériaux uniformes. Pour entraîner un modèle utilisable sur le PC du portique, ajouter des textures, des fonds et éclairages proches du dispositif réel, ainsi que des photos réelles annotées. La validation synthétique vérifie les rendus ; elle ne remplace pas un test sur des scènes réelles indépendantes. Les dimensions synthétiques ne remplacent pas la calibration expérimentale de la caméra.

## Générateur avec variations

Le script varie automatiquement, pour chaque scène :

- Intensité de la source principale (8 à 60), couleur chaude/neutre/froide et taille de la source (ombres plus ou moins nettes).
- Éclairage ambiant et exposition de −1,5 à +0,35.
- Couleurs saturées ou neutres des boîtes, rugosité et texture procédurale légère.
- Fonds colorés, bruit de surface et damiers, ou textures photographiques fournies par l’utilisateur.
- Position, rotation, nombre de boîtes et empilements jusqu’à trois niveaux, avec dimensions fixes 200 × 90 × 90 mm.
- Position, hauteur et focale de la caméra virtuelle, avec vues du dessus et vues inclinées. La caméra est ajustée pour garder les boîtes dans l’image.

Les valeurs d’éclairage, de fond, d’exposition et de caméra sont enregistrées dans les métadonnées. Elles sont des paramètres de simulation, pas des mesures de luminosité de la caméra réelle. Les annotations et leur contrôle sont produits automatiquement.

Pour un lot de 500 images :

```powershell
.\.venv\Scripts\python.exe .\scripts\generate_vision_data.py --count 500 --length-mm 200 --width-mm 90 --height-mm 90 --seed 20261009
```

Pour utiliser un dossier de photos de fonds vides (JPG/PNG), ajouter `--backgrounds "C:\chemin\fonds"`. Éviter des photos contenant déjà des conteneurs : ils seraient présents dans l’image sans annotations.

Commencer par inspecter le petit lot `.local/synthetic-varied-200x90x90`. Les rendus sont calculés sur CPU ; un lot de 500 images prend nettement plus de temps. Une nouvelle graine `--seed` crée d’autres scènes ; ne pas mélanger des lots identiques dans l’entraînement et la validation. Ces variations ne garantissent pas un bon modèle réel : ajouter les photos de ses vraies boîtes et réserver un test réel indépendant.
