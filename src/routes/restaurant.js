// Restaurants partenaires (ex. : Resto OUMY DJIAMIL).
//  - /api/restaurant/…        : le restaurant se connecte (téléphone + PIN), voit ses commandes, signale « plats prêts »
//  - /api/admin/restaurants/… : l'admin crée et gère les comptes restaurant
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { normaliserTel, exiger, a } = require('../auth');
const jwt = require('jsonwebtoken');
const { SELECT_COURSE, diffuserMaj } = require('../courses-service');
const push = require('../push');

const SECRET = process.env.JWT_SECRET || 'dev-secret-a-changer';
const texte = (v, max) => String(v ?? '').trim().slice(0, max);
const ACTIFS = "('en_attente', 'attente_paiement', 'acceptee', 'recuperee')";

/** Ce que voit le restaurant d'une commande : les plats et le livreur, pas le téléphone ni l'adresse du client. */
const vueCommande = (c) => ({
  id: c.id, statut: c.statut, description: c.description, montant_achat: c.montant_achat,
  cree_le: c.cree_le, acceptee_le: c.acceptee_le, arrive_le: c.arrive_le, recuperee_le: c.recuperee_le, livree_le: c.livree_le, annulee_le: c.annulee_le,
  plats_prets_le: c.plats_prets_le, client_prenom: String(c.client_nom || '').split(/\s+/)[0],
  livreur_nom: c.livreur_nom || null, livreur_tel: c.livreur_tel || null, livreur_vehicule: c.livreur_vehicule || null,
});

// ---------------------------------------------------------------- espace restaurant
const restaurant = express.Router();
const echecs = new Map();

restaurant.post('/connexion', a(async (req, res) => {
  const tel = normaliserTel((req.body || {}).telephone);
  if (!tel) return res.status(400).json({ erreur: 'Numéro invalide' });
  const e = echecs.get(tel);
  if (e && e.n >= 5 && Date.now() - e.depuis < 15 * 60000) return res.status(429).json({ erreur: 'Trop d\'essais. Réessayez dans 15 minutes.' });
  const r = (await query('SELECT * FROM restaurants WHERE telephone = $1', [tel])).rows[0];
  if (!r || !(await bcrypt.compare(String((req.body || {}).pin || ''), r.pin_hash))) {
    const courant = e && Date.now() - e.depuis < 15 * 60000 ? e : { n: 0, depuis: Date.now() };
    courant.n += 1;
    echecs.set(tel, courant);
    return res.status(400).json({ erreur: 'Numéro ou PIN incorrect' });
  }
  if (!r.actif) return res.status(403).json({ erreur: 'Ce compte restaurant est désactivé. Contactez Yobalema.' });
  echecs.delete(tel);
  res.json({ token: jwt.sign({ id: r.id, role: 'restaurant', nom: r.nom }, SECRET, { expiresIn: '30d' }), restaurant: { id: r.id, nom: r.nom, code: r.code } });
}));

restaurant.use(exiger('restaurant'));

restaurant.get('/moi', a(async (req, res) => {
  const r = (await query('SELECT id, nom, code, actif FROM restaurants WHERE id = $1', [req.user.id])).rows[0];
  if (!r || !r.actif) return res.status(401).json({ erreur: 'Compte introuvable ou désactivé' });
  res.json(r);
}));

// Commandes en cours, puis celles des dernières 24 h
restaurant.get('/commandes', a(async (req, res) => {
  const r = await query(
    `${SELECT_COURSE} WHERE c.restaurant_id = $1 AND (c.statut IN ${ACTIFS} OR c.cree_le > now() - interval '24 hours') ORDER BY c.cree_le DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(r.rows.map(vueCommande));
}));

restaurant.post('/commandes/:id/prets', a(async (req, res) => {
  const r = await query(
    `UPDATE courses SET plats_prets_le = now()
     WHERE id = $1 AND restaurant_id = $2 AND statut IN ('en_attente', 'acceptee') AND plats_prets_le IS NULL RETURNING id, livreur_id`,
    [req.params.id, req.user.id]
  );
  if (!r.rows.length) return res.status(409).json({ erreur: 'Commande déjà prête, partie ou annulée' });
  const io = req.app.get('io');
  await diffuserMaj(io, r.rows[0].id, { notifierClient: false, notifierDest: false });
  io.to('livreurs').emit('courses:changement');
  if (r.rows[0].livreur_id) {
    push.envoyer([r.rows[0].livreur_id], { titre: 'Plats prêts', corps: `${req.user.nom} : vous pouvez venir chercher la commande.` }).catch(() => {});
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- gestion par l'admin
const gestion = express.Router();
gestion.use(exiger('admin'));

function lireRestaurant(b, creation) {
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const r = {
    nom: texte(b.nom, 80), adresse: texte(b.adresse, 160) || null, actif: b.actif !== false,
    code: texte(b.code, 40).toLowerCase(), telephone: normaliserTel(b.telephone), lat, lng,
  };
  if (r.nom.length < 2) return { erreur: 'Indiquez le nom du restaurant' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { erreur: 'Position du restaurant invalide' };
  if (creation) {
    if (!/^[a-z0-9-]{3,40}$/.test(r.code)) return { erreur: 'Code : 3 à 40 lettres minuscules, chiffres ou tirets (ex : oumy-djiamil)' };
    if (!r.telephone) return { erreur: 'Numéro invalide (ex : 77 123 45 67)' };
  }
  if ((creation || b.pin) && !/^\d{4}$/.test(String(b.pin || ''))) return { erreur: 'Le PIN doit contenir 4 chiffres' };
  return r;
}

gestion.get('/', a(async (req, res) => {
  const r = await query('SELECT id, code, nom, telephone, lat, lng, adresse, actif, cree_le FROM restaurants ORDER BY nom');
  const nb = new Map((await query('SELECT restaurant_id, COUNT(*) AS n FROM courses WHERE restaurant_id IS NOT NULL GROUP BY restaurant_id')).rows.map((x) => [x.restaurant_id, Number(x.n)]));
  res.json(r.rows.map((x) => ({ ...x, nb_commandes: nb.get(x.id) || 0 })));
}));
gestion.post('/', a(async (req, res) => {
  const r = lireRestaurant(req.body || {}, true);
  if (r.erreur) return res.status(400).json(r);
  if ((await query('SELECT 1 FROM restaurants WHERE code = $1 OR telephone = $2', [r.code, r.telephone])).rows.length) {
    return res.status(409).json({ erreur: 'Ce code ou ce numéro est déjà utilisé par un restaurant' });
  }
  const ins = await query(
    'INSERT INTO restaurants (code, nom, telephone, pin_hash, lat, lng, adresse, actif) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [r.code, r.nom, r.telephone, await bcrypt.hash(String(req.body.pin), 10), r.lat, r.lng, r.adresse, r.actif]
  );
  res.status(201).json({ id: ins.rows[0].id });
}));
gestion.put('/:id', a(async (req, res) => {
  const r = lireRestaurant(req.body || {}, false);
  if (r.erreur) return res.status(400).json(r);
  await query('UPDATE restaurants SET nom = $2, adresse = $3, lat = $4, lng = $5, actif = $6 WHERE id = $1', [req.params.id, r.nom, r.adresse, r.lat, r.lng, r.actif]);
  if (req.body.pin) await query('UPDATE restaurants SET pin_hash = $2 WHERE id = $1', [req.params.id, await bcrypt.hash(String(req.body.pin), 10)]);
  // nouveau numéro de connexion (unique entre restaurants)
  if (req.body.telephone) {
    if (!r.telephone) return res.status(400).json({ erreur: 'Numéro invalide (ex : 77 123 45 67)' });
    if ((await query('SELECT 1 FROM restaurants WHERE telephone = $1 AND id <> $2', [r.telephone, req.params.id])).rows.length) return res.status(409).json({ erreur: 'Ce numéro est déjà utilisé par un autre restaurant' });
    await query('UPDATE restaurants SET telephone = $2 WHERE id = $1', [req.params.id, r.telephone]);
  }
  res.json({ ok: true });
}));

module.exports = { restaurant, gestion, vueCommande };
