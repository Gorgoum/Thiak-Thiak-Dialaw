// Paiement Wave / Orange Money avec l'API Nangu (https://api.nangu-pay.workers.dev).
// La clé secrète reste sur ce serveur. La confirmation officielle arrive par webhook signé ;
// en secours, le serveur relit l'état du paiement chez Nangu avec sa clé.
const crypto = require('crypto');

const URL_API = (process.env.NANGU_API_URL || 'https://api.nangu-pay.workers.dev').replace(/\/+$/, '');
const CLE = process.env.NANGU_SECRET_KEY || '';
const SECRET_WEBHOOK = process.env.NANGU_WEBHOOK_SECRET || '';
const FOURNISSEURS = (process.env.NANGU_PROVIDERS || 'wave,orange_money')
  .split(',').map((s) => s.trim()).filter((s) => ['wave', 'orange_money'].includes(s));

const actif = () => !!CLE;
const modeTest = () => CLE.startsWith('sk_test_');
const fournisseurs = () => (actif() ? FOURNISSEURS : []);

class ErreurNangu extends Error {
  constructor(message, statut, code) {
    super(message);
    this.statutHttp = statut;
    this.code = code;
  }
}

async function appeler(methode, chemin, corps, entetes = {}) {
  if (!actif()) throw new ErreurNangu('Paiement en ligne non configuré', 503, 'non_configure');
  let r;
  try {
    r = await fetch(URL_API + chemin, {
      method: methode,
      headers: { Authorization: `Bearer ${CLE}`, 'Content-Type': 'application/json', ...entetes },
      body: corps ? JSON.stringify(corps) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new ErreurNangu('Service de paiement injoignable', 502, 'injoignable');
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = d.error || {};
    throw new ErreurNangu(err.message || `Erreur du service de paiement (${r.status})`, r.status, err.code);
  }
  return d;
}

/** Crée le paiement d'une course. Une clé d'idempotence par course : un nouvel essai renvoie le même paiement. */
function creerPaiement(course, fournisseur) {
  return appeler('POST', '/v1/payments', {
    amount: course.prix,
    reference: `TT-${course.id}`,
    provider: fournisseur,
    customer_phone: course.client_tel,
    description: `Livraison Thiak Thiak : ${course.depart_repere} → ${course.arrivee_repere}`.slice(0, 200),
    expires_in: 30 * 60, // 30 minutes pour payer
    metadata: { course_id: String(course.id) },
  }, { 'Idempotency-Key': `thiak-${course.suivi}-${fournisseur}` }); // code secret aléatoire : unique même si la numérotation repart à 1
}

const lirePaiement = (id) => appeler('GET', `/v1/payments/${encodeURIComponent(id)}`);
const annulerPaiement = (id) => appeler('POST', `/v1/payments/${encodeURIComponent(id)}/cancel`);

/** Ce que la page du client a besoin pour payer (aucune donnée secrète). */
function infosPaiement(p) {
  return {
    id: p.id,
    statut: p.status,
    fournisseur: p.provider || 'wave',
    montant_du: p.amount_due,
    pay_url: p.pay_url || null,
    android_intent_url: p.android_intent_url || null,
    qr_code_url: p.qr_code_url || null,
    checkout_url: p.checkout_url || null,
    maxit_url: p.maxit_url || null,
    merchant_code: p.merchant_code || null,
    ussd_code: p.ussd_code || null,
    expires_at: p.expires_at || null,
    test: modeTest(),
  };
}

/**
 * Vérifie la signature d'un webhook : en-tête « X-Signature: t=…,v1=… »,
 * HMAC-SHA256 du texte « t.corps_brut » avec le secret whsec_…, et t récent (5 minutes).
 */
function verifierSignature(corpsBrut, entete) {
  if (!SECRET_WEBHOOK || !entete) return false;
  const parts = Object.fromEntries(String(entete).split(',').map((x) => x.trim().split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const attendu = crypto.createHmac('sha256', SECRET_WEBHOOK).update(`${t}.${corpsBrut}`).digest('hex');
  const a = Buffer.from(attendu);
  const b = Buffer.from(String(parts.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  actif, modeTest, fournisseurs, creerPaiement, lirePaiement, annulerPaiement,
  infosPaiement, verifierSignature, ErreurNangu,
};
