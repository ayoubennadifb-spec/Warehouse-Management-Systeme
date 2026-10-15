/**
 * Géométrie paramétrable de la maquette — fonctions PURES (aucun accès base, aucun DOM).
 * Utilisée par le serveur (génération des versions de plan) et par les tests.
 *
 * Repère (documenté dans docs/architecture.md) :
 *  - origine O = coin de l'espace de travail (X min, Y min), sur le plan de pose ;
 *  - X suivant la longueur (1000 mm), Y suivant la largeur (500 mm), Z vertical vers le haut ;
 *  - unité : millimètre ;
 *  - (x, y) d'une position / d'un emplacement = CENTRE de l'empreinte au sol ;
 *  - z d'un emplacement = BASE (face inférieure) du conteneur posé à ce niveau.
 */

export type Cote = 'X_MIN' | 'X_MAX';

export interface ParametresMaquette {
  libelle: string;
  espace: { longueur_x_mm: number; largeur_y_mm: number };
  zones: { transport_longueur_x_mm: number; transport_cote: Cote };
  conteneur: { longueur_mm: number; largeur_mm: number; hauteur_mm: number };
  grille: {
    nb_positions_x: number;
    nb_positions_y: number;
    nb_niveaux_max: number;
    /** null = réparti automatiquement (marges et espacements égaux) */
    marge_x_mm: number | null;
    espacement_x_mm: number | null;
    marge_y_mm: number | null;
    espacement_y_mm: number | null;
  };
  capacite: { nb_conteneurs_max: number; perimetre: 'ZONE' | 'STOCKAGE' };
  camion: {
    cabine_longueur_mm: number;
    cabine_largeur_mm: number;
    cabine_hauteur_mm: number;
    plateau_longueur_mm: number;
    plateau_largeur_mm: number;
    plateau_hauteur_mm: number;
  };
  postes: {
    nb_postes: number;
    cote_cabine: Cote;
    /** null = disposition automatique (répartis suivant Y, centrés suivant X) */
    positions: { code: string; centre_x_mm: number; centre_y_mm: number }[] | null;
  };
}

export interface ZoneCalculee {
  code: 'STOCKAGE' | 'TRANSPORT';
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
}

export interface PositionCalculee {
  ix: number;
  iy: number;
  code: string;
  centre_x: number;
  centre_y: number;
}

export interface PosteCalcule {
  code: string;
  centre_x: number;
  centre_y: number;
  /** empreinte réservée au poste */
  longueur_x: number;
  largeur_y: number;
  cote_cabine: Cote;
  /** centre du plateau ; z = base d'un conteneur posé sur le plateau */
  plateau: { x: number; y: number; z: number };
  cabine: { x: number; y: number };
}

export interface RepartitionAxe {
  marge_debut: number;
  espacement: number;
  marge_fin: number;
  pas: number;
  auto: boolean;
}

export interface PlanCalcule {
  ok: boolean;
  erreurs: string[];
  avertissements: string[];
  zones: ZoneCalculee[];
  repartition_x: RepartitionAxe | null;
  repartition_y: RepartitionAxe | null;
  positions: PositionCalculee[];
  niveaux: { niveau: number; z_base: number }[];
  postes: PosteCalcule[];
  camion: { longueur_totale: number; largeur: number };
  nb_positions_sol: number;
  nb_emplacements: number;
  hauteur_pile_max: number;
}

const EPS = 1e-6;
export const arrondi = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;

/** A, B, …, Z, AA, AB… (index à partir de 1) */
export function lettreColonne(i: number): string {
  let s = '';
  let n = i;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export const codePosition = (ix: number, iy: number): string => `${lettreColonne(ix)}${iy}`;
export const codeEmplacement = (ix: number, iy: number, niveau: number): string => `${codePosition(ix, iy)}-N${niveau}`;

/**
 * Répartit n objets de taille `taille` sur une longueur `L`.
 * marge et espacement : valeur imposée ou null (calculée).
 */
export function repartir(
  L: number,
  n: number,
  taille: number,
  marge: number | null,
  espacement: number | null,
  axe: string,
): { r: RepartitionAxe | null; erreur?: string; avertissement?: string } {
  const occupe = n * taille;
  let m: number;
  let e: number;
  let auto = false;
  if (marge === null && espacement === null) {
    m = e = (L - occupe) / (n + 1);
    auto = true;
  } else if (marge !== null && espacement === null) {
    m = marge;
    e = n > 1 ? (L - occupe - 2 * m) / (n - 1) : 0;
  } else if (marge === null && espacement !== null) {
    e = espacement;
    m = (L - occupe - (n - 1) * e) / 2;
  } else {
    m = marge as number;
    e = espacement as number;
  }
  const fin = L - m - occupe - (n - 1) * e;
  if (m < -EPS || e < -EPS || fin < -EPS) {
    const requis = occupe + 2 * (marge ?? 0) + (n - 1) * (espacement ?? 0);
    const manque = arrondi(Math.max(requis - L, 0), 2);
    return {
      r: null,
      erreur: `La grille ne tient pas suivant ${axe} : ${n} × ${taille} mm + marges/espacements dépassent ${L} mm (dépassement ≈ ${manque} mm).`,
    };
  }
  const r: RepartitionAxe = {
    marge_debut: arrondi(m),
    espacement: arrondi(e),
    marge_fin: arrondi(fin),
    pas: arrondi(taille + e),
    auto,
  };
  let avertissement: string | undefined;
  if (n > 1 && e < EPS) avertissement = `Espacement nul suivant ${axe} : les conteneurs se touchent.`;
  else if (Math.abs(fin - m) > 0.01 && !auto)
    avertissement = `Suivant ${axe}, marge de début ${r.marge_debut} mm et marge de fin ${r.marge_fin} mm différentes.`;
  return { r, avertissement };
}

export function zonesDe(p: ParametresMaquette): ZoneCalculee[] {
  const L = p.espace.longueur_x_mm;
  const W = p.espace.largeur_y_mm;
  const T = p.zones.transport_longueur_x_mm;
  const S = L - T;
  if (p.zones.transport_cote === 'X_MAX') {
    return [
      { code: 'STOCKAGE', x_min: 0, x_max: S, y_min: 0, y_max: W },
      { code: 'TRANSPORT', x_min: S, x_max: L, y_min: 0, y_max: W },
    ];
  }
  return [
    { code: 'TRANSPORT', x_min: 0, x_max: T, y_min: 0, y_max: W },
    { code: 'STOCKAGE', x_min: T, x_max: L, y_min: 0, y_max: W },
  ];
}

/** Position du plateau et de la cabine d'un camion stationné (ensemble aligné suivant X). */
export function geometrieCamion(
  centre_x: number,
  centre_y: number,
  cote_cabine: Cote,
  c: ParametresMaquette['camion'],
): { plateau: { x: number; y: number; z: number }; cabine: { x: number; y: number }; longueur: number } {
  const Lt = c.cabine_longueur_mm + c.plateau_longueur_mm;
  const debut = centre_x - Lt / 2;
  const fin = centre_x + Lt / 2;
  const plateauX = cote_cabine === 'X_MAX' ? debut + c.plateau_longueur_mm / 2 : fin - c.plateau_longueur_mm / 2;
  const cabineX = cote_cabine === 'X_MAX' ? fin - c.cabine_longueur_mm / 2 : debut + c.cabine_longueur_mm / 2;
  return {
    plateau: { x: arrondi(plateauX), y: arrondi(centre_y), z: c.plateau_hauteur_mm },
    cabine: { x: arrondi(cabineX), y: arrondi(centre_y) },
    longueur: Lt,
  };
}

function positif(v: number, nom: string, erreurs: string[], entier = false): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) erreurs.push(`${nom} doit être un nombre strictement positif (reçu : ${v}).`);
  else if (entier && !Number.isInteger(v)) erreurs.push(`${nom} doit être un entier (reçu : ${v}).`);
}

/** Calcule et vérifie toute la géométrie dérivée des paramètres. */
export function calculerPlan(p: ParametresMaquette): PlanCalcule {
  const erreurs: string[] = [];
  const avertissements: string[] = [];
  const vide: PlanCalcule = {
    ok: false,
    erreurs,
    avertissements,
    zones: [],
    repartition_x: null,
    repartition_y: null,
    positions: [],
    niveaux: [],
    postes: [],
    camion: { longueur_totale: 0, largeur: 0 },
    nb_positions_sol: 0,
    nb_emplacements: 0,
    hauteur_pile_max: 0,
  };

  positif(p.espace.longueur_x_mm, 'Longueur de l’espace (X)', erreurs);
  positif(p.espace.largeur_y_mm, 'Largeur de l’espace (Y)', erreurs);
  positif(p.zones.transport_longueur_x_mm, 'Longueur de la zone transport', erreurs);
  positif(p.conteneur.longueur_mm, 'Longueur conteneur', erreurs);
  positif(p.conteneur.largeur_mm, 'Largeur conteneur', erreurs);
  positif(p.conteneur.hauteur_mm, 'Hauteur conteneur', erreurs);
  positif(p.grille.nb_positions_x, 'Nombre de positions suivant X', erreurs, true);
  positif(p.grille.nb_positions_y, 'Nombre de positions suivant Y', erreurs, true);
  positif(p.grille.nb_niveaux_max, 'Nombre de niveaux', erreurs, true);
  for (const [k, v] of Object.entries(p.camion)) positif(v, `Camion : ${k}`, erreurs);
  if (!Number.isInteger(p.capacite.nb_conteneurs_max) || p.capacite.nb_conteneurs_max < 0)
    erreurs.push('Le nombre maximal de conteneurs doit être un entier positif ou nul.');
  if (!Number.isInteger(p.postes.nb_postes) || p.postes.nb_postes < 0)
    erreurs.push('Le nombre de postes doit être un entier positif ou nul.');
  for (const k of ['marge_x_mm', 'espacement_x_mm', 'marge_y_mm', 'espacement_y_mm'] as const) {
    const v = p.grille[k];
    if (v !== null && (!Number.isFinite(v) || v < 0)) erreurs.push(`${k} doit être ≥ 0 ou laissé vide (automatique).`);
  }
  if (erreurs.length) return vide;

  if (p.zones.transport_longueur_x_mm >= p.espace.longueur_x_mm)
    erreurs.push('La zone transport doit être plus courte que l’espace total suivant X.');
  if (erreurs.length) return vide;

  const zones = zonesDe(p);
  const stock = zones.find((z) => z.code === 'STOCKAGE')!;
  const transp = zones.find((z) => z.code === 'TRANSPORT')!;
  const Ls = stock.x_max - stock.x_min;
  const W = p.espace.largeur_y_mm;

  // Grille de stockage — longueur du conteneur parallèle à X.
  const rx = repartir(Ls, p.grille.nb_positions_x, p.conteneur.longueur_mm, p.grille.marge_x_mm, p.grille.espacement_x_mm, 'X');
  const ry = repartir(W, p.grille.nb_positions_y, p.conteneur.largeur_mm, p.grille.marge_y_mm, p.grille.espacement_y_mm, 'Y');
  for (const r of [rx, ry]) {
    if (r.erreur) erreurs.push(r.erreur);
    if (r.avertissement) avertissements.push(r.avertissement);
  }

  const positions: PositionCalculee[] = [];
  if (rx.r && ry.r) {
    for (let ix = 1; ix <= p.grille.nb_positions_x; ix++) {
      for (let iy = 1; iy <= p.grille.nb_positions_y; iy++) {
        positions.push({
          ix,
          iy,
          code: codePosition(ix, iy),
          centre_x: arrondi(stock.x_min + rx.r.marge_debut + p.conteneur.longueur_mm / 2 + (ix - 1) * rx.r.pas),
          centre_y: arrondi(stock.y_min + ry.r.marge_debut + p.conteneur.largeur_mm / 2 + (iy - 1) * ry.r.pas),
        });
      }
    }
  }
  const niveaux = Array.from({ length: p.grille.nb_niveaux_max }, (_, i) => ({
    niveau: i + 1,
    z_base: arrondi(i * p.conteneur.hauteur_mm),
  }));

  // Camion : cabine + plateau alignés suivant X.
  const c = p.camion;
  const Lt = c.cabine_longueur_mm + c.plateau_longueur_mm;
  const Wt = Math.max(c.cabine_largeur_mm, c.plateau_largeur_mm);
  if (c.plateau_longueur_mm + EPS < p.conteneur.longueur_mm || c.plateau_largeur_mm + EPS < p.conteneur.largeur_mm)
    erreurs.push(
      `Le plateau (${c.plateau_longueur_mm} × ${c.plateau_largeur_mm} mm) ne peut pas porter un conteneur de ${p.conteneur.longueur_mm} × ${p.conteneur.largeur_mm} mm.`,
    );
  const Lz = transp.x_max - transp.x_min;
  if (Lt > Lz + EPS) erreurs.push(`Un camion de ${Lt} mm ne tient pas dans la zone transport (${Lz} mm suivant X).`);

  const postes: PosteCalcule[] = [];
  const n = p.postes.nb_postes;
  if (p.postes.positions && p.postes.positions.length) {
    if (p.postes.positions.length !== n)
      erreurs.push(`${p.postes.positions.length} positions de postes données pour ${n} postes annoncés.`);
    const codes = new Set<string>();
    for (const pp of p.postes.positions) {
      if (codes.has(pp.code)) erreurs.push(`Code de poste en double : ${pp.code}.`);
      codes.add(pp.code);
      const g = geometrieCamion(pp.centre_x_mm, pp.centre_y_mm, p.postes.cote_cabine, c);
      postes.push({
        code: pp.code,
        centre_x: pp.centre_x_mm,
        centre_y: pp.centre_y_mm,
        longueur_x: Lt,
        largeur_y: Wt,
        cote_cabine: p.postes.cote_cabine,
        plateau: g.plateau,
        cabine: g.cabine,
      });
    }
  } else if (n > 0) {
    const pasY = W / n;
    if (Wt > pasY + EPS) erreurs.push(`${n} camions de ${Wt} mm de large ne tiennent pas sur ${W} mm suivant Y (pas de ${arrondi(pasY, 2)} mm).`);
    const cx = (transp.x_min + transp.x_max) / 2;
    for (let i = 1; i <= n; i++) {
      const cy = transp.y_min + pasY * (i - 0.5);
      const g = geometrieCamion(cx, cy, p.postes.cote_cabine, c);
      postes.push({
        code: `P${i}`,
        centre_x: arrondi(cx),
        centre_y: arrondi(cy),
        longueur_x: arrondi(Lz),
        largeur_y: arrondi(pasY),
        cote_cabine: p.postes.cote_cabine,
        plateau: g.plateau,
        cabine: g.cabine,
      });
    }
    if (n > 1 && pasY - Wt < 20 && Wt <= pasY + EPS)
      avertissements.push(`Faible écart entre camions voisins : ${arrondi(pasY - Wt, 2)} mm.`);
  }
  // Chaque camion stationné doit tenir dans la zone transport, sans chevauchement.
  const emprises = postes.map((ps) => ({
    code: ps.code,
    x0: ps.centre_x - Lt / 2,
    x1: ps.centre_x + Lt / 2,
    y0: ps.centre_y - Wt / 2,
    y1: ps.centre_y + Wt / 2,
  }));
  for (const e of emprises) {
    if (e.x0 < transp.x_min - EPS || e.x1 > transp.x_max + EPS || e.y0 < transp.y_min - EPS || e.y1 > transp.y_max + EPS)
      erreurs.push(`Le camion du poste ${e.code} sort de la zone transport.`);
  }
  for (let i = 0; i < emprises.length; i++)
    for (let j = i + 1; j < emprises.length; j++) {
      const a = emprises[i];
      const b = emprises[j];
      if (a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS)
        erreurs.push(`Les camions des postes ${a.code} et ${b.code} se chevauchent.`);
    }

  const nbEmplacements = positions.length * p.grille.nb_niveaux_max;
  const capaciteMax = p.capacite.perimetre === 'ZONE' ? nbEmplacements + postes.length : nbEmplacements;
  if (p.capacite.nb_conteneurs_max > capaciteMax)
    avertissements.push(
      `Capacité configurée (${p.capacite.nb_conteneurs_max}) supérieure au nombre de places physiques (${capaciteMax}) : elle ne sera jamais atteinte.`,
    );

  return {
    ok: erreurs.length === 0,
    erreurs,
    avertissements,
    zones,
    repartition_x: rx.r,
    repartition_y: ry.r,
    positions,
    niveaux,
    postes,
    camion: { longueur_totale: Lt, largeur: Wt },
    nb_positions_sol: positions.length,
    nb_emplacements: nbEmplacements,
    hauteur_pile_max: arrondi(p.grille.nb_niveaux_max * p.conteneur.hauteur_mm),
  };
}
