# Calcul des trajectoires de simulation

Le planificateur utilise les empreintes et hauteurs des piles et des camions
présents. Il tient compte de la longueur et de la largeur du conteneur déplacé.
Les cabines sont des obstacles de 31 mm de haut, conformément au dessin actuel.

Pour chaque hauteur utile, un calcul A* cherche un chemin horizontal par segments
parallèles aux axes X et Y. La grille suit les bords des obstacles agrandis de
l’encombrement de la charge et de sa marge. Le trajet comprend un levage vertical,
une translation à hauteur constante et une descente verticale.

Le choix minimise la distance totale parcourue parmi cette famille de trajets.
Il peut choisir un détour bas ou un survol plus haut. Il refuse une prise/dépose
en collision et l’absence de passage sous le plafond de simulation.

Valeurs actuelles : marge verticale de 20 % de la hauteur du conteneur (10 mm
par défaut), marge horizontale de 10 % de sa largeur plafonnée à 5 mm et hauteur
maximale de la base de la charge de `levels × containerHeight + 1,2 × containerHeight`
(210 mm par défaut). Ces valeurs sont des hypothèses de simulation, à remplacer
par les dimensions et courses validées sur la maquette.

Les missions enregistrent les points (`waypoints`), la distance (`routeLengthMm`),
la hauteur de translation (`cruiseHeightMm`) et les marges. Le serveur Python et
la démonstration JavaScript produisent les mêmes trajets sur les cas de test.
L’affichage et l’animation suivent ces points. Les anciennes missions gardent
leur trajet historique jusqu’à leur achèvement.

La durée animée reste fixée à sept secondes à vitesse 1×. Ce n’est donc pas encore
une optimisation du temps de déplacement : accélérations, vitesses maximales,
ballant, encombrement du préhenseur et dynamique mécanique ne sont pas modélisés.
Les obstacles proviennent de l’état connu ; la caméra, les obstacles mobiles et
le recalcul en cours de mission ne sont pas encore intégrés.
