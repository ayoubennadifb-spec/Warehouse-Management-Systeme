/**
 * Vue 3D isométrique (Three.js), 1 unité = 1 mm, axe Z vers le haut (même repère que la base).
 * Caméra orthographique : pas de déformation de perspective, proportions conservées.
 * L'unité de manutention est un indicateur ABSTRAIT (boîte filaire) : aucun mécanisme n'est représenté.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { store } from './store.ts';
import type { ActionsVue } from './vue-dessus.ts';
import type { Conteneur, Etat } from './types.ts';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const COULEURS = {
  conteneur: 0x3d6fa6,
  surCamion: 0x4f86c6,
  transfert: 0xe0882a,
  incertain: 0xd64545,
  selection: 0xf2c230,
  cible: 0x2ea86a,
  reserve: 0xe0882a,
  unite: 0x7c4dde,
  cabine: 0x33495c,
  plateau: 0xa3adb8,
  socle: 0xc9cfd6,
};

interface InfoObjet {
  kind: 'cont' | 'emp' | 'visite';
  id: number;
  titre: string;
}

function texteTexture(texte: string, opts: { l?: number; h?: number; fond?: string; couleur?: string; police?: number } = {}): THREE.CanvasTexture {
  const l = opts.l ?? 256;
  const h = opts.h ?? 128;
  const c = document.createElement('canvas');
  c.width = l;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = opts.fond ?? '#ffffff';
  g.fillRect(0, 0, l, h);
  g.fillStyle = opts.couleur ?? '#0f1b2a';
  g.font = `600 ${opts.police ?? 46}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(texte, l / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function etiquette(texte: string, taille = 26): THREE.Sprite {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = '600 40px "Segoe UI", system-ui, sans-serif';
  const w = Math.ceil(g.measureText(texte).width) + 24;
  c.width = w;
  c.height = 56;
  const g2 = c.getContext('2d')!;
  g2.fillStyle = 'rgba(15,27,42,0.82)';
  g2.beginPath();
  g2.roundRect(0, 0, w, 56, 12);
  g2.fill();
  g2.fillStyle = '#ffffff';
  g2.font = '600 40px "Segoe UI", system-ui, sans-serif';
  g2.textBaseline = 'middle';
  g2.fillText(texte, 12, 30);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set((taille * w) / 56, taille, 1);
  s.renderOrder = 10;
  return s;
}

export class Scene3D {
  private hote: HTMLElement;
  private actions: ActionsVue;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private statique = new THREE.Group();
  private conteneurs = new THREE.Group();
  private camions = new THREE.Group();
  private cibles = new THREE.Group();
  private divers = new THREE.Group();
  private unite = new THREE.Group();
  private uniteCible = new THREE.Vector3();
  private uniteActuelle = new THREE.Vector3();
  private uniteInit = false;
  private porte: THREE.Mesh | null = null;
  private planId: number | null = null;
  private texturesCodes = new Map<string, THREE.CanvasTexture>();
  private geoCache = new Map<string, THREE.BoxGeometry>();
  private infobulle: HTMLElement;
  private demiHauteur = 380;
  private centre = new THREE.Vector3(500, 250, 0);
  private hauteurConteneur = 50;
  private actif = true;

  constructor(hote: HTMLElement, actions: ActionsVue) {
    this.hote = hote;
    this.actions = actions;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', 'Vue 3D isométrique de l’espace de travail');
    hote.append(this.renderer.domElement);
    this.infobulle = document.createElement('div');
    this.infobulle.className = 'infobulle';
    this.infobulle.hidden = true;
    hote.append(this.infobulle);

    this.camera = new THREE.OrthographicCamera(-500, 500, 300, -300, -5000, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minZoom = 0.5;
    this.controls.maxZoom = 8;
    this.scene.add(this.statique, this.conteneurs, this.camions, this.cibles, this.divers, this.unite);
    const fond = getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim() || '#f6f8fb';
    this.scene.background = new THREE.Color(fond);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const soleil = new THREE.DirectionalLight(0xffffff, 1.8);
    soleil.position.set(-200, -400, 1000);
    soleil.target.position.set(500, 250, 0);
    soleil.castShadow = true;
    soleil.shadow.mapSize.set(2048, 2048);
    Object.assign(soleil.shadow.camera, { left: -700, right: 700, top: 500, bottom: -500, near: 10, far: 3000 });
    this.scene.add(soleil, soleil.target);

    new ResizeObserver(() => this.redimensionner()).observe(hote);
    this.brancherPointeur();
    this.vue('iso');
    const boucle = () => {
      requestAnimationFrame(boucle);
      if (!this.actif || this.hote.offsetParent === null) return;
      this.controls.update();
      this.animerUnite();
      this.renderer.render(this.scene, this.camera);
    };
    boucle();
    document.addEventListener('visibilitychange', () => (this.actif = !document.hidden));
  }

  private redimensionner(): void {
    const l = this.hote.clientWidth;
    const h = this.hote.clientHeight;
    if (!l || !h) return;
    this.renderer.setSize(l, h, false);
    const a = l / h;
    const dh = Math.max(this.demiHauteur, 560 / a);
    this.camera.left = -dh * a;
    this.camera.right = dh * a;
    this.camera.top = dh;
    this.camera.bottom = -dh;
    this.camera.updateProjectionMatrix();
  }

  vue(nom: 'iso' | 'dessus' | 'face' | 'cote'): void {
    const c = this.centre;
    const d = 1400;
    const positions = {
      iso: new THREE.Vector3(c.x - 0.55 * d, c.y - 0.85 * d, c.z + 0.75 * d),
      dessus: new THREE.Vector3(c.x, c.y - 0.001, c.z + d),
      face: new THREE.Vector3(c.x, c.y - d, c.z + 120),
      cote: new THREE.Vector3(c.x + d, c.y, c.z + 120),
    };
    this.camera.position.copy(positions[nom]);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
  }

  // ------------------------------------------------------------------ pointeur
  private objetsCliquables(): THREE.Object3D[] {
    return [...this.cibles.children, ...this.conteneurs.children, ...this.camions.children, ...(this.porte ? [this.porte] : [])];
  }

  private intersection(ev: PointerEvent): InfoObjet | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hits = this.raycaster.intersectObjects(this.objetsCliquables(), true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.info) o = o.parent;
      if (o?.userData.info) return o.userData.info as InfoObjet;
    }
    return null;
  }

  private brancherPointeur(): void {
    const el = this.renderer.domElement;
    let depart: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (ev) => (depart = { x: ev.clientX, y: ev.clientY }));
    el.addEventListener('pointerup', (ev) => {
      if (!depart || Math.hypot(ev.clientX - depart.x, ev.clientY - depart.y) > 5) return;
      const info = this.intersection(ev);
      if (!info) return;
      if (info.kind === 'cont') this.actions.cliquerConteneur(info.id);
      else if (info.kind === 'emp') this.actions.cliquerEmplacement(info.id);
      else this.actions.cliquerVisite(info.id);
    });
    let dernier = 0;
    el.addEventListener('pointermove', (ev) => {
      if (ev.buttons || performance.now() - dernier < 60) return;
      dernier = performance.now();
      const info = this.intersection(ev);
      if (!info) {
        this.infobulle.hidden = true;
        el.style.cursor = '';
        return;
      }
      el.style.cursor = 'pointer';
      const r = this.hote.getBoundingClientRect();
      this.infobulle.textContent = info.titre;
      this.infobulle.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - 220)}px`;
      this.infobulle.style.top = `${ev.clientY - r.top + 14}px`;
      this.infobulle.hidden = false;
    });
    el.addEventListener('pointerleave', () => (this.infobulle.hidden = true));
  }

  // ------------------------------------------------------------------ construction
  private geo(L: number, l: number, h: number): THREE.BoxGeometry {
    const k = `${L}|${l}|${h}`;
    if (!this.geoCache.has(k)) this.geoCache.set(k, new THREE.BoxGeometry(L, l, h));
    return this.geoCache.get(k)!;
  }

  private construireStatique(e: Etat): void {
    const p = e.plan!;
    this.statique.clear();
    const L = p.parametres.espace.longueur_x_mm;
    const W = p.parametres.espace.largeur_y_mm;
    this.centre.set(L / 2, W / 2, 0);
    this.demiHauteur = Math.max(L, W * 1.6) * 0.36;
    this.hauteurConteneur = p.geometrie.type_conteneur.hauteur_mm;
    // Socle
    const socle = new THREE.Mesh(new THREE.BoxGeometry(L + 30, W + 30, 12), new THREE.MeshStandardMaterial({ color: COULEURS.socle, roughness: 0.9 }));
    socle.position.set(L / 2, W / 2, -6.5);
    socle.receiveShadow = true;
    this.statique.add(socle);
    // Sol dessiné (zones, cases, codes, postes)
    const k = 3;
    const c = document.createElement('canvas');
    c.width = L * k;
    c.height = W * k;
    const g = c.getContext('2d')!;
    const Y = (y: number) => (W - y) * k;
    for (const z of p.geometrie.zones) {
      g.fillStyle = z.code === 'STOCKAGE' ? '#e3ebf3' : '#f4ead9';
      g.fillRect(z.x_min_mm * k, Y(z.y_max_mm), (z.x_max_mm - z.x_min_mm) * k, (z.y_max_mm - z.y_min_mm) * k);
      g.strokeStyle = z.code === 'STOCKAGE' ? '#5b7da3' : '#b88a3a';
      g.lineWidth = 3;
      g.strokeRect(z.x_min_mm * k + 1.5, Y(z.y_max_mm) + 1.5, (z.x_max_mm - z.x_min_mm) * k - 3, (z.y_max_mm - z.y_min_mm) * k - 3);
    }
    const tc = p.geometrie.type_conteneur;
    g.font = `600 ${8 * k}px "Segoe UI", system-ui, sans-serif`;
    for (const pos of p.geometrie.positions) {
      const x = (pos.centre_x_mm - tc.longueur_mm / 2) * k;
      const y = Y(pos.centre_y_mm + tc.largeur_mm / 2);
      g.fillStyle = pos.statut === 'BLOQUEE' ? '#f3c7c7' : '#f8fbfe';
      g.fillRect(x, y, tc.longueur_mm * k, tc.largeur_mm * k);
      g.strokeStyle = pos.statut === 'BLOQUEE' ? '#c23b3b' : '#8aa4c0';
      g.lineWidth = 2;
      g.strokeRect(x, y, tc.longueur_mm * k, tc.largeur_mm * k);
      g.fillStyle = '#5b6f86';
      g.fillText(pos.code, x + 3 * k, y + 10 * k);
    }
    for (const ps of p.geometrie.postes) {
      g.setLineDash([6 * k, 4 * k]);
      g.strokeStyle = ps.statut === 'HORS_SERVICE' ? '#c23b3b' : '#9c7a3c';
      g.lineWidth = 2;
      g.strokeRect((ps.centre_x_mm - ps.longueur_x_mm / 2 + 3) * k, Y(ps.centre_y_mm + ps.largeur_y_mm / 2 - 3), (ps.longueur_x_mm - 6) * k, (ps.largeur_y_mm - 6) * k);
      g.setLineDash([]);
      g.fillStyle = '#7a5a22';
      g.fillText(ps.code, (ps.centre_x_mm - ps.longueur_x_mm / 2 + 8) * k, Y(ps.centre_y_mm + ps.largeur_y_mm / 2 - 14));
    }
    g.font = `700 ${11 * k}px "Segoe UI", system-ui, sans-serif`;
    g.fillStyle = 'rgba(40,60,85,0.55)';
    const st = p.geometrie.zones.find((z) => z.code === 'STOCKAGE')!;
    const tr = p.geometrie.zones.find((z) => z.code === 'TRANSPORT')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const sol = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    sol.position.set(L / 2, W / 2, 0.2);
    sol.receiveShadow = true;
    this.statique.add(sol);
    // Libellés des zones (au bord, hors de la zone)
    const e1 = etiquette(`STOCKAGE ${st.x_max_mm - st.x_min_mm} × ${st.y_max_mm - st.y_min_mm} mm`, 22);
    e1.position.set((st.x_min_mm + st.x_max_mm) / 2, -40, 2);
    const e2 = etiquette(`TRANSPORT ${tr.x_max_mm - tr.x_min_mm} × ${tr.y_max_mm - tr.y_min_mm} mm`, 22);
    e2.position.set((tr.x_min_mm + tr.x_max_mm) / 2, -40, 2);
    this.statique.add(e1, e2);
    // Repère (origine au coin X min, Y min)
    const fl = (dir: THREE.Vector3, couleur: number, lib: string) => {
      const a = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 1), 90, couleur, 18, 10);
      const s = etiquette(lib, 20);
      s.position.copy(dir.clone().multiplyScalar(112)).add(new THREE.Vector3(0, 0, 1));
      this.statique.add(a, s);
    };
    fl(new THREE.Vector3(1, 0, 0), 0xd64545, 'X');
    fl(new THREE.Vector3(0, 1, 0), 0x2ea86a, 'Y');
    fl(new THREE.Vector3(0, 0, 1), 0x3d6fdb, 'Z');
    const o = etiquette('O', 18);
    o.position.set(-22, -22, 4);
    this.statique.add(o);
    this.redimensionner();
    this.vue('iso');
  }

  private materiauConteneur(c: Conteneur, couleur: number, transparent = false): THREE.Material[] {
    if (!this.texturesCodes.has(c.code)) this.texturesCodes.set(c.code, texteTexture(c.code.replace('DEMO-', 'D-')));
    const cote = new THREE.MeshStandardMaterial({ color: couleur, roughness: 0.55, metalness: 0.1, transparent, opacity: transparent ? 0.45 : 1 });
    const dessus = new THREE.MeshStandardMaterial({ color: couleur, map: this.texturesCodes.get(c.code)!, roughness: 0.6, transparent, opacity: transparent ? 0.45 : 1 });
    return [cote, cote, cote, cote, dessus, cote];
  }

  private meshConteneur(c: Conteneur, couleur: number, titre: string, transparent = false): THREE.Mesh {
    const m = new THREE.Mesh(this.geo(c.longueur_mm, c.largeur_mm, c.hauteur_mm), this.materiauConteneur(c, couleur, transparent));
    m.castShadow = !transparent;
    m.receiveShadow = true;
    const aretes = new THREE.LineSegments(
      new THREE.EdgesGeometry(m.geometry),
      new THREE.LineBasicMaterial({ color: store.selection?.type === 'conteneur' && store.selection.id === c.id ? COULEURS.selection : 0x1b2b3c }),
    );
    m.add(aretes);
    m.userData.info = { kind: 'cont', id: c.id, titre } satisfies InfoObjet;
    return m;
  }

  rendre(): void {
    const e = store.etat;
    if (!e?.plan) return;
    if (this.planId !== e.plan.id) {
      this.planId = e.plan.id;
      this.construireStatique(e);
    }
    const jeter = (g: THREE.Group) => {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      });
      g.clear();
    };
    jeter(this.conteneurs);
    jeter(this.camions);
    jeter(this.cibles);
    jeter(this.divers);
    const sel = store.selection;
    // Conteneurs en place et incertains
    for (const c of e.conteneurs) {
      if (c.etat === 'EN_TRANSFERT' || c.x_mm === null) continue;
      const estSel = sel?.type === 'conteneur' && sel.id === c.id;
      let couleur = c.type_emplacement === 'PLATEAU' ? COULEURS.surCamion : COULEURS.conteneur;
      let titre = `${c.code} — ${c.code_emplacement ?? ''} — base (${c.x_mm}, ${c.y_mm}, ${c.z_mm}) mm`;
      const incertain = c.etat === 'INCERTAINE';
      if (incertain) {
        couleur = COULEURS.incertain;
        titre = `${c.code} — POSITION INCERTAINE (dernière connue) : ${c.motif_incertitude ?? ''}`;
      }
      if (estSel) couleur = COULEURS.selection;
      const m = this.meshConteneur(c, couleur, titre, incertain);
      m.position.set(c.x_mm, c.y_mm!, c.z_mm! + c.hauteur_mm / 2);
      this.conteneurs.add(m);
      if (incertain) {
        const s = etiquette('?', 30);
        s.position.set(c.x_mm, c.y_mm!, c.z_mm! + c.hauteur_mm + 26);
        this.divers.add(s);
      }
    }
    // Camions (cabine + plateau, dimensions illustratives)
    for (const v of e.visites) {
      const g = new THREE.Group();
      const Lt = v.cabine_longueur_mm + v.plateau_longueur_mm;
      const x0 = v.centre_x_mm - Lt / 2;
      const cabX = v.cote_cabine === 'X_MAX' ? x0 + v.plateau_longueur_mm + v.cabine_longueur_mm / 2 : x0 + v.cabine_longueur_mm / 2;
      const estSel = sel?.type === 'visite' && sel.id === v.id;
      const cab = new THREE.Mesh(
        this.geo(v.cabine_longueur_mm, v.cabine_largeur_mm, v.cabine_hauteur_mm),
        new THREE.MeshStandardMaterial({ color: estSel ? COULEURS.selection : COULEURS.cabine, roughness: 0.5 }),
      );
      cab.position.set(cabX, v.centre_y_mm, v.cabine_hauteur_mm / 2);
      const pl = new THREE.Mesh(
        this.geo(v.plateau_longueur_mm, v.plateau_largeur_mm, v.plateau_hauteur_mm),
        new THREE.MeshStandardMaterial({ color: COULEURS.plateau, roughness: 0.7 }),
      );
      pl.position.set(v.plateau_x_mm, v.plateau_y_mm, v.plateau_hauteur_mm / 2);
      for (const m of [cab, pl]) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
      const lib = etiquette(v.camion_code, 18);
      lib.position.set(cabX, v.centre_y_mm, v.cabine_hauteur_mm + 22);
      g.add(cab, pl, lib);
      g.userData.info = { kind: 'visite', id: v.id, titre: `Camion ${v.camion_code} — poste ${v.poste_code} (dimensions illustratives)` } satisfies InfoObjet;
      this.camions.add(g);
    }
    // Réservations (contour orange) et destinations possibles (fantômes verts)
    const tc = e.plan.geometrie.type_conteneur;
    const coord = new Map<number, { x: number; y: number; z: number }>();
    const posParId = new Map(e.plan.geometrie.positions.map((p) => [p.id, p]));
    for (const em of e.plan.geometrie.emplacements) {
      const p = posParId.get(em.position_sol_id)!;
      coord.set(em.id, { x: p.centre_x_mm, y: p.centre_y_mm, z: em.z_base_mm });
    }
    for (const v of e.visites) coord.set(v.plateau_emplacement_id, { x: v.plateau_x_mm, y: v.plateau_y_mm, z: v.plateau_z_mm });
    for (const r of e.reservations) {
      const k = coord.get(r.emplacement_id);
      if (!k || r.role !== 'DESTINATION') continue;
      const b = new THREE.LineSegments(new THREE.EdgesGeometry(this.geo(tc.longueur_mm, tc.largeur_mm, tc.hauteur_mm)), new THREE.LineDashedMaterial({ color: COULEURS.reserve, dashSize: 8, gapSize: 5 }));
      b.computeLineDistances();
      b.position.set(k.x, k.y, k.z + tc.hauteur_mm / 2);
      this.divers.add(b);
    }
    if ((store.mode.type === 'destination' || store.mode.type === 'declaration') && store.destinations) {
      const choix = store.mode.choix;
      for (const d of store.destinations.destinations) {
        if (d.raisons.length) continue;
        const k = coord.get(d.emplacement_id);
        if (!k) continue;
        const m = new THREE.Mesh(
          this.geo(tc.longueur_mm - 2, tc.largeur_mm - 2, tc.hauteur_mm - 2),
          new THREE.MeshBasicMaterial({ color: d.emplacement_id === choix ? COULEURS.selection : COULEURS.cible, transparent: true, opacity: d.emplacement_id === choix ? 0.75 : 0.35, depthWrite: false }),
        );
        m.position.set(k.x, k.y, k.z + tc.hauteur_mm / 2);
        m.userData.info = { kind: 'emp', id: d.emplacement_id, titre: `${d.code} : destination possible — cliquer pour choisir` } satisfies InfoObjet;
        this.cibles.add(m);
      }
    }
    // Trajet de simulation
    for (const t of e.trajets) {
      const geo = new THREE.BufferGeometry().setFromPoints(t.points.map((q) => new THREE.Vector3(q.x, q.y, q.z + this.hauteurConteneur / 2)));
      const ligne = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: COULEURS.unite, dashSize: 10, gapSize: 6 }));
      ligne.computeLineDistances();
      this.divers.add(ligne);
    }
    this.construireUnite(e);
  }

  private construireUnite(e: Etat): void {
    this.unite.clear();
    this.porte = null;
    const tc = e.plan!.geometrie.type_conteneur;
    const boite = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(tc.longueur_mm + 14, tc.largeur_mm + 14, tc.hauteur_mm + 14)),
      new THREE.LineBasicMaterial({ color: COULEURS.unite }),
    );
    boite.position.z = tc.hauteur_mm / 2;
    const anneau = new THREE.Mesh(new THREE.RingGeometry(14, 20, 32), new THREE.MeshBasicMaterial({ color: COULEURS.unite, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    anneau.name = 'anneau';
    const verticale = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineDashedMaterial({ color: COULEURS.unite, dashSize: 6, gapSize: 4 }),
    );
    verticale.name = 'verticale';
    this.unite.add(boite, anneau, verticale);
    const c = this.conteneurPorte(e);
    if (c) {
      const estSel = store.selection?.type === 'conteneur' && store.selection.id === c.id;
      this.porte = this.meshConteneur(c, estSel ? COULEURS.selection : COULEURS.transfert, `${c.code} — en transfert (mission M${c.mission_transfert_id})`);
      this.porte.position.z = c.hauteur_mm / 2;
      this.unite.add(this.porte);
    }
    this.majUnite();
  }

  /** Nouvelle position de l'unité (télémétrie) : interpolée à l'affichage. */
  majUnite(): void {
    const e = store.etat;
    const t = store.telemetrie;
    const x = t?.x ?? e?.unite?.x_mm;
    const y = t?.y ?? e?.unite?.y_mm;
    const z = t?.z ?? e?.unite?.z_mm;
    this.unite.visible = x !== null && x !== undefined;
    if (!this.unite.visible) return;
    this.uniteCible.set(x!, y!, z!);
    if (!this.uniteInit) {
      this.uniteActuelle.copy(this.uniteCible);
      this.uniteInit = true;
    }
    if (e && (this.conteneurPorte(e) !== undefined) !== (this.porte !== null)) this.construireUnite(e);
  }

  /** Conteneur porté : d'après la télémétrie, sinon d'après l'état EN_TRANSFERT enregistré. */
  private conteneurPorte(e: Etat): Conteneur | undefined {
    const t = store.telemetrie;
    const id = t?.conteneur_porte_id ?? e.conteneurs.find((c) => c.etat === 'EN_TRANSFERT')?.id ?? null;
    return id ? e.conteneurs.find((x) => x.id === id) : undefined;
  }

  private animerUnite(): void {
    if (!this.unite.visible) return;
    this.uniteActuelle.lerp(this.uniteCible, 0.35);
    this.unite.position.copy(this.uniteActuelle);
    const anneau = this.unite.getObjectByName('anneau');
    if (anneau) anneau.position.z = -this.uniteActuelle.z + 0.6;
    const v = this.unite.getObjectByName('verticale') as THREE.Line | undefined;
    if (v) {
      v.scale.z = Math.max(this.uniteActuelle.z, 1);
      v.computeLineDistances();
    }
  }
}
