# Laboratoire anti-ballant — 15 octobre 2026

Ouvrir l’application, puis l’onglet **Anti-ballant**, ou directement
http://127.0.0.1:8080/#anti-ballant.

## Ce que permet le module

- Choisir un déplacement X/Y rectiligne et coordonné, la vitesse et l’accélération maximales par axe.
- Régler une longueur effective de suspension entre 50 et 2 000 mm.
- Comparer la commande trapézoïdale/triangulaire et sa version corrigée par un filtre ZVD.
- Rejouer les mouvements à vitesse réglable et sélectionner un instant.
- Visualiser les angles X/Y et les accélérations des chariots.
- Comparer le temps de commande, le pic angulaire et le résiduel après l’arrêt.
- Tester une erreur de longueur entre −30 % et +30 %, un amortissement et un angle initial.
- Exporter les paramètres, les résultats et les échantillons en JSON ou CSV ; mémoriser les réglages dans le navigateur.

Les deux vues X/Y représentent un mode pendulaire équivalent. Elles ne décrivent pas le nombre de câbles physiques. La longueur doit représenter la dynamique du préhenseur et du conteneur suspendus, à confirmer par identification expérimentale. La masse est conservée dans l’étude, mais ne modifie pas la réponse du modèle à accélération imposée.

## Modèle et commande

Toutes les grandeurs sont calculées en unités SI ; les champs de l’interface utilisent les mm et mm/s.
Le profil coordonné prend comme distance de référence `max(|ΔX|, |ΔY|)` et multiplie sa position, sa vitesse et son accélération par les rapports de déplacement de chaque axe. Les deux axes atteignent ainsi leur destination au même instant, sans dépasser les limites choisies par axe. Ce scénario d’étude est distinct des trajets rectilignes successifs du planificateur de missions.

Pour chaque plan, à longueur constante :

```text
θ̈ + 2 ζ ωn θ̇ + (g/L) sin(θ) = −(achariot/L) cos(θ)
ωn = √(g/L), g = 9,81 m/s²
```

Deux équations planes approchent le balancement X/Y aux petits angles. La position horizontale simulée de la charge est `xcharge = xchariot + L sin(θx)`, et de même suivant Y. Au-delà de 10°, l’interface affiche un avertissement sur la validité de l’approximation découplée.

Le filtre ZVD est conçu pour le modèle linéarisé :

```text
ωd = ωn √(1 − ζ²)
K = exp(−ζπ / √(1 − ζ²))
temps = [0, π/ωd, 2π/ωd]
poids = [1, 2K, K²] / (1 + K)²
acorrigée(t) = Σ Ai ainitiale(t − ti)
```

Le même filtre s’applique aux positions et vitesses de référence, ce qui conserve leur cohérence cinématique et la destination. Sans amortissement, les poids valent 0,25 / 0,50 / 0,25. La commande corrigée finit une période amortie plus tard.

La simulation utilise RK4, avec un pas maximal de 5 ms et une subdivision exacte aux changements d’accélération. La longueur physique simulée peut différer de la longueur estimée du filtre. Chaque résiduel est le maximum observé pendant **deux périodes physiques après la fin de sa propre commande**, pour comparer les mêmes fenêtres après arrêt.

L’angle global est `√(θx² + θy²)` ; le déport horizontal est `L √(sin²θx + sin²θy)`. Les déports sont mesurés relativement au point de suspension. L’erreur de position finale exportée est une mesure à la fin de la durée totale de l’étude, distincte du maximum résiduel.

Référence scientifique : [input shaping appliqué aux grues, Sensors 2018](https://www.mdpi.com/1424-8220/18/6/1817).

## Lire les résultats

Le cas d’exemple utilise L = 500 mm, ΔX = 500 mm, ΔY = 200 mm, v = 150 mm/s, a = 250 mm/s² et ζ = 0,015. Les paramètres de commande sont illustratifs et indépendants du profil actuel des missions.

Dans ce cas nominal idéal, le résiduel peut être presque nul. Ce résultat montre l’accord entre le modèle et le filtre ; ce n’est pas une précision garantie de la maquette. Modifier l’erreur de longueur ou l’angle initial permet d’observer certaines limites. Le filtre préventif n’est pas une boucle de retour mesurant la charge et ne garantit pas l’annulation d’une oscillation initiale ou d’une perturbation extérieure.

## Limites et intégration future

Le module ne représente pas la géométrie individuelle des câbles, les rotations et inerties du préhenseur, les doubles pendules, l’élasticité, les frottements et la dynamique des moteurs, ni un levage simultané. La validité du mode équivalent dépend de la suspension réellement fabriquée.

Il n’écrit pas dans PostgreSQL et n’envoie pas de commandes à Arduino. Les trajectoires et les temps des missions existantes ne sont pas remplacés par ces références. Pour appliquer la correction au portique :

1. Mesurer les périodes et l’amortissement de la suspension réelle, à plusieurs longueurs et charges.
2. Comparer vidéo/mesures à la simulation sur un axe, puis sur X/Y.
3. Ajouter la longueur de câble et la synchronisation à la génération des consignes matérielles.
4. Vérifier les limites de moteurs et la trajectoire corrigée, notamment aux changements de direction, en incluant l’enveloppe de balancement.
5. Réviser les temps du planificateur et conditionner le dépôt à des critères mesurés.

## Vérification

Depuis `projet_portique_ contenaire_claude` :

```powershell
npm.cmd run test:antisway
npm.cmd run typecheck
npm.cmd run build
# Application déjà lancée :
npm.cmd run test:ui:antisway
```

Les tests numériques comparent le pendule libre à sa solution analytique aux très petits angles, vérifient les propriétés modales du ZVD, les limites et destinations des profils, l’absence de mouvement, les erreurs de longueur et la convergence numérique. Le test navigateur vérifie la navigation, l’animation, les champs, la persistance, les exports et l’affichage mobile, et refuse toute requête d’écriture à l’API. Ses captures et exports sont dans `.local/antisway-verification`.
