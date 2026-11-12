// Accès à la base Cloudflare D1, avec la même interface que la version Node : query(sql, params) → { rows }.
// Les paramètres « $1, $2… » sont convertis en « ?1, ?2… » (numérotés, comme PostgreSQL).

export const MAINTENANT = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const DEBUT_JOUR = "strftime('%Y-%m-%dT00:00:00.000Z', 'now')";

const BOOLEENS = new Set(['actif', 'disponible', 'valide']);
const JSONS = new Set(['paiement_infos', 'abonnement', 'abonnement_push']);

function versD1(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function lireLigne(ligne) {
  for (const k of Object.keys(ligne)) {
    if (BOOLEENS.has(k) && ligne[k] !== null) ligne[k] = !!ligne[k];
    else if (JSONS.has(k) && typeof ligne[k] === 'string') { try { ligne[k] = JSON.parse(ligne[k]); } catch { /* texte brut */ } }
  }
  return ligne;
}

export function creerDb(d1) {
  return {
    async query(sql, params = []) {
      const texte = sql.replace(/\$(\d+)/g, '?$1');
      const r = await d1.prepare(texte).bind(...params.map(versD1)).all();
      return { rows: (r.results || []).map(lireLigne) };
    },
    /** Plusieurs écritures en une transaction (D1 batch). */
    async lot(requetes) {
      return d1.batch(requetes.map(([sql, params = []]) => d1.prepare(sql.replace(/\$(\d+)/g, '?$1')).bind(...params.map(versD1))));
    },
  };
}
