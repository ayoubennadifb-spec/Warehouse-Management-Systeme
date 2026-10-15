# Fusion des versions — 2 octobre 2026

La version principale conserve Python/FastAPI, PostgreSQL 16, le lancement Windows, les trajectoires A* avec empreinte de charge et les contrôles matériels simulés.

Les apports retenus de la version Claude sont la scène Three.js avec rotation et sélection, le flux SSE avec reconnexion et indication de perte de connexion, l’historique filtré et paginé, les changements de configuration qui préservent un inventaire compatible, et la gestion des interruptions sans retour fictif du conteneur.

Ces comportements sont adaptés au modèle et aux transactions de l’application principale. Le dossier Claude est conservé pour comparaison. Ses dimensions et son inventaire de démonstration ne remplacent pas les paramètres courants. Three.js est distribué localement avec sa licence MIT dans dist/vendor.

Une sauvegarde des sources et une copie hors ligne du stockage PostgreSQL ont été réalisées dans .backups avant migration. Ces sauvegardes locales contiennent des données privées et sont exclues du paquet de sources.

Le dégagement automatique est une nouvelle fonction commune : son plan et sa progression sont enregistrés dans PostgreSQL. Aucun portique physique n’est connecté ; les confirmations et animations restent simulées.
