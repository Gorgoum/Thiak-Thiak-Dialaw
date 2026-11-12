// Sécurité avec la cryptographie intégrée aux Workers (WebCrypto) :
// jetons de session JWT HS256, codes PIN hachés en PBKDF2, limites anti-abus en base.
import { HttpErreur, b64url, deB64url, octets } from './outils.js';

// ---------- Téléphone ----------
export function normaliserTel(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (d.startsWith('00221')) d = d.slice(5);
  else if (d.startsWith('221') && d.length === 12) d = d.slice(3);
  return /^7\d{8}$/.test(d) ? d : null;
}

// ---------- JWT HS256 ----------
async function cleHmac(secret) {
  return crypto.subtle.importKey('raw', octets(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signer(u, secret) {
  const entete = b64url(octets(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const maintenant = Math.floor(Date.now() / 1000);
  const corps = b64url(octets(JSON.stringify({ id: u.id, role: u.role, nom: u.nom, iat: maintenant, exp: maintenant + 30 * 86400 })));
  const sig = await crypto.subtle.sign('HMAC', await cleHmac(secret), octets(`${entete}.${corps}`));
  return `${entete}.${corps}.${b64url(sig)}`;
}

export async function verifier(jeton, secret) {
  const [entete, corps, sig] = String(jeton || '').split('.');
  if (!entete || !corps || !sig) throw new Error('jeton invalide');
  const ok = await crypto.subtle.verify('HMAC', await cleHmac(secret), deB64url(sig), octets(`${entete}.${corps}`));
  if (!ok) throw new Error('signature invalide');
  const charge = JSON.parse(new TextDecoder().decode(deB64url(corps)));
  if (!charge.exp || charge.exp < Date.now() / 1000) throw new Error('jeton expiré');
  return charge;
}

/** Exige un jeton valide (et éventuellement un rôle). Renvoie l'utilisateur du jeton. */
export async function exiger(req, c, ...roles) {
  const h = req.headers.get('Authorization') || '';
  const jeton = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!jeton) throw new HttpErreur(401, 'Connexion requise');
  let u;
  try { u = await verifier(jeton, c.env.JWT_SECRET); } catch { throw new HttpErreur(401, 'Session expirée, reconnectez-vous'); }
  if (roles.length && !roles.includes(u.role)) throw new HttpErreur(403, 'Accès refusé');
  c.user = u;
  return u;
}

// ---------- Codes PIN : PBKDF2-SHA256 ----------
// Un PIN à 4 chiffres reste devinable : la vraie protection est la limite d'essais (voir limiter()).
const ITERATIONS = 10000;

async function deriver(pin, sel, iterations) {
  const cle = await crypto.subtle.importKey('raw', octets(String(pin)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sel, iterations }, cle, 256));
}

export async function hacherPin(pin) {
  const sel = crypto.getRandomValues(new Uint8Array(16));
  const h = await deriver(pin, sel, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(sel)}$${b64url(h)}`;
}

export async function verifierPin(pin, stocke) {
  const [algo, it, sel, h] = String(stocke || '').split('$');
  if (algo !== 'pbkdf2') return false;
  const calcule = b64url(await deriver(pin, deB64url(sel), Number(it)));
  // comparaison à temps constant
  if (calcule.length !== h.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= calcule.charCodeAt(i) ^ h.charCodeAt(i);
  return diff === 0;
}

// ---------- Limites anti-abus (en base : partagées entre toutes les instances du Worker) ----------
/** Compte une action ; renvoie true si la limite est dépassée sur la fenêtre. */
export async function limiter(db, cle, max, fenetreMs, { compter = true } = {}) {
  const t = Date.now();
  const r = (await db.query('SELECT compte, debut FROM limites WHERE cle = $1', [cle])).rows[0];
  const valide = r && t - r.debut < fenetreMs;
  const compte = valide ? r.compte : 0;
  if (compte >= max) return true;
  if (compter) {
    await db.query(
      `INSERT INTO limites (cle, compte, debut) VALUES ($1, $2, $3)
       ON CONFLICT (cle) DO UPDATE SET compte = excluded.compte, debut = excluded.debut`,
      [cle, compte + 1, valide ? r.debut : t]
    );
  }
  return false;
}

export async function effacerLimite(db, cle) {
  await db.query('DELETE FROM limites WHERE cle = $1', [cle]);
}
