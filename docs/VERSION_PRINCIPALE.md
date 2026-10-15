# Version principale adoptée — 2 octobre 2026

L’application principale est désormais celle du dossier `projet_portique_ contenaire_claude` : interface Three.js de Claude, serveur Fastify/TypeScript, modèle PostgreSQL natif de Claude, événements SSE et historique des localisations.

Les lanceurs Windows à la racine ouvrent cette version sur http://127.0.0.1:8080. La base dédiée est portique_claude sur PostgreSQL 16 portable (port 5433). Les tests utilisent exclusivement portique_claude_test.

## Apports intégrés

- Planification A* tenant compte de l’empreinte de charge, des piles et des cabines connues.
- Dégagement des conteneurs supérieurs avant extraction de la cible, du haut vers le bas.
- Enregistrement natif de chaque nouvelle localisation après confirmation de dépôt, avant demande de la mission suivante.
- Plan complet avec distances à vide/en charge et temps estimé, puis lancement à partir d’un aperçu vérifié.
- Position simulée du préhenseur persistée dans la table native unite_manutention.
- Contrôles matériels simulés isolés accessibles dans Système, sans commande de moteur.
- Conservation du fonctionnement natif de Claude pour les incidents, positions incertaines, confirmations idempotentes, configurations, camions et flux SSE.

Le planificateur Python, sans dépendance externe, est intégré dans le sous-dossier planner. Il reçoit la géométrie native (centres, zones, cabines, plateaux, blocages) et ne remplace pas la base de données de Claude. Une seule opération de dégagement est active ; les modifications de scène concurrentes sont refusées. Une annulation ou interruption arrête les étapes restantes, tout en conservant les dépôts déjà confirmés.

## Hypothèses d’optimisation

Le coût compare le temps total des approches à vide, déplacements chargés et prise/dépôt. X/Y : 100 mm/s et 200 mm/s² ; Z : 50 mm/s et 100 mm/s² ; prise et dépôt : 1 s chacun. Chaque segment commence et termine au repos. Les valeurs restent provisoires. L’animation utilise ce profil, avec le multiplicateur de vitesse de simulation.

Avec deux bloqueurs au plus et 50 cases candidates au plus, toutes les affectations sont comparées. Au-delà, recherche limitée (12 plans conservés, 16 destinations examinées). Les chemins horizontaux A* sont les plus courts en distance ; aucun optimum temporel global sur tous les chemins possibles n’est garanti. Les trajets à vide utilisent une enveloppe conservative de la taille du conteneur. Plafond illustratif : hauteur maximale des piles + trois hauteurs de conteneur. Aucun retour au parking n’est imposé après le dernier dépôt.

## Données et sauvegardes

Le dossier et les paramètres originaux de Claude sont sauvegardés dans .backups/claude-before-fusion.zip. Son ancienne adresse de base (port 55432) était indisponible ; aucune copie de ses anciennes données n’a pu être faite. La nouvelle base a été initialisée avec son jeu de démonstration (41 conteneurs). L’ancienne application Python et sa base portique restent conservées séparément pour référence. Les sauvegardes et fichiers .env contiennent des données privées et sont exclus des archives de sources.

Aucun portique réel n’est connecté. Les cartes, capteurs, caméra et mécanique restent à sélectionner puis calibrer.
