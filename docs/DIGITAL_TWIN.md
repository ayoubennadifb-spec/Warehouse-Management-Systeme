# Passage au jumeau numérique

## Architecture livrée

Le navigateur dessine un snapshot indépendant de son origine. Le même format est utilisé par le moteur JavaScript de démonstration et l'API Python. Le mode local complet exécute les règles dans le serveur, persiste les changements dans PostgreSQL puis retourne le snapshot. Le navigateur lit actuellement l'état toutes les 500 ms. Une route SSE est également disponible pour une future bascule vers une diffusion événementielle.

Le rendu ne commande aucun moteur. Les trajectoires suivent montée / translation à hauteur constante / descente. Un calcul A* compare les hauteurs et les chemins orthogonaux en tenant compte des piles, cabines et de l’encombrement du conteneur. Le calcul minimise la distance dans cette famille de trajets. Les courses et marges restent des hypothèses de simulation ; voir `TRAJECTORIES.md`.

## API fournie

| Route | Fonction |
|---|---|
| GET /api/health | État PostgreSQL et mode simulation/réel |
| GET /api/state | Configuration, conteneurs, camions, mission active, historique |
| GET /api/events | SSE `snapshot` contenant l'état complet ; heartbeat si inchangé |
| POST /api/action | Actions de simulation : arrive, depart, move, pause, reset, speed |
| GET /api/hardware/status | État du contrat matériel, verrouillé sans adaptateur physique |
| POST /api/hardware/self-test | Essais isolés de défauts simulés, sans modification d’inventaire |

Exemples de corps JSON :

```json
{"action":"arrive","loaded":true}
```

```json
{"action":"move","id":"C025","destination":"slot:G7"}
```

```json
{"action":"move","id":"C025","destination":"truck:T01"}
```

`slot:G7` choisit le prochain niveau utilisable ; le client n'impose pas un niveau non supporté. Une seule mission est autorisée simultanément. L'application complète sert interface et API à la même origine, évitant les problèmes CORS et HTTPS vers localhost.

## Contrat de snapshot

- `version` : version de format, actuellement 1.
- `config` : dimensions en mm et quantités.
- `containers` : id, state, slot, level, truck. Les références inutilisées sont nulles.
- `trucks` : id et indice de poste `bay`.
- `mission` : id, container, source, target, kind, start/end XYZ, progress entre 0 et 1, paused.
- Les nouvelles missions contiennent aussi `waypoints`, `routeLengthMm`, `cruiseHeightMm`, `clearanceMm`, `horizontalClearanceMm`, `maxHeightMm` et l’identifiant de planificateur.
- `events` : id unique, date ISO 8601, message et type.
- `completed` : missions terminées dans la configuration.

Pour le modèle de terrain, compléter le contrat avec les positions mesurées du portique, l'horodatage de mesure, la qualité de localisation et la version de calibration. Ne pas assimiler `progress` de l'animation à une position mesurée.

## Intégration physique à réaliser

1. Définir l'identification des conteneurs et le repère de la maquette.
2. Choisir le contrôleur, le protocole et les confirmations fiables de prise/dépôt.
3. Écrire un adaptateur qui valide les événements physiques et utilise les mêmes transactions de localisation.
4. Ajouter une clé d'idempotence par événement matériel et contrôler l'ordre / l'ancienneté ; la clé unique des événements constitue le support de déduplication mais l'ingestion matérielle n'est pas implémentée.
5. Ajouter la télémétrie mesurée et les observations des caméras après calibration pixels → mm.
6. Définir la réaction aux obstacles. La présence humaine appelle un arrêt et une alerte ; la reprise est une décision distincte de l'existence d'un détour.
7. Adapter le planificateur de simulation aux courses, à la dynamique et à l’encombrement mécanique mesurés ; intégrer les observations de caméra et le recalcul.

Le mode `APP_MODE=real` est un mode de **lecture et préparation d'intégration**. Il ne simule plus de confirmations et refuse les actions de démonstration. Il démarre vide sur une nouvelle base. Le démarrage refuse une base dont la configuration active est dans un autre mode : changer le mode ne transforme pas les données simulées en mesures. Le contrat matériel et les essais de défauts sont décrits dans `HARDWARE.md` ; aucune liaison Arduino ni vision n’est encore connectée.

## Limites explicites

Aucun modèle de vision entraîné, aucun capteur connecté, aucun contrôle moteur, aucune optimisation garantie, aucune certification de sécurité. L'interface nécessite un adaptateur avant d'être un jumeau connecté au matériel. Les proportions du camion sont provisoires. Les marges sont calculées automatiquement, leur saisie indépendante reste une évolution possible.
