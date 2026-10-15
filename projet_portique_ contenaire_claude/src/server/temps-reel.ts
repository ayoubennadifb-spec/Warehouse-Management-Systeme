/**
 * Diffusion temps réel vers les navigateurs (Server-Sent Events).
 *  - Les événements métier sont lus dans la table `evenement` après notification PostgreSQL
 *    (LISTEN/NOTIFY, émise au COMMIT) : ordre garanti, identifiants stables, aucune perte.
 *  - Reprise après coupure : le client renvoie Last-Event-ID (ou ?depuis=) ; les événements
 *    manqués sont rejoués, ou un « resync » demande de recharger l'état complet.
 *  - Battement toutes les 5 s : état de la base et de la source (détection de données anciennes).
 *  - Télémétrie (position de l'unité) : transitoire, non stockée, sans identifiant.
 */
import pg from 'pg';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EtatSource } from './sources/types.ts';

interface ClientSSE {
  res: ServerResponse;
  dernier: number;
}

const MAX_REJEU = 500;

export class Diffuseur {
  private clients = new Set<ClientSSE>();
  private dernierDiffuse = 0;
  private ecouteur: pg.Client | null = null;
  private file: Promise<unknown> = Promise.resolve();
  private minuteries: NodeJS.Timeout[] = [];
  private arrete = false;
  base = { ok: false, latence_ms: null as number | null, erreur: null as string | null, verifie_le: null as string | null };
  etatSource: () => EtatSource = () => ({ mode: 'SIMULATION', connecte: false, description: '' });
  private url: string;
  private pool: pg.Pool;

  constructor(url: string, pool: pg.Pool) {
    this.url = url;
    this.pool = pool;
  }

  async demarrer(): Promise<void> {
    const r = await this.pool.query('SELECT coalesce(max(id), 0) AS id FROM evenement');
    this.dernierDiffuse = r.rows[0].id;
    await this.ecouter();
    this.minuteries.push(setInterval(() => void this.battement(), 5000));
    await this.verifierBase();
  }

  async arreter(): Promise<void> {
    this.arrete = true;
    this.minuteries.forEach(clearInterval);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    await this.ecouteur?.end().catch(() => undefined);
  }

  private async ecouter(): Promise<void> {
    if (this.arrete) return;
    const client = new pg.Client({ connectionString: this.url });
    client.on('notification', () => this.enchainer(() => this.rattraper()));
    client.on('error', () => undefined);
    client.on('end', () => {
      if (this.arrete) return;
      this.ecouteur = null;
      this.base.ok = false;
      this.base.erreur = 'Connexion d’écoute PostgreSQL perdue — reconnexion…';
      setTimeout(() => void this.ecouter().catch(() => undefined), 2000);
    });
    try {
      await client.connect();
      await client.query('LISTEN portique_evenements');
      this.ecouteur = client;
      this.enchainer(() => this.rattraper()); // événements écrits pendant la coupure
    } catch (e) {
      this.base.ok = false;
      this.base.erreur = `PostgreSQL injoignable : ${(e as Error).message}`;
      await client.end().catch(() => undefined);
      setTimeout(() => void this.ecouter().catch(() => undefined), 3000);
    }
  }

  private enchainer(f: () => Promise<unknown>): void {
    this.file = this.file.then(f).catch((e) => console.error('[temps-réel]', (e as Error).message));
  }

  private async rattraper(): Promise<void> {
    for (;;) {
      const r = await this.pool.query('SELECT * FROM evenement WHERE id > $1 ORDER BY id LIMIT 200', [this.dernierDiffuse]);
      for (const ev of r.rows) {
        for (const c of this.clients) if (ev.id > c.dernier) this.ecrire(c, 'evenement', ev, ev.id);
        this.dernierDiffuse = ev.id;
      }
      if (r.rows.length < 200) break;
    }
  }

  private ecrire(c: ClientSSE, type: string, data: unknown, id?: number): void {
    let s = '';
    if (id !== undefined) {
      s += `id: ${id}\n`;
      c.dernier = id;
    }
    s += `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    c.res.write(s);
  }

  ajouterClient(req: IncomingMessage, res: ServerResponse, depuis: number | null): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const entete = req.headers['last-event-id'];
    const dep = entete !== undefined && /^\d+$/.test(String(entete)) ? Number(entete) : depuis;
    const client: ClientSSE = { res, dernier: Number.MAX_SAFE_INTEGER };
    req.on('close', () => this.clients.delete(client));
    this.enchainer(async () => {
      if (dep === null) {
        client.dernier = this.dernierDiffuse;
      } else {
        const n = await this.pool.query('SELECT count(*)::int AS n FROM evenement WHERE id > $1 AND id <= $2', [dep, this.dernierDiffuse]);
        if (n.rows[0].n > MAX_REJEU) {
          client.dernier = this.dernierDiffuse;
          this.ecrire(client, 'resync', { raison: `${n.rows[0].n} événements manqués : recharger l’état complet` });
        } else {
          client.dernier = dep;
          const r = await this.pool.query('SELECT * FROM evenement WHERE id > $1 AND id <= $2 ORDER BY id', [dep, this.dernierDiffuse]);
          for (const ev of r.rows) this.ecrire(client, 'evenement', ev, ev.id);
          client.dernier = this.dernierDiffuse;
        }
      }
      this.clients.add(client);
      this.ecrire(client, 'battement', this.contenuBattement());
    });
  }

  /** Télémétrie transitoire (position de l'unité), non persistée. */
  telemetrie(data: unknown): void {
    for (const c of this.clients) c.res.write(`event: telemetrie\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Signal immédiat d'un changement d'état de la source (pause, blocage…). */
  signalerSource(): void {
    const d = this.contenuBattement();
    for (const c of this.clients) this.ecrire(c, 'battement', d);
  }

  private contenuBattement() {
    return { serveur_le: new Date().toISOString(), dernier_evenement_id: this.dernierDiffuse, base: this.base, source: this.etatSource() };
  }

  async verifierBase(): Promise<void> {
    const t = performance.now();
    try {
      await this.pool.query('SELECT 1');
      this.base = {
        ok: this.ecouteur !== null,
        latence_ms: Math.round((performance.now() - t) * 10) / 10,
        erreur: this.ecouteur ? null : 'Écoute temps réel indisponible',
        verifie_le: new Date().toISOString(),
      };
    } catch (e) {
      this.base = { ok: false, latence_ms: null, erreur: `PostgreSQL injoignable : ${(e as Error).message}`, verifie_le: new Date().toISOString() };
    }
  }

  private async battement(): Promise<void> {
    await this.verifierBase();
    this.signalerSource();
  }
}
