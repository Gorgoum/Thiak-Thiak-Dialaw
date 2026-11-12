// Notifications Web Push avec WebCrypto : chiffrement aes128gcm (RFC 8291) et signature VAPID (RFC 8292).
// Clés VAPID dans les secrets du Worker : VAPID_PUBLIC_KEY (point P-256 non compressé, base64url)
// et VAPID_PRIVATE_KEY (scalaire de 32 octets, base64url) — les mêmes que la bibliothèque web-push.
import { b64url, deB64url, octets, concat } from './outils.js';

async function hmac(cle, donnees) {
  const k = await crypto.subtle.importKey('raw', cle, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, donnees));
}

async function clePriveeVapid(env) {
  const pub = deB64url(env.VAPID_PUBLIC_KEY);
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function enteteVapid(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const entete = b64url(octets(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corps = b64url(octets(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:contact@thiakthiak.sn',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await clePriveeVapid(env), octets(`${entete}.${corps}`));
  return `vapid t=${entete}.${corps}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Chiffre le message pour un abonnement (RFC 8291, un seul enregistrement). */
async function chiffrer(abonnement, message) {
  const uaPublic = deB64url(abonnement.keys.p256dh);
  const secretAuth = deB64url(abonnement.keys.auth);
  const ephemere = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemere.publicKey));
  const cleUa = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const partage = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: cleUa }, ephemere.privateKey, 256));

  const prkCle = await hmac(secretAuth, partage);
  const ikm = await hmac(prkCle, concat(octets('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const sel = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(sel, ikm);
  const cek = (await hmac(prk, concat(octets('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(octets('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const cle = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const clair = concat(octets(message), new Uint8Array([2])); // 0x02 : dernier enregistrement
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cle, clair));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(sel, rs, new Uint8Array([asPublic.length]), asPublic, chiffre);
}

/** Envoie une notification. Renvoie false si l'abonnement a expiré (à supprimer). */
export async function envoyerA(env, abonnement, contenu) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !abonnement || !abonnement.endpoint) return true;
  try {
    const corps = await chiffrer(abonnement, JSON.stringify(contenu));
    const r = await fetch(abonnement.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await enteteVapid(env, abonnement.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '600',
        Urgency: 'high',
      },
      body: corps,
    });
    if (r.status === 404 || r.status === 410) return false;
    if (!r.ok) console.error('Échec push :', r.status, await r.text().catch(() => ''));
    return true;
  } catch (e) {
    console.error('Échec push :', e.message);
    return true;
  }
}

/** Envoie aux comptes donnés (livreurs, admin) ; supprime les abonnements expirés. */
export async function envoyer(c, userIds, contenu) {
  if (!userIds.length) return;
  const marques = userIds.map((_, i) => '$' + (i + 1)).join(', ');
  const r = await c.db.query(`SELECT id, abonnement FROM abonnements_push WHERE utilisateur_id IN (${marques})`, userIds);
  await Promise.all(r.rows.map(async (l) => {
    if (!(await envoyerA(c.env, l.abonnement, contenu))) await c.db.query('DELETE FROM abonnements_push WHERE id = $1', [l.id]);
  }));
}
