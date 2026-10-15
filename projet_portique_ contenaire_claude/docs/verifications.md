# Vérification de la version principale fusionnée — 2 octobre 2026

- Construction Vite et contrôle TypeScript réussis.
- 35 tests natifs réussis : HTTP, SSE, incident, reprise, confirmations, géométrie, règles métier, configurations et dégagement.
- Contrôles matériels simulés isolés ajoutés dans Système, sans commande physique ni modification de l’inventaire.
- Essai réel sur le serveur local de simulation : DEMO-003 → A4, DEMO-002 → B3, puis DEMO-001 → A1 ; trois dépôts confirmés, aucune réservation restante. Plan : 1 606 mm dont 1 228 mm à vide, 34,0 s estimées à ×1.
- Arrêt et redémarrage via les lanceurs Windows : positions, opérations, camions et historique conservés ; lancement répété sans deuxième serveur.
- Le contrôle visuel de cette fusion est bloqué par l’indisponibilité du navigateur automatisé. Les captures ci-dessous documentent la version originale de Claude.

## Vérifications antérieures

# Vérifications

## Conditions d'exécution

- Windows 11, Node.js 24.14, **PostgreSQL 13.3** (mêmes binaires que le service `postgresql-x64-13` installé),
  Edge (via playwright-core) pour l'interface.
- ⚠ Les tests ont tourné sur une **instance PostgreSQL 13.3 temporaire** (port 55432), créée pour l'occasion avec un rôle
  `portique_app` et les bases `portique` / `portique_test`. Le mot de passe du service local (port 5432) n'étant pas connu,
  l'installation **sur ce service** (`npm run db:init`) n'a pas été exécutée : c'est la première étape à faire
  (voir [guide](guide-lancement.md)). Le code, les migrations et les scripts sont identiques.

## Tests automatiques exécutés — `npm test` : 33/33 réussis (3 passages consécutifs)

| Exigence | Fichier | Ce qui est vérifié |
|---|---|---|
| Géométrie des deux zones | `geometrie.test.ts` | stockage X 0–800, transport X 800–1 000, aires sommées = 1 000 × 500, zones contiguës |
| Répartition proposée | `geometrie.test.ts` | 12,5 mm (X) et 18,75 mm (Y), marges de fin égales |
| 49 positions / 147 emplacements | `geometrie.test.ts`, `domaine.test.ts`, `api.test.ts` | calcul pur **et** lignes réellement générées en base (`v_capacite_plan`) |
| Camions dans la zone transport | `geometrie.test.ts` | 4 camions de 150 × 50 mm dans 200 × 500 mm, sans chevauchement ; refus si trop de postes ou postes manuels qui se chevauchent |
| Règles d'empilement | `domaine.test.ts` | dépôt sans support refusé (règle métier **et** écriture SQL directe refusée par la base) ; retrait du dessous refusé ; un conteneur par emplacement |
| Transfert stockage → stockage | `domaine.test.ts` | la demande ne change pas la position ; réservations ; prise ⇒ `EN_TRANSFERT` ; dépôt ⇒ destination ; historique ; réservations libérées |
| Déchargement camion → stockage | `domaine.test.ts` | type de mission, départ refusé pendant le transfert, puis départ à vide |
| Chargement stockage → camion | `domaine.test.ts` | chargement, départ chargé ⇒ conteneur `SORTI`, retour du même camion = nouvelle visite |
| Conflits d'occupation et de réservation | `domaine.test.ts` | même destination refusée ; même conteneur dans deux missions refusé ; empilement sur un conteneur engagé refusé |
| Demandes simultanées | `domaine.test.ts` | 8 demandes parallèles sur une même destination ⇒ exactement 1 acceptée |
| Postes saturés | `domaine.test.ts` | arrivée refusée, visite `REFUSEE` tracée, conteneur annoncé non entré |
| Capacité | `domaine.test.ts` | arrivée chargée refusée à la limite ; écriture directe refusée par la base |
| Confirmations idempotentes | `domaine.test.ts`, `api.test.ts` | même clé ⇒ appliquée une fois ; dépôt en double ⇒ rejet tracé |
| Interruption de mission | `domaine.test.ts`, `api.test.ts` | après prise ⇒ `INCERTAINE` + coordonnées connues + alerte + réservations gardées ; reprise exige une confirmation ; « incident simulé » ⇒ file bloquée ⇒ déclaration de position |
| Annulation après prise | `domaine.test.ts` | pas de réapparition à la source ; déclaration ; libération |
| Journal non modifiable | `domaine.test.ts` | `DELETE FROM evenement` refusé |
| Modification des paramètres | `plans.test.ts` | paramètres invalides refusés sans écriture ; même géométrie ⇒ conteneurs conservés aux mêmes coordonnées ; espacement modifié ⇒ refus puis activation forcée ⇒ positions incertaines ; version activée immuable ; 6 × 5 × 4 ⇒ 30 / 120 |
| Persistance après redémarrage | `api.test.ts` | arrêt / redémarrage du serveur : état identique lu en base ; mission suspendue reprise ; coupure brutale pendant un transfert ⇒ `INTERROMPUE` + `INCERTAINE` + file bloquée ; reprise ⇒ trajet v2 |
| Temps réel | `api.test.ts` | événements SSE ordonnés ; rejeu des événements manqués avec `Last-Event-ID` |
| Mode matériel | `api.test.ts` | « aucun matériel connecté » affiché honnêtement ; pont TEST signalé ; confirmations HTTP idempotentes |

## Test d'interface exécuté — `npm run test:ui` : 16/16 réussis (Edge)

Ordinateur 1600 × 1000 : 49 cases ; indicateurs 41/60 et 40/147 ; badges simulation et démonstration ; refus « pas au sommet » ;
choix de destination (cases vertes) ; mission lancée ; pause ⇒ mission suspendue ; reprise ⇒ terminée ;
4 arrivées ⇒ refus « aucun poste disponible » affiché ; vérification des paramètres (49 / 147 / 12,5 / 18,75) ;
paramètres incohérents refusés ; aucune erreur JavaScript.
Portable 1366 × 768, tablette 1024 × 768, téléphone 390 × 844 : aucun débordement horizontal, sélection fonctionnelle.
Arrêt du serveur : bandeau « données potentiellement anciennes », commandes désactivées.
Captures : `tests/ui/captures/` (examinées visuellement).

Défauts trouvés et corrigés grâce à ces tests : marqueur de l'unité qui interceptait les clics ; arrêt du serveur
bloqué par les flux SSE ouverts ; pastilles API/PostgreSQL restant vertes après une coupure.

## Vérifications restant à réaliser

1. `npm run db:init` + `npm run db:migrate` + `npm run db:seed` sur **votre** service PostgreSQL (port 5432).
2. Essai manuel complet par l'équipe (lisibilité, vocabulaire, ergonomie sur vos écrans, Firefox non testé).
3. Navigateurs sans WebGL : message prévu, non testé.
4. Coupure de PostgreSQL seul (serveur maintenu) : bandeau prévu (battement), non testé automatiquement.
5. Charge : non mesurée au-delà de la démonstration (≈ 60 conteneurs, quelques missions).
6. Mode matériel avec un vrai pont : uniquement simulé par un pont « TEST ».
7. Tous les paramètres sont des hypothèses : la conformité à la maquette physique ne pourra être vérifiée qu'avec ses mesures.
