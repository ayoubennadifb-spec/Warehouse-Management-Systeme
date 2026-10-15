# Retrait d’un conteneur sous une pile

## Utilisation

Sélectionnez la cible, choisissez sa destination, puis calculez le plan. L’interface affiche chaque conteneur déplacé, sa destination et la distance totale en charge. Lancez ensuite le dégagement.

Les bloqueurs sont déplacés du sommet vers le bas, puis la cible est transportée. Chaque dépôt utilise un emplacement libre avec support : au sol ou sur une pile non pleine. La pile source et la destination finale sont exclues des emplacements de dégagement. Les conteneurs déplacés restent à leurs nouvelles places.

## Optimisation

Le coût est la somme des distances des trajets en charge, incluant le transport final de la cible. Chaque trajet est calculé avec A* et les obstacles connus de la scène projetée après les déplacements précédents. Le modèle autorise levage, translation à hauteur constante et descente.

Avec au plus deux bloqueurs et au plus 50 cases candidates, toutes les affectations admissibles sont comparées. Avec un seul bloqueur, la recherche reste exhaustive sur toute la grille. Pour les piles ou grilles plus grandes, la recherche conserve 12 plans intermédiaires et examine 16 destinations proches par expansion ; le meilleur plan trouvé est affiché sans garantie d’optimum global.

La configuration habituelle à trois niveaux et 49 cases utilise la recherche exhaustive. Le calcul peut prendre plusieurs secondes. L’optimum concerne les affectations et trajectoires du modèle choisi. Les retours à vide, temps, accélérations, consommation et obstacles non détectés ne sont pas encore inclus.

## Exécution et interruption

Le plan est vérifié par une empreinte de l’état : un aperçu devenu obsolète doit être recalculé. Une seule mission s’exécute à la fois. Chaque transfert et sa réservation sont persistés ; la séquence avance après le dépôt confirmé en simulation.

Une suspension conserve la progression. Après redémarrage, la mission et son opération sont suspendues et demandent une reprise explicite. Une annulation avant la prise laisse le conteneur en place. Une interruption après la prise rend sa position incertaine, bloque la reprise automatique et conserve la réservation jusqu’à la confirmation d’un emplacement dans l’interface. Les dégagements déjà terminés restent enregistrés.

Ces confirmations sont des confirmations de simulation. Les capteurs physiques et leur protocole devront être intégrés après fabrication.

La position simul�e du pr�henseur est sauvegard�e dans la configuration, actualis�e apr�s d�p�t ou confirmation de position. En absence de position initiale, le calcul suppose le pr�henseur au-dessus de la premi�re prise et l�annonce dans l�interface. L�approche � vide utilise une enveloppe conservative de la taille du conteneur, au-dessus de son sommet. Aucun retour au parking apr�s le d�p�t final n�est impos�. La dur�e est affich�e � vitesse 1� ; le r�glage de vitesse acc�l�re la lecture de la simulation.
