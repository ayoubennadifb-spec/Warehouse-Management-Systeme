/**
 * Vue du dessus en SVG, à l'échelle : 1 unité SVG = 1 mm.
 * Repère : origine O en bas à gauche, X vers la droite, Y vers le haut (Y écran inversé).
 */
import { store } from './store.ts';
import { esc, mm } from './util.ts';
import type { Conteneur, Etat, Position } from './types.ts';

const NS = 'http://www.w3.org/2000/svg';

export interface ActionsVue {
  cliquerPosition(id: number): void;
  cliquerConteneur(id: number): void;
  cliquerVisite(id: number): void;
  cliquerEmplacement(id: number): void;
}

export class VueDessus {
  private hote: HTMLElement;
  private svg: SVGSVGElement;
  private calqueUnite: SVGGElement;
  private actions: ActionsVue;
  private W = 500;

  constructor(hote: HTMLElement, actions: ActionsVue) {
    this.hote = hote;
    this.actions = actions;
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'svg-dessus');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', 'Vue du dessus de l’espace de travail, à l’échelle');
    this.calqueUnite = document.createElementNS(NS, 'g');
    hote.append(this.svg);
    this.svg.addEventListener('click', (ev) => this.clic(ev));
  }

  private clic(ev: MouseEvent): void {
    const t = (ev.target as Element).closest('[data-cont],[data-pos],[data-visite],[data-emp]') as SVGElement | null;
    if (!t) return;
    const d = t.dataset;
    if (d.emp) this.actions.cliquerEmplacement(Number(d.emp));
    else if (d.cont) this.actions.cliquerConteneur(Number(d.cont));
    else if (d.visite) this.actions.cliquerVisite(Number(d.visite));
    else if (d.pos) this.actions.cliquerPosition(Number(d.pos));
  }

  private sy(y: number): number {
    return this.W - y;
  }

  rendre(): void {
    const e = store.etat;
    if (!e?.plan) {
      this.svg.innerHTML = '';
      return;
    }
    const p = e.plan;
    const L = p.parametres.espace.longueur_x_mm;
    const W = (this.W = p.parametres.espace.largeur_y_mm);
    const marge = store.cotes ? 82 : 20;
    this.svg.setAttribute('viewBox', `${-marge} ${-30} ${L + marge + 20} ${W + 30 + marge}`);
    const tc = p.geometrie.type_conteneur;
    const parts: string[] = [];
    parts.push(`<defs>
      <pattern id="hachures" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="8" class="hachure"/></pattern>
      <marker id="fleche" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" class="fleche"/></marker>
    </defs>`);
    // Zones
    for (const z of p.geometrie.zones) {
      const cls = z.code === 'STOCKAGE' ? 'zone-stockage' : 'zone-transport';
      parts.push(
        `<rect class="${cls}" x="${z.x_min_mm}" y="${this.sy(z.y_max_mm)}" width="${z.x_max_mm - z.x_min_mm}" height="${z.y_max_mm - z.y_min_mm}"/>`,
        `<text class="lib-zone" x="${z.x_min_mm + 6}" y="${this.sy(z.y_max_mm) - 8}">${z.code === 'STOCKAGE' ? 'STOCKAGE' : 'TRANSPORT'} · ${mm(z.x_max_mm - z.x_min_mm)} × ${mm(z.y_max_mm - z.y_min_mm)} mm</text>`,
      );
    }
    // Index : emplacement → conteneur, réservations, destinations
    const parEmp = new Map<number, Conteneur>();
    for (const c of e.conteneurs) if (c.emplacement_id) parEmp.set(c.emplacement_id, c);
    const reserve = new Map(e.reservations.map((r) => [r.emplacement_id, r]));
    const empsParPos = new Map<number, { id: number; niveau: number; code: string }[]>();
    for (const em of p.geometrie.emplacements) {
      if (!empsParPos.has(em.position_sol_id)) empsParPos.set(em.position_sol_id, []);
      empsParPos.get(em.position_sol_id)!.push(em);
    }
    const dest = store.destinations ? new Map(store.destinations.destinations.map((d) => [d.emplacement_id, d])) : null;
    const modeChoix = store.mode.type === 'destination' || store.mode.type === 'declaration';
    const choix = modeChoix ? (store.mode as { choix: number | null }).choix : null;
    const sel = store.selection;
    const selCont = sel?.type === 'conteneur' ? e.conteneurs.find((c) => c.id === sel.id) : undefined;

    for (const pos of p.geometrie.positions) {
      const emps = (empsParPos.get(pos.id) ?? []).sort((a, b) => a.niveau - b.niveau);
      const pile = emps.map((em) => parEmp.get(em.id)).filter((c): c is Conteneur => !!c);
      const h = pile.length;
      const x = pos.centre_x_mm - tc.longueur_mm / 2;
      const y = this.sy(pos.centre_y_mm + tc.largeur_mm / 2);
      let cls = `case h${Math.min(h, 3)}`;
      let titre = `${pos.code} — centre (${mm(pos.centre_x_mm)} ; ${mm(pos.centre_y_mm)}) mm — ${h}/${p.nb_niveaux_max} niveau(x)`;
      if (pos.statut === 'BLOQUEE') {
        cls += ' bloquee';
        titre += ` — BLOQUÉE : ${pos.motif_blocage}`;
      }
      if (emps.some((em) => reserve.has(em.id))) cls += ' reservee';
      if (sel?.type === 'position' && sel.id === pos.id) cls += ' sel';
      if (selCont && pile.some((c) => c.id === selCont.id)) cls += ' sel';
      let attrCible = `data-pos="${pos.id}"`;
      let etiquetteCible = '';
      if (modeChoix && dest) {
        const cible = emps.find((em) => !parEmp.has(em.id));
        const d = cible ? dest.get(cible.id) : undefined;
        if (cible && d && d.raisons.length === 0) {
          cls += cible.id === choix ? ' cible-choisie' : ' cible-ok';
          attrCible = `data-emp="${cible.id}"`;
          etiquetteCible = `<text class="lib-cible" x="${pos.centre_x_mm}" y="${this.sy(pos.centre_y_mm) + 4}" text-anchor="middle">N${cible.niveau}</text>`;
          titre = `${cible.code} : destination possible`;
        } else {
          cls += ' cible-ko';
          titre = `${pos.code} : ${cible ? (d?.raisons.map((r) => r.message).join(' ') ?? 'indisponible') : 'pile complète'}`;
        }
      }
      parts.push(`<g class="${cls}" ${attrCible}><title>${esc(titre)}</title>
        <rect x="${x}" y="${y}" width="${tc.longueur_mm}" height="${tc.largeur_mm}" rx="2"/>
        <text class="lib-pos" x="${x + 4}" y="${y + 11}">${esc(pos.code)}</text>`);
      if (h > 0 && !modeChoix) {
        const haut = pile[h - 1];
        parts.push(`<text class="lib-cont" x="${pos.centre_x_mm}" y="${this.sy(pos.centre_y_mm) + 9}" text-anchor="middle">${esc(haut.code.replace('DEMO-', 'D-'))}</text>`);
      }
      for (let n = 0; n < p.nb_niveaux_max; n++)
        parts.push(`<rect class="niv ${n < h ? 'plein' : ''}" x="${x + tc.longueur_mm - 10}" y="${y + tc.largeur_mm - 8 - n * 7}" width="6" height="5"/>`);
      parts.push(etiquetteCible, '</g>');
    }

    // Postes et camions
    for (const ps of p.geometrie.postes) {
      const v = e.visites.find((x) => x.poste_id === ps.id);
      parts.push(
        `<g class="poste ${ps.statut === 'HORS_SERVICE' ? 'hs' : ''}"><title>${esc(`Poste ${ps.code}${ps.statut === 'HORS_SERVICE' ? ` — HORS SERVICE : ${ps.motif_indisponibilite}` : v ? ` — occupé par ${v.camion_code}` : ' — libre'}`)}</title>
        <rect x="${ps.centre_x_mm - ps.longueur_x_mm / 2 + 3}" y="${this.sy(ps.centre_y_mm + ps.largeur_y_mm / 2) + 3}" width="${ps.longueur_x_mm - 6}" height="${ps.largeur_y_mm - 6}" rx="4"/>
        <text class="lib-poste" x="${ps.centre_x_mm - ps.longueur_x_mm / 2 + 8}" y="${this.sy(ps.centre_y_mm + ps.largeur_y_mm / 2) + 16}">${esc(ps.code)}</text></g>`,
      );
      if (!v) continue;
      const Lc = v.cabine_longueur_mm;
      const Lb = v.plateau_longueur_mm;
      const Lt = Lc + Lb;
      const x0 = ps.centre_x_mm - Lt / 2;
      const cabX = v.cote_cabine === 'X_MAX' ? x0 + Lb : x0;
      const plX = v.cote_cabine === 'X_MAX' ? x0 : x0 + Lc;
      const cont = parEmp.get(v.plateau_emplacement_id);
      let clsCam = 'camion';
      if (sel?.type === 'visite' && sel.id === v.id) clsCam += ' sel';
      let attr = `data-visite="${v.id}"`;
      let titre = `Camion ${v.camion_code} au poste ${v.poste_code}${cont ? ` — porte ${cont.code}` : ' — plateau vide'}`;
      if (modeChoix && dest) {
        const d = dest.get(v.plateau_emplacement_id);
        if (d && d.raisons.length === 0) {
          clsCam += v.plateau_emplacement_id === choix ? ' cible-choisie' : ' cible-ok';
          attr = `data-emp="${v.plateau_emplacement_id}"`;
          titre = `Plateau de ${v.camion_code} : destination possible`;
        } else if (d) {
          clsCam += ' cible-ko';
          titre = `Plateau de ${v.camion_code} : ${d.raisons.map((r) => r.message).join(' ')}`;
        }
      }
      parts.push(`<g class="${clsCam}" ${attr}><title>${esc(titre)}</title>
        <rect class="cabine" x="${cabX}" y="${this.sy(v.centre_y_mm + v.cabine_largeur_mm / 2)}" width="${Lc}" height="${v.cabine_largeur_mm}" rx="3"/>
        <rect class="plateau" x="${plX}" y="${this.sy(v.centre_y_mm + v.plateau_largeur_mm / 2)}" width="${Lb}" height="${v.plateau_largeur_mm}" rx="1"/>
        <text class="lib-camion" x="${cabX + Lc / 2}" y="${this.sy(v.centre_y_mm) + 4}" text-anchor="middle">${esc(v.camion_code.replace('DEMO-', 'D-'))}</text></g>`);
      if (cont) parts.push(this.dessinConteneur(cont, v.plateau_x_mm, v.plateau_y_mm, selCont?.id === cont.id, 'sur-camion'));
    }

    // Conteneurs incertains (dernière position connue) ; conteneur en transfert (télémétrie)
    for (const c of e.conteneurs) {
      if (c.etat === 'INCERTAINE' && c.x_mm !== null) parts.push(this.dessinConteneur(c, c.x_mm, c.y_mm!, selCont?.id === c.id, 'incertain'));
    }
    // Trajet de simulation de la mission en cours
    for (const t of e.trajets) {
      const pts = t.points.map((q) => `${q.x},${this.sy(q.y)}`).join(' ');
      parts.push(`<polyline class="trajet" points="${pts}"><title>Trajet de simulation v${t.version} (trajet optimisé dans le modèle de simulation)</title></polyline>`);
    }
    if (store.cotes) parts.push(this.cotes(e));
    // Repère
    parts.push(`<g class="repere">
      <line x1="0" y1="${W}" x2="60" y2="${W}" marker-end="url(#fleche)"/><text x="64" y="${W + 4}">X</text>
      <line x1="0" y1="${W}" x2="0" y2="${W - 60}" marker-end="url(#fleche)"/><text x="-4" y="${W - 66}" text-anchor="middle">Y</text>
      <circle cx="0" cy="${W}" r="3"/><text x="-8" y="${W + 14}" text-anchor="end">O</text></g>`);
    this.svg.innerHTML = parts.join('');
    this.calqueUnite = document.createElementNS(NS, 'g');
    this.calqueUnite.setAttribute('class', 'calque-unite');
    this.svg.append(this.calqueUnite);
    this.majUnite();
  }

  private dessinConteneur(c: Conteneur, x: number, y: number, selection: boolean, cls: string): string {
    const L = c.longueur_mm;
    const l = c.largeur_mm;
    return `<g class="cont ${cls} ${selection ? 'sel' : ''}" data-cont="${c.id}"><title>${esc(`${c.code} — ${cls === 'incertain' ? `position INCERTAINE (dernière connue) : ${c.motif_incertitude ?? ''}` : c.code_emplacement ?? ''}`)}</title>
      <rect x="${x - L / 2}" y="${this.sy(y + l / 2)}" width="${L}" height="${l}" rx="2"/>
      <text x="${x}" y="${this.sy(y) + 4}" text-anchor="middle">${cls === 'incertain' ? '? ' : ''}${esc(c.code.replace('DEMO-', 'D-'))}</text></g>`;
  }

  /** Position de l'unité abstraite et du conteneur porté (télémétrie temps réel). */
  majUnite(): void {
    const e = store.etat;
    if (!e?.plan) return;
    const t = store.telemetrie;
    const x = t?.x ?? e.unite?.x_mm;
    const y = t?.y ?? e.unite?.y_mm;
    if (x === undefined || x === null || y === undefined || y === null) {
      this.calqueUnite.innerHTML = '';
      return;
    }
    let html = '';
    const porte = t?.conteneur_porte_id ? e.conteneurs.find((c) => c.id === t.conteneur_porte_id) : undefined;
    const enTransfert = porte ?? e.conteneurs.find((c) => c.etat === 'EN_TRANSFERT');
    if (enTransfert) html += this.dessinConteneur(enTransfert, x, y, store.selection?.type === 'conteneur' && store.selection.id === enTransfert.id, 'transfert');
    html += `<g class="unite"><title>Unité de manutention ABSTRAITE (mécanisme non choisi) — (${mm(x)} ; ${mm(y)} ; z ${mm(t?.z ?? e.unite?.z_mm)}) mm</title>
      <circle cx="${x}" cy="${this.sy(y)}" r="9"/><line x1="${x - 14}" y1="${this.sy(y)}" x2="${x + 14}" y2="${this.sy(y)}"/>
      <line x1="${x}" y1="${this.sy(y) - 14}" x2="${x}" y2="${this.sy(y) + 14}"/></g>`;
    this.calqueUnite.innerHTML = html;
  }

  private cotes(e: Etat): string {
    const p = e.plan!;
    const L = p.parametres.espace.longueur_x_mm;
    const W = p.parametres.espace.largeur_y_mm;
    const st = p.geometrie.zones.find((z) => z.code === 'STOCKAGE')!;
    const tr = p.geometrie.zones.find((z) => z.code === 'TRANSPORT')!;
    const yb = W + 32;
    const yb2 = W + 52;
    const cote = (x1: number, x2: number, y: number, txt: string) =>
      `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" marker-start="url(#fleche)" marker-end="url(#fleche)"/>
       <text x="${(x1 + x2) / 2}" y="${y - 4}" text-anchor="middle">${txt}</text>`;
    const rx = p.geometrie.repartition_x;
    const ry = p.geometrie.repartition_y;
    const pos: Position | undefined = p.geometrie.positions[0];
    return `<g class="cotes">
      ${cote(st.x_min_mm, st.x_max_mm, yb, `stockage ${mm(st.x_max_mm - st.x_min_mm)} mm`)}
      ${cote(tr.x_min_mm, tr.x_max_mm, yb, `transport ${mm(tr.x_max_mm - tr.x_min_mm)} mm`)}
      ${cote(0, L, yb2, `espace total ${mm(L)} mm`)}
      <line x1="-30" y1="0" x2="-30" y2="${W}" marker-start="url(#fleche)" marker-end="url(#fleche)"/>
      <text x="-36" y="${W / 2}" text-anchor="middle" transform="rotate(-90 -36 ${W / 2})">${mm(W)} mm</text>
      ${pos && rx && ry ? `<text class="cote-info" x="${st.x_min_mm}" y="${W + 72}" text-anchor="start">marges/espacements : X ${mm(rx.marge_debut, 2)} / ${mm(rx.espacement, 2)} mm · Y ${mm(ry.marge_debut, 2)} / ${mm(ry.espacement, 2)} mm${rx.auto && ry.auto ? ' (répartition uniforme — hypothèse)' : ''}</text>` : ''}
    </g>`;
  }
}
