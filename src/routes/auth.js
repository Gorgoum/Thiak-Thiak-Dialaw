const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { normaliserTel, signer, exiger, a } = require('../auth');

const vuePublique = (u) => ({
  id: u.id, nom: u.nom, telephone: u.telephone, role: u.role, actif: u.actif, disponible: u.disponible,
});

// Anti force brute sur le PIN : 5 échecs → blocage 15 minutes par numéro
const echecs = new Map();
const MAX_ECHECS = 5;
const BLOCAGE_MS = 15 * 60 * 1000;

// Seuls les livreurs s'inscrivent (les clients n'ont pas de compte, l'admin est créé par init-db)
router.post('/inscription', a(async (req, res) => {
  const { nom, telephone, pin } = req.body || {};
  const tel = normaliserTel(telephone);
  if (!nom || String(nom).trim().length < 2) return res.status(400).json({ erreur: 'Indiquez votre nom' });
  if (!tel) return res.status(400).json({ erreur: 'Numéro invalide (ex : 77 123 45 67)' });
  if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ erreur: 'Le PIN doit contenir 4 chiffres' });

  const existe = await query('SELECT 1 FROM utilisateurs WHERE telephone = $1', [tel]);
  if (existe.rows.length) return res.status(409).json({ erreur: 'Ce numéro a déjà un compte, connectez-vous' });

  const hash = await bcrypt.hash(String(pin), 10);
  const u = (await query(
    `INSERT INTO utilisateurs (nom, telephone, pin_hash, role, actif)
     VALUES ($1, $2, $3, 'livreur', false) RETURNING *`, // un livreur attend la validation de l'admin
    [String(nom).trim(), tel, hash]
  )).rows[0];

  req.app.get('io').to('admins').emit('livreurs:changement');
  res.status(201).json({ token: signer(u), utilisateur: vuePublique(u) });
}));

router.post('/connexion', a(async (req, res) => {
  const { telephone, pin } = req.body || {};
  const tel = normaliserTel(telephone);
  if (!tel) return res.status(400).json({ erreur: 'Numéro invalide' });

  const e = echecs.get(tel);
  if (e && e.n >= MAX_ECHECS && Date.now() - e.depuis < BLOCAGE_MS) {
    return res.status(429).json({ erreur: 'Trop d\'essais. Réessayez dans 15 minutes.' });
  }

  const u = (await query('SELECT * FROM utilisateurs WHERE telephone = $1', [tel])).rows[0];
  if (!u || !(await bcrypt.compare(String(pin || ''), u.pin_hash))) {
    const courant = e && Date.now() - e.depuis < BLOCAGE_MS ? e : { n: 0, depuis: Date.now() };
    courant.n += 1;
    echecs.set(tel, courant);
    return res.status(400).json({ erreur: 'Numéro ou PIN incorrect' });
  }
  echecs.delete(tel);
  res.json({ token: signer(u), utilisateur: vuePublique(u) });
}));

router.get('/moi', exiger(), a(async (req, res) => {
  const u = (await query('SELECT * FROM utilisateurs WHERE id = $1', [req.user.id])).rows[0];
  if (!u) return res.status(401).json({ erreur: 'Compte introuvable' });
  res.json(vuePublique(u));
}));

// Enregistre l'abonnement Web Push du téléphone
router.post('/push', exiger(), a(async (req, res) => {
  const ab = req.body && req.body.abonnement;
  if (!ab || !ab.endpoint || !ab.keys) return res.status(400).json({ erreur: 'Abonnement invalide' });
  await query(
    `INSERT INTO abonnements_push (utilisateur_id, endpoint, abonnement) VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET utilisateur_id = EXCLUDED.utilisateur_id, abonnement = EXCLUDED.abonnement`,
    [req.user.id, ab.endpoint, ab]
  );
  res.json({ ok: true });
}));

module.exports = router;
