// Paiement Wave / Orange Money avec l'API Nangu. Secrets du Worker : NANGU_SECRET_KEY, NANGU_WEBHOOK_SECRET.
import { octets } from './outils.js';

const urlApi = (env) => (env.NANGU_API_URL || 'https://api.nangu-pay.workers.dev').replace(/\/+$/, '');
export const actif = (env) => !!env.NANGU_SECRET_KEY;
export const modeTest = (env) => String(env.NANGU_SECRET_KEY || '').startsWith('sk_test_');
export const fournisseurs = (env) => (actif(env)
  ? String(env.NANGU_PROVIDERS || 'wave,orange_money').split(',').map((s) => s.trim()).filter((s) => ['wave', 'orange_money'].includes(s))
  : []);

async function appeler(env, methode, chemin, corps, entetes = {}) {
  if (!actif(env)) throw new Error('Paiement en ligne non configuré');
  let r;
  // liaison de service vers le Worker Nangu du même compte si elle existe, sinon appel public
  // (pas en local : NANGU_API_URL pointe alors vers un faux Nangu de test)
  const viaLiaison = env.NANGU && /\.workers\.dev$/.test(new URL(urlApi(env)).hostname);
  const appel = viaLiaison ? (u, o) => env.NANGU.fetch(u, o) : fetch;
  try {
    r = await appel(urlApi(env) + chemin, {
      method: methode,
      headers: { Authorization: `Bearer ${env.NANGU_SECRET_KEY}`, 'Content-Type': 'application/json', ...entetes },
      body: corps ? JSON.stringify(corps) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error('Service de paiement injoignable'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || `Erreur du service de paiement (${r.status})`);
  return d;
}

export function creerPaiement(env, course, fournisseur) {
  return appeler(env, 'POST', '/v1/payments', {
    amount: course.prix,
    reference: `TT-${course.id}`,
    provider: fournisseur,
    customer_phone: course.client_tel,
    description: `Livraison Thiak Thiak : ${course.depart_repere} → ${course.arrivee_repere}`.slice(0, 200),
    expires_in: 30 * 60,
    metadata: { course_id: String(course.id) },
  }, { 'Idempotency-Key': `thiak-${course.suivi}-${fournisseur}` }); // code secret aléatoire : unique même si la numérotation repart à 1
}

export const lirePaiement = (env, id) => appeler(env, 'GET', `/v1/payments/${encodeURIComponent(id)}`);
export const annulerPaiement = (env, id) => appeler(env, 'POST', `/v1/payments/${encodeURIComponent(id)}/cancel`);

export function infosPaiement(env, p) {
  return {
    id: p.id, statut: p.status, fournisseur: p.provider || 'wave', montant_du: p.amount_due,
    pay_url: p.pay_url || null, android_intent_url: p.android_intent_url || null,
    qr_code_url: p.qr_code_url || null, checkout_url: p.checkout_url || null,
    maxit_url: p.maxit_url || null, merchant_code: p.merchant_code || null, ussd_code: p.ussd_code || null,
    expires_at: p.expires_at || null, test: modeTest(env),
  };
}

/** Signature webhook : HMAC-SHA256 de « t.corps_brut » avec whsec_…, t de moins de 5 minutes. */
export async function verifierSignature(env, corpsBrut, entete) {
  if (!env.NANGU_WEBHOOK_SECRET || !entete) return false;
  const parts = Object.fromEntries(String(entete).split(',').map((x) => x.trim().split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const cle = await crypto.subtle.importKey('raw', octets(env.NANGU_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cle, octets(`${t}.${corpsBrut}`)));
  const attendu = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  const recu = String(parts.v1);
  if (attendu.length !== recu.length) return false;
  let diff = 0;
  for (let i = 0; i < attendu.length; i++) diff |= attendu.charCodeAt(i) ^ recu.charCodeAt(i);
  return diff === 0;
}
