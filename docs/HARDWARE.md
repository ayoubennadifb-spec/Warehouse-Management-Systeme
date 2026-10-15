# Préparer le PC et l’Arduino

## État actuel

Le portique n’est pas encore fabriqué. L’architecture retenue prévoit un PC pour
la planification et la vision, une carte Arduino pour les moteurs pas à pas et
des fins de course. Les références, le câblage et les courses restent à définir.

Le module `backend/hardware.py` et l’onglet **Matériel** permettent de tester les
contrôles logiciels sur un adaptateur simulé isolé. Aucun port série n’est ouvert,
aucune impulsion moteur n’est envoyée et l’inventaire PostgreSQL reste inchangé
pendant ces essais. Le statut expose toujours `physical_commands_enabled=false`.

## Répartition future

- **PC** : identification des conteneurs, calibration des images, carte des
  obstacles, choix du trajet, missions, stockage et interface opérateur.
- **Arduino** : génération régulière des impulsions, accélération/décélération,
  lecture des fins de course et du préhenseur, watchdog de communication.
- **Circuit de sécurité** : arrêt d’urgence indépendant du navigateur et du PC,
  conçu et vérifié avec la partie électrique de la maquette.

Le calcul du PC ne remplace pas la génération déterministe des pas sur le
contrôleur. Les valeurs déduites du nombre de pas sont des estimations de position
tant qu’elles ne sont pas confirmées par une mesure appropriée.

## Contrat logiciel disponible

`HardwareGuard` valide des échantillons complets avec :

- version 1, source, session, séquence croissante, horodatage avec fuseau ;
- identifiant de calibration, positions x/y/z en mm ;
- référencement de chaque axe (`homed`) ;
- six signaux de fins de course (`x_min` à `z_max`) ;
- connexion, arrêt d’urgence, zone libre et retour de préhenseur
  (`unknown`, `empty` ou `holding`).

Sans mesures fraîches, calibration ou courses définies, les commandes sont
bloquées. Un défaut annule la commande simulée en attente. Une mesure redevenue
normale ne suffit pas à reprendre : une reprise explicite est obligatoire.

Les confirmations de prise/dépôt comportent un identifiant d’événement, la
commande, le conteneur, la session et une nouvelle mesure. Les doublons exacts
sont ignorés, les confirmations incohérentes refusées. Ce contrat ne modifie
pas encore les tables d’occupation ; le raccordement transactionnel reste à faire
avec l’adaptateur physique.

`MockAdapter` permet d’éprouver le contrat sans matériel. `self_test()` couvre
l’arrêt d’urgence simulé, la perte de connexion, une fin de course et un obstacle,
ainsi que leur reprise explicite. Les tests unitaires couvrent aussi les limites,
les mesures périmées, le référencement et les confirmations de préhenseur.

## À définir avant le branchement

1. Référence Arduino, nombre d’axes/moteurs, pilotes, alimentation et câblage.
2. Course, sens et conversion pas/mm de chaque axe ; vitesses et accélérations.
3. Type et polarité des fins de course, procédure de référencement et dégagement.
4. Préhenseur et signal fiable de prise/dépôt ; identification des conteneurs.
5. Caméra, placement, résolution, cadence, calibration pixels/mm et mesure de hauteur.
6. Liaison USB série, format de trame, accusés de réception, séquences et délais.
   Le PC devra relier les horodatages du contrôleur à son horloge et vérifier
   l’ancienneté des mesures ; un simple instant de réception ne suffit pas.
7. Réaction locale de l’Arduino à une perte de communication et procédure de reprise.

Les essais physiques devront commencer sans charge, puis à vitesse réduite avec
une charge adaptée, après validation des limites et du circuit d’arrêt. Le statut
logiciel actuel ne constitue pas une validation de la machine.
