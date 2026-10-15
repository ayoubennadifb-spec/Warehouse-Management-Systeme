# Plan de travail : vision du portique

## Objectif et limites

Détecter chaque conteneur visible et distinguer ses faces supérieure et latérales.
Mesurer le contour et la surface projetée de chaque face en pixels².
La surface réelle en mm² et X/Y/Z nécessitent une calibration caméra.
Une face entièrement cachée ne sera pas présentée comme observée.
Une face partiellement cachée fournira une surface visible, pas automatiquement sa surface complète.
La validation synthétique seule ne permet pas de promettre un fonctionnement pratique.

## 1. Auditer les données actuelles

- Vérifier les annotations des quatre coins, leur visibilité et les projections caméra.
- Comparer contours prédits et vérité géométrique, avec erreurs en pixels et en surface.
- Conserver les 105 scènes de validation séparées de l’entraînement.
- Tester également un lot indépendant de scènes avec des graines nouvelles.

## 2. Préparer les annotations de faces sans refaire les images

Les métadonnées contiennent les coins 3D, les dimensions et la caméra du générateur.
Reconstituer chaque parallélépipède, projeter ses faces et calculer les occultations
avec un tampon de profondeur. Classes : dessus, côté long, côté court.
Vérifier l’alignement avec les coins enregistrés (écart inférieur à 0,05 pixel).
Contrôler visuellement des superpositions sur les images originales.
Cette méthode concerne uniquement les cubes opaques du générateur actuel, sans déformation ni chanfrein.
Écarter une image si un contour fragmenté ou troué ne peut pas être représenté avec
au moins 98 % d’IoU par le format polygonal YOLO. Les faces rasantes de moins de 16 pixels
sont exclues des cibles de mesure. Les petits trous/isoles d’échantillonnage ne sont simplifiés
que si ce contrôle de fidélité reste satisfait.
Les masques sont géométriques : valider visuellement les différences possibles d’anticrénelage aux bords.

## 3. Entraîner sur Colab

- Réutiliser portique_dataset.zip déjà dans Drive.
- Transférer uniquement le petit paquet face-labels.zip.
- Démarrer avec YOLO11s Segmentation, préentraîné, sur les trois classes de faces.
- Augmentations de lumière, saturation, translation et échelle ; rester proche de la caméra réelle.
- Enregistrer best.pt et last.pt dans Drive à chaque passage terminé.
- Comparer avec le modèle Pose existant ; ne pas remplacer celui de l’application avant mesure.
- Si Colab coupe, reprendre last.pt de ce nouvel entraînement, avec la même version Ultralytics.

## 4. Évaluer les contours et les mesures

Rapporter par classe : précision, rappel, IoU des masques et erreurs de surface.
Séparer dessus entièrement visible, dessus partiellement visible et faces latérales.
Mesurer médiane et percentile 95 des erreurs ; afficher les échecs, pas seulement les moyennes.
Mesurer aussi le temps de traitement sur le PC utilisé pour le portique.
Les variantes d’un même exemple restent dans le même lot pour éviter les fuites de données.

Objectifs provisoires à confirmer avec l’encadrant pour les dessus entièrement visibles :
- précision et rappel au moins 95 % sur un test indépendant ;
- erreur de surface médiane au plus 5 %, percentile 95 au plus 10 % ;
- IoU du masque médian au moins 0,90.

Ces seuils sont des critères de décision proposés, pas des performances déjà obtenues.

## 5. Intégrer le modèle validé

Afficher les contours des faces et leur surface en pixels².
Associer les faces au conteneur détecté ; signaler les associations ambiguës.
Limiter les mesures lorsque le dessus est masqué, coupé ou peu fiable.
Le suivi conserve des numéros temporaires. Aucun déplacement robot ne sera déclenché
sur la seule base d’une observation incertaine.

## 6. Valider en pratique

Fixer le téléphone en hauteur, conserver résolution et zoom, stabiliser la lumière.
Collecter des photos réelles de boîtes ou de conteneurs 200 × 90 × 90 mm.
Réserver des séances entières au test ; annoter d’autres séances pour le fine-tuning.
Vérifier les trois niveaux avec des mesures indépendantes après calibration.
Tester scènes vides, empilements, plusieurs objets, mouvements et perte de connexion.
Adopter le modèle seulement après réussite sur ces essais réels.

## Sources techniques

- https://docs.ultralytics.com/datasets/segment/
- https://docs.ultralytics.com/tasks/segment/
- https://docs.blender.org/manual/en/latest/render/layers/passes.html

## Première étape réalisée

- 419 images auditées, 1 149 objets ; 734 dessus avec quatre coins visibles, 415 entièrement masqués.
- Projection reconstruite : écart maximal 0,000123 pixel avec les coordonnées enregistrées.
- 326 images retenues pour les annotations de faces : 246 train, 80 validation, sans mélange des lots.
- 1 594 faces : 454 dessus, 626 côtés longs, 514 côtés courts.
- 93 images exclues pour conserver la fidélité des polygones.
- Paquet face-labels.zip : environ 0,47 Mo ; aucune nouvelle image RGB stockée.
- Superpositions contrôlées visuellement sur six scènes ; trois tests géométriques réussis.
- Notebook Colab préparé ; segmentation pas encore entraînée ni validée sur caméra réelle.

### Référence mesurée du modèle Pose actuel

15 nouvelles scènes synthétiques, graines et images distinctes du lot d’apprentissage :
48 conteneurs attendus, 44 appariés (IoU de boîte >= 0,5), 4 manqués et 2 fausses détections.
Précision : 95,7 % ; rappel : 91,7 %, pour une confiance minimale de 0,15.
Sur les 28 dessus entièrement visibles et mesurables : erreur médiane des coins 2,76 pixels,
percentile 90 de 5,27 pixels ; erreur médiane de surface 5,03 %.
Les coins sont comparés géométriquement modulo ordre cyclique et symétrie, car le dessus est symétrique.
Ce petit lot ne garantit pas les performances réelles ; il fournit une référence pour les prochains essais.
