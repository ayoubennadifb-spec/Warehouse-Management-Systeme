# Exigences confirmées, hypothèses retenues, points à décider

Toutes les valeurs ci-dessous sont modifiables sans toucher au code :
`config/maquette.defaut.json` (plan initial), onglet **Paramètres** (nouvelle version de plan), `config/simulation.json`.

## Exigences confirmées (données du cahier des charges)

| Élément | Valeur |
|---|---|
| Espace total | 1 000 × 500 mm (X × Y) |
| Zone de stockage | 800 × 500 mm |
| Zone de transport | 200 × 500 mm ; les deux zones forment ensemble l'espace total |
| Conteneur | 100 × 50 × 50 mm, longueur parallèle à X |
| Grille | 7 × 7 positions, 3 niveaux → 49 positions au sol, 147 emplacements (calculés, non codés en dur) |
| Configuration initiale | 60 conteneurs au maximum (paramétrable) |
| Camion | cabine « demi-conteneur » + plateau portant un conteneur |
| Base | PostgreSQL local |

## Hypothèses retenues (à confirmer par l'équipe)

| # | Hypothèse | Valeur proposée | Où la modifier |
|---|---|---|---|
| H1 | Position de la zone transport | extrémité **X max** (X 800 → 1 000) | `zones.transport_cote` |
| H2 | Répartition de la grille | marges = espacements, uniformes : **12,5 mm** suivant X, **18,75 mm** suivant Y | `grille.marge_*`, `grille.espacement_*` (vide = auto) |
| H3 | Périmètre de la limite de 60 | **toute la maquette** : stockage + camions + transferts + positions incertaines | `capacite.perimetre` (`ZONE`/`STOCKAGE`) |
| H4 | « Demi-conteneur » de la cabine | cabine **50 × 50 mm**, plateau 100 × 50 mm, ensemble 150 mm aligné suivant X | `camion.*` |
| H5 | Hauteurs du camion | cabine 50 mm, plateau 20 mm — **illustratives**, servent seulement au rendu et au z du conteneur posé | `camion.*_hauteur_mm` |
| H6 | Postes camion | **4 postes** répartis suivant Y (pas de 125 mm, 75 mm entre camions), camions centrés suivant X (25 mm de marge de chaque côté), **cabine côté X max** (plateau côté stockage) ; disposition non validée | `postes.*` (ou positions manuelles) |
| H7 | Unité de manutention | une seule, abstraite, une mission à la fois | évolution : colonne `unite_manutention_id` déjà présente |
| H8 | Repère | origine au coin (X min, Y min) ; (x, y) = centre ; z = base du conteneur | — |
| H9 | Trajet simulé | montée à `niveaux × hauteur + 30 mm`, translation rectiligne, descente ; vitesses 150 mm/s (XY) et 80 mm/s (Z) — **valeurs de simulation, non mesurées** | `config/simulation.json` |
| H10 | Réservation de la source | la source reste réservée jusqu'au dépôt (rien ne peut y être posé pendant le transfert) | code métier |
| H11 | Accès à une destination | une destination de niveau > 1 exige un support présent **et** non engagé dans une mission | code métier |
| H12 | Changement de plan | refusé si missions actives, réservations actives ou camions présents ; conteneurs conservés seulement si le lieu physique est identique | code métier |
| H13 | Incertitude | après une interruption avec prise confirmée, la file d'exécution est bloquée jusqu'à la reprise ou à la déclaration de position | code métier |
| H14 | Redémarrage du serveur | une mission `EN_COURS` est marquée `INTERROMPUE` (l'état réel n'est plus garanti) ; une mission `SUSPENDUE` reste suspendue | `sources/simulation.ts` |

## Points restant à décider

1. **Mécanisme** du portique (levage, guidage, préhension) : il déterminera la hauteur de passage réelle, les vitesses,
   les accélérations, et peut-être des zones inaccessibles (à représenter via le statut des positions).
2. Marges et espacements **réels** de la grille ; éventuellement des positions mesurées case par case
   (le modèle les stocke déjà individuellement).
3. Nombre, disposition et orientation **réels** des postes camion ; dimensions exactes du camion (hauteurs).
4. Sens exact de la **limite de 60** (H3).
5. Le **mapping réel** des conteneurs (remplacera le jeu `DEMO-…`) et la règle de nommage des codes.
6. Comportement voulu quand un conteneur doit être extrait du bas d'une pile : aujourd'hui l'opérateur
   peut calculer un dégagement automatique des conteneurs supérieurs ; les nouvelles positions sont enregistrées après chaque dépôt.
7. **Vision** : nombre et position des caméras, modèle IA, fréquence, seuil de confiance, format des observations.
8. **Optimisation** : critère (temps, distance, énergie, nombre de manipulations), algorithme, prise en compte des obstacles.
9. **Reprise** après détection humaine : qui autorise la reprise, et comment (acquittement opérateur obligatoire proposé).
10. Gestion des **utilisateurs** (authentification) si l'interface est un jour ouverte au réseau.

Depuis la fusion : A*, dégagement automatique et coût en temps avec approches à vide intégrés. Vitesses, accélérations et plafond restent des hypothèses de simulation ; voir docs/fusion.md dans l’archive ou ../docs/VERSION_PRINCIPALE.md dans le dossier parent.
