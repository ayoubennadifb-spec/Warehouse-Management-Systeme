# Vision des conteneurs

L’application utilise **YOLO11s Segmentation**, entraîné pour reconnaître les faces `top`, `long_side` et `short_side`. Les mesures sont l’aire des pixels de chaque masque visible, en px². Les observations restent indépendantes de l’inventaire et ne sont pas automatiquement converties en millimètres ou en niveaux Z.

## YOLO et mesures géométriques

Le modèle utilisé est conservé dans `vision/models/portique-faces-seg.pt` ; le modèle Pose précédent reste dans `vision/models/portique-pose.pt` et n’est pas remplacé. Le modèle de segmentation distingue le dessus et les deux côtés. L’interface importe une image ou une vidéo, ou utilise la caméra locale/DroidCam, puis traite les images avec le même modèle.

La surface affichée est le nombre de pixels retenus dans le masque segmenté ; elle décrit la projection visible dans l’image. Elle ne représente ni la surface physique en mm² ni une face cachée. Les contours sont dessinés en vert pour le dessus, bleu clair pour le côté long et orange pour le côté court.

Chaque face reçoit un numéro de suivi temporaire. Si le dessus et un ou plusieurs côtés sont visibles, une caisse peut produire plusieurs détections. Ces numéros ne sont pas des identifiants d’inventaire et peuvent changer après une occlusion ou un déplacement.

Le modèle a été entraîné sur des scènes Blender synthétiques : 246 images d’entraînement et 80 de validation. Sur cette validation, le mAP50 des masques est de 95,5 %. L’évaluation des surfaces donne une erreur médiane de 0,7 % pour le dessus, 3,8 % pour les côtés longs et 4,1 % pour les côtés courts ; les erreurs au 95e percentile des côtés atteignent 28,4 % et 19,6 %. Ces scores ne garantissent pas les résultats sur une caméra réelle ; des essais avec les vraies boîtes restent indispensables.

## Dans la version Claude

1. Ouvrir l’application locale, puis **Vision**.
2. Importer une image ou une vidéo dans le panneau principal, ou sélectionner la caméra/DroidCam. Le flux démarre automatiquement avec le modèle de segmentation entraîné.
3. Lire les surfaces en px² et les contours colorés. Une même caisse peut avoir plusieurs IDs si plusieurs faces sont visibles.
4. Pour Android, connecter DroidCam au téléphone et au client Windows, puis choisir **Caméra / Android via DroidCam**. **Rechercher les caméras** aide à trouver l’indice de DroidCam Video ; l’indice manuel reste disponible.
5. Ouvrir **Régler la détection et la zone d’analyse** pour ajuster la surface minimale/maximale et la région de l’image. Ces paramètres sont sauvegardés localement.
6. **Enregistrer les images et les mesures** exporte l’image originale, le masque, l’image annotée et les fichiers JSON/CSV pour la même image.

Les trois images d’aperçu sont rafraîchies environ une fois par seconde ; leur lecture réseau peut arriver à des instants légèrement différents. Utiliser l’export pour comparer une image et ses mesures exactement. Une source arrêtée ou une image vieille de plus de 5 secondes est signalée comme non actualisée et ne peut pas déclencher un nouvel export.

## Fenêtre autonome avec curseurs

Depuis le dossier racine du projet :

```powershell
.venv\Scripts\python.exe -m pip install -r "projet_portique_ contenaire_claude/vision/requirements.txt"
.venv\Scripts\python.exe "projet_portique_ contenaire_claude/vision/worker.py" --source demo
.venv\Scripts\python.exe "projet_portique_ contenaire_claude/vision/worker.py" --source camera --input 1
.venv\Scripts\python.exe "projet_portique_ contenaire_claude/vision/worker.py" --source video --input "C:/chemin/video.mp4" --loop
```

Les raccourcis `vision_demo.bat` et `vision_android.bat` démarrent la fenêtre depuis la racine du projet. Le raccourci Android demande l’indice de caméra.

La fenêtre affiche original, masque et rectangles. Les curseurs prennent effet immédiatement. **P** sauvegarde les réglages, **S** capture les mesures et les images, **Q** ou Échap quitte. Les paramètres et exports autonomes sont rangés dans `.local/vision-standalone` du dossier Claude. Le module lancé dans l’application utilise un autre dossier, `.local/vision`, afin d’éviter des écritures concurrentes. Ne pas ouvrir deux captures simultanées de la même caméra.

## Interprétation des mesures

- Repère image : origine en haut à gauche, u vers la droite, v vers le bas.
- Longueur : grand côté ; largeur : petit côté du rectangle orienté.
- Angle : direction du grand côté dans l’image, modulo 180°. Cet angle n’est pas encore l’orientation dans le repère du robot.
- Rectangularité : surface du contour divisée par celle de son rectangle. C’est un critère géométrique, pas une probabilité fournie par un modèle IA.
- Les numéros d’observation sont temporaires, propres à la session. Ils peuvent changer après un masquage, un changement de paramètres ou un retour au début d’une vidéo. Deux objets qui se croisent peuvent être mal associés.
- La stabilité est calculée sur au plus 30 images. L’écart-type du centre est exprimé en pixels ; les écarts-types de longueur et largeur figurent également dans les exports. Comparer des captures d’un objet **immobile** pour mesurer la régularité. Un déplacement réel augmente lui aussi la dispersion.

## Conditions et limites

Réglages initiaux : faces bleues sur fond clair, boîtes horizontales, éclairage uniforme. Le dessus et les côtés ont des seuils de surface indépendants, car les côtés sont souvent beaucoup plus petits en projection. Les masques dont le contour n’est pas assez compact et convexe sont rejetés pour limiter les faux positifs sur du texte ou des éléments d’interface. Les images sombres reçoivent automatiquement une correction de gamma et de contraste avant l’inférence ; les surfaces sont toujours mesurées sur le masque et la résolution d’origine. Cette amélioration n’ajoute pas de détails réellement absents : ombres, flou, reflets et masquages peuvent encore empêcher la détection. Les conteneurs entièrement cachés ne sont pas observables.

Avant un essai Android : utiliser l’objectif arrière ×1, fixer le téléphone au-dessus de la scène, garder le zoom constant et vérifier l’image dans le client DroidCam. Procédure officielle : https://www.dev47apps.com/droidcam/connect/

## Vérification

```powershell
.venv\Scripts\python.exe "projet_portique_ contenaire_claude/vision/test_vision.py"
```

Depuis le dossier Claude : `node --test tests/vision.test.ts`, puis `npm run typecheck` et `npm run build`. Les essais automatiques utilisent des scènes synthétiques ; ils ne valident pas la précision sur une caméra réelle. La prochaine étape consiste à enregistrer des images Android et mesurer les erreurs avant la calibration X/Y/Z.

## Flux automatique

Aucun bouton de lancement ou d’arrêt dans l’écran Vision : le flux démarre automatiquement et les changements de source ou de détecteur sont appliqués après un court délai. Le serveur restaure la dernière configuration enregistrée au redémarrage et tente une reprise toutes les cinq secondes en cas de perte de capture. DroidCam doit être connecté pour fournir une image réelle. La capture continue quand un autre onglet est affiché.

## Calibration expérimentale depuis Vision

Ouvrir « Calibration — trois hauteurs ». Saisir longueur, largeur et hauteur h d’un conteneur réel. Pour chaque niveau (face supérieure à h, 2h, 3h), placer des repères à cette hauteur et connaître leurs coordonnées X/Y dans le même repère du portique. Figer une image, cliquer sur au moins quatre repères non alignés et répartis, puis saisir ou modifier leurs coordonnées réelles. Des repères supplémentaires permettent de vérifier l’ajustement. Pour couvrir la totalité du plateau, les points doivent entourer la zone où les conteneurs seront détectés, à chacune des trois hauteurs.

Calculer et sauvegarder les trois niveaux. Les matrices de projection plane, dimensions et repères sont enregistrés localement dans `.local/vision/calibration.json`. Elles sont chargées par le détecteur en continu et conservées au redémarrage. La surface réelle est calculée après transformation des quatre coins du contour. X/Y correspondent au centre calculé sur les coins transformés. Z face = niveau × h ; Z base = (niveau − 1) × h.

Le niveau est estimé en comparant les moyennes des côtés opposés transformés aux dimensions connues du conteneur. L’écart relatif doit être inférieur à 12 %, avec au moins 3 points de pourcentage de différence entre les deux meilleurs niveaux. Ces seuils expérimentaux ne constituent pas une probabilité de confiance. Hors de la zone couverte aux trois hauteurs, sur un cadre YOLO sans contour confirmé, après changement de source/résolution, ou si les niveaux sont trop proches, le résultat est incertain. Ne pas commander le robot sur cette estimation seule.

La calibration ne corrige pas la distorsion de l’objectif et ne détecte pas un déplacement du téléphone ou un changement de zoom. Il faut garder ces paramètres fixes, puis vérifier avec des distances indépendantes au centre et aux bords, à chaque hauteur. L’erreur d’ajustement des repères n’est pas une mesure indépendante de précision ; quatre repères peuvent donner une erreur nulle sans garantir la précision ailleurs. Aucun changement automatique des positions de l’inventaire.

## Boîtes en volume et face supérieure

YOLO11s Segmentation prédit une surface pour chacune des faces visibles : dessus, côté long et côté court. Les numéros identifient les faces détectées, pas des conteneurs distincts. Les occultations, les faces très petites ou les réglages de zone/surface minimale peuvent retirer une face du résultat.

Le modèle de segmentation reste expérimental parce que son apprentissage et sa validation utilisent des rendus Blender. Pour le rendre fiable sur le portique, il faudra filmer les vraies boîtes sous plusieurs orientations, lumières et hauteurs, puis mesurer les erreurs sur des scènes réelles distinctes de celles utilisées pour l’entraînement.

La segmentation mesure uniquement les parties visibles en projection. Elle ne reconstitue pas les faces cachées, la géométrie 3D complète ou une position X/Y/Z fiable sans une calibration et une validation séparées.
