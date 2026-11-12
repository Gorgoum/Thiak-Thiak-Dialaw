// Demandes de position, lieux, configuration, clé push.
import { HttpErreur, json, lireCorps, adresseIp, codeAleatoire } from '../outils.js';
import { MAINTENANT } from '../db.js';
import { limiter } from '../securite.js';
import { pointValide } from '../tarifs.js';
import * as nangu from '../nangu.js';

const DUREE_VALIDITE_H = 24;

async function lirePosition(c, code) {
  const d = (await c.db.query(
    'SELECT code, demandeur, lat, lng, precision_m, cree_le, recue_le FROM demandes_position WHERE code = $1', [String(code)]
  )).rows[0];
  if (!d) return null;
  d.expiree = Date.now() - new Date(d.cree_le).getTime() > DUREE_VALIDITE_H * 3600 * 1000;
  return d;
}

export function enregistrer(r) {
  r.get('/api/config', async (req, c) => json({ paiement_en_ligne: nangu.fournisseurs(c.env), paiement_test: nangu.actif(c.env) && nangu.modeTest(c.env) }));

  r.get('/api/push/cle', async (req, c) => json({ cle: c.env.VAPID_PUBLIC_KEY || null }));

  r.get('/api/lieux', async (req, c) => {
    const res = await c.db.query('SELECT id, nom, categorie, lat, lng, source FROM lieux WHERE valide = 1 ORDER BY nom');
    return json(res.rows, 200, { 'Cache-Control': 'no-cache' });
  });

  // Demande de position : le client envoie un lien, le destinataire renvoie sa position GPS
  r.post('/api/positions', async (req, c) => {
    if (await limiter(c.db, 'pos:' + adresseIp(req), 20, 3600 * 1000)) throw new HttpErreur(429, 'Trop de demandes, réessayez plus tard');
    const code = codeAleatoire(9);
    const demandeur = String((await lireCorps(req)).demandeur || '').trim().slice(0, 60) || null;
    await c.db.query('INSERT INTO demandes_position (code, demandeur) VALUES ($1, $2)', [code, demandeur]);
    return json({ code }, 201);
  });

  r.get('/api/positions/:code', async (req, c) => {
    const d = await lirePosition(c, c.params.code);
    if (!d) throw new HttpErreur(404, 'Lien invalide');
    return json(d);
  });

  r.post('/api/positions/:code', async (req, c) => {
    const { lat, lng, precision } = await lireCorps(req);
    if (!pointValide({ lat, lng })) throw new HttpErreur(400, 'Position invalide');
    const d = await lirePosition(c, c.params.code);
    if (!d) throw new HttpErreur(404, 'Lien invalide');
    if (d.expiree) throw new HttpErreur(410, 'Ce lien a expiré, demandez-en un nouveau');
    const prec = Number.isFinite(Number(precision)) ? Math.round(Number(precision)) : null;
    await c.db.query(`UPDATE demandes_position SET lat = $2, lng = $3, precision_m = $4, recue_le = ${MAINTENANT} WHERE code = $1`,
      [d.code, Number(lat), Number(lng), prec]);
    c.io.to('position:' + d.code).emit('position:recue', await lirePosition(c, d.code));
    return json({ ok: true });
  });
}
