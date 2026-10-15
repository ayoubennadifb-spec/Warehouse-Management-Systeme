# Vérifications de livraison

## Vérifications sur ce PC — 2 octobre 2026

- PostgreSQL natif 16.15 portable, écoute sur 127.0.0.1:5433 ; base de travail et base de tests séparées, mots de passe générés.
- 49 tests Python réussis : métier, PostgreSQL, contrat matériel, contrôle des processus et trajectoires.
- Dégagement de deux bloqueurs puis cible, absence de mutation de l’aperçu, refus de plan obsolète, manque de place, annulation, position incertaine et reprise de séquence persistée après réinitialisation.
- Configuration compatible conservée et incompatible refusée ; historique HTTP filtré avec pagination.
- 11 tests JavaScript réussis : métier et trajectoires.
- Comparaison des points de trajet Python/JavaScript ; détour avec empreinte de charge, survol, plafond infranchissable et collisions aux extrémités.
- Contrôle HTTP réussi sur la base dédiée : santé, interface, écritures, transfert animé, conflits et origine des requêtes ; les essais matériels ne changent pas l’inventaire.
- Arrêt puis redémarrage réels de l’application et PostgreSQL : état identique après redémarrage ; lancement répété sans deuxième serveur.
- Refus de présenter une base de simulation comme une base réelle en changeant simplement APP_MODE.
- Vérification du dégagement dans le navigateur : C006 puis C005 déplacés vers A3, C004 déposé en G7, trois transferts terminés ; état et historique conservés après arrêt puis relance. Vue 3D et historique inspectés.
- Vérification dans le navigateur : badge PostgreSQL, transfert C001 de A1 vers A2 avec suspension/reprise et dépôt, onglet Matériel et quatre contrôles simulés réussis.
- Syntaxe des modules JavaScript et compilation des modules Python.

Reproduction : `scripts/verify_local.py` pour les tests dédiés, `scripts/check_restart.py` pour le redémarrage de la scène courante au repos. Les commandes complètes sont dans le README.

## Vérifications de livraison initiale

- Syntaxe des modules JavaScript et compilation des modules Python.
- 5 tests du moteur JavaScript : géométrie, cycle camion complet, capacité et conflits, piles bloquées, configuration invalide.
- 5 tests du domaine Python : géométrie, camion aller-retour, piles, capacité, pause.
- 4 tests du dépôt SQL avec Psycopg : aller-retour camion et données relues après reconnexion, unicité avec annulation transactionnelle, pause au redémarrage, conservation des anciennes configurations.
- Exécution de la migration et de ses triggers sur PGlite 0.5.8, build WebAssembly de PostgreSQL, exposé au pilote Psycopg par pglite-socket. La base de l'application livrée reste PostgreSQL local standard ; PGlite n'est pas une dépendance du projet.
- Vérification de l'interface dans un DOM de test et rendu réel du canvas : arrivée, lancement de mission, dépôt, vue du dessus, refus d'une destination invalide. Inspection des vues isométrique et du dessus.
- Vérification des handlers des outils WebMCP dans ce DOM de test. Leur fonctionnement dans un navigateur disposant réellement de WebMCP n'a pas été vérifié.

- Test HTTP avec FastAPI TestClient et Psycopg : santé, fichiers de l’interface, chargement des données, transfert animé terminé, refus d’un départ pendant une mission, blocage d’une origine étrangère et vitesse invalide.

## À vérifier sur votre ordinateur

- Construction des images Docker : Docker reste absent de ce PC ; le lancement Windows natif ci-dessus est vérifié.
- Affichage à 200 % de zoom et sur téléphone. La vue de bureau et le panneau Matériel ont été inspectés visuellement.
- Débit et comportement de la future télémétrie. Aucun matériel réel n'a été connecté.
- Concurrence multi-opérateurs sur PostgreSQL natif avant un usage partagé. Le prototype exécute une mission à la fois et sérialise ses écritures.

Les tests sont livrés dans le dossier `tests`. Les tests de base utilisent une base dédiée via `TEST_DATABASE_URL`. Le contrôle HTTP `tests/api_check.py` demande `requirements-dev.txt` et vérifie l'API avec son moteur de simulation.

## Optimisation du cycle complet

63 tests r�ussis (52 Python et 11 JavaScript), avec contr�le HTTP du plan et de la s�quence termin�e. V�rifications suppl�mentaires : dur�es avec acc�l�ration, somme des co�ts � vide/en charge, approche initiale, continuit� entre d�p�ts et prises, annulation pendant approche. Migration de la position du pr�henseur et red�marrage avec �tat conserv� v�rifi�s. Les modules de l�interface passent le contr�le de syntaxe ; le contr�le visuel de cette �volution est bloqu� par les d�lais d�attente du navigateur int�gr�. Les vitesses et acc�l�rations sont des hypoth�ses explicites de simulation.
