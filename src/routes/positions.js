// Demande de position : le client crée un lien, l'envoie au destinataire (WhatsApp, SMS),
// le destinataire l'ouvre et envoie sa position GPS, qui arrive en direct chez le client.
const crypto = require('crypto');
const router = require('express').Router();
const { query } = require('../db');
const { a } = require('../auth');
const { pointValide } = require('../tarifs');

const DUREE_VALIDITE_H = 24;
const parIp = new Map(); // anti-abus : 20 demandes par heure et par adresse
function tropDeDemandes(ip) {
  const t = Date.now();
  const l = (parIp.get(ip) || []).filter((x) => t - x < 3600 * 1000);
  const trop = l.length >= 20;
  if (!trop) l.push(t);
  parIp.set(ip, l);
  return trop;
}

async function lire(code) {
  const r = await query(
    `SELECT code, demandeur, lat, lng, precision_m, cree_le, recue_le FROM demandes_position WHERE code = $1`,
    [String(code)]
  );
  const d = r.rows[0];
  if (!d) return null;
  d.expiree = Date.now() - new Date(d.cree_le).getTime() > DUREE_VALIDITE_H * 3600 * 1000;
  return d;
}

router.post('/', a(async (req, res) => {
  if (tropDeDemandes(req.ip)) return res.status(429).json({ erreur: 'Trop de demandes, réessayez plus tard' });
  const code = crypto.randomBytes(9).toString('base64url');
  const demandeur = String((req.body && req.body.demandeur) || '').trim().slice(0, 60) || null;
  await query('INSERT INTO demandes_position (code, demandeur) VALUES ($1, $2)', [code, demandeur]);
  res.status(201).json({ code });
}));

router.get('/:code', a(async (req, res) => {
  const d = await lire(req.params.code);
  if (!d) return res.status(404).json({ erreur: 'Lien invalide' });
  res.json(d);
}));

router.post('/:code', a(async (req, res) => {
  const { lat, lng, precision } = req.body || {};
  if (!pointValide({ lat, lng })) return res.status(400).json({ erreur: 'Position invalide' });
  const d = await lire(req.params.code);
  if (!d) return res.status(404).json({ erreur: 'Lien invalide' });
  if (d.expiree) return res.status(410).json({ erreur: 'Ce lien a expiré, demandez-en un nouveau' });
  const prec = Number.isFinite(Number(precision)) ? Math.round(Number(precision)) : null;
  await query(
    'UPDATE demandes_position SET lat = $2, lng = $3, precision_m = $4, recue_le = now() WHERE code = $1',
    [d.code, Number(lat), Number(lng), prec]
  );
  const maj = await lire(d.code);
  req.app.get('io').to('position:' + d.code).emit('position:recue', maj);
  res.json({ ok: true });
}));

module.exports = router;
