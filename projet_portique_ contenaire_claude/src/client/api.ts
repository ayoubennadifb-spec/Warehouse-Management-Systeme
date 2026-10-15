/** Appels à l'API locale. Les refus métier arrivent avec un code et un message en français. */
export class ErreurApi extends Error {
  code: string;
  statut: number;
  details: unknown;
  constructor(statut: number, code: string, message: string, details: unknown) {
    super(message);
    this.statut = statut;
    this.code = code;
    this.details = details;
  }
}

async function appel<T>(methode: string, url: string, corps?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: methode,
      headers: corps !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: corps !== undefined ? JSON.stringify(corps) : undefined,
    });
  } catch {
    throw new ErreurApi(0, 'SERVEUR_INJOIGNABLE', 'Serveur local injoignable : vérifiez qu’il est lancé (npm start).', null);
  }
  const texte = await r.text();
  const json = texte ? JSON.parse(texte) : null;
  if (!r.ok) {
    const e = json?.erreur ?? {};
    throw new ErreurApi(r.status, e.code ?? 'ERREUR', e.message ?? `Erreur HTTP ${r.status}`, e.details ?? null);
  }
  return json as T;
}

export const api = {
  get: <T>(url: string) => appel<T>('GET', url),
  post: <T>(url: string, corps: unknown = {}) => appel<T>('POST', url, corps),
};
