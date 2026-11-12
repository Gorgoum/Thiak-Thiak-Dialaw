// Outils communs du Worker : réponses JSON, erreurs, routeur minimal, encodages.

export class HttpErreur extends Error {
  constructor(statut, message) {
    super(message);
    this.statut = statut;
  }
}

export const json = (donnees, statut = 200, entetes = {}) =>
  new Response(JSON.stringify(donnees), {
    status: statut,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...entetes },
  });

export async function lireCorps(req) {
  try { return (await req.json()) || {}; } catch { return {}; }
}

/** Adresse IP du client : posée par Cloudflare (impossible à falsifier en production). */
export const adresseIp = (req) =>
  req.headers.get('CF-Connecting-IP') || (req.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || 'local';

export const texte = (v, max = 300) => String(v ?? '').trim().slice(0, max);

/** Routeur minimal : chemins avec paramètres « :nom ». */
export class Routeur {
  constructor() { this.routes = []; }
  ajouter(methode, chemin, gestionnaire) {
    const cles = [];
    const motif = new RegExp('^' + chemin.replace(/:(\w+)/g, (_, k) => { cles.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ methode, motif, cles, gestionnaire });
    return this;
  }
  get(c, g) { return this.ajouter('GET', c, g); }
  post(c, g) { return this.ajouter('POST', c, g); }
  put(c, g) { return this.ajouter('PUT', c, g); }
  delete(c, g) { return this.ajouter('DELETE', c, g); }
  async traiter(req, c) {
    for (const r of this.routes) {
      if (r.methode !== req.method) continue;
      const m = c.url.pathname.match(r.motif);
      if (!m) continue;
      c.params = Object.fromEntries(r.cles.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return r.gestionnaire(req, c);
    }
    return null;
  }
}

// ---------- Encodages ----------
export function b64url(octets) {
  let s = '';
  const t = new Uint8Array(octets);
  for (let i = 0; i < t.length; i++) s += String.fromCharCode(t[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function deB64url(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
export const octets = (texteUtf8) => new TextEncoder().encode(texteUtf8);
export function concat(...tableaux) {
  const total = tableaux.reduce((n, t) => n + t.length, 0);
  const r = new Uint8Array(total);
  let pos = 0;
  for (const t of tableaux) { r.set(t, pos); pos += t.length; }
  return r;
}
export const codeAleatoire = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));
