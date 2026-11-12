// Routes administrateur : tableau de bord, validation des livreurs, courses, tarifs
const router = require('express').Router();
const { query } = require('../db');
const { exiger, a } = require('../auth');
const { parametres } = require('../tarifs');
const { SELECT_COURSE } = require('../courses-service');

router.use(exiger('admin'));

router.get('/stats', a(async (req, res) => {
  const p = await parametres();
  const c = (await query(
    `SELECT
       coalesce(sum(CASE WHEN statut = 'en_attente' THEN 1 ELSE 0 END), 0)::int AS en_attente,
       coalesce(sum(CASE WHEN statut IN ('acceptee', 'recuperee') THEN 1 ELSE 0 END), 0)::int AS en_cours,
       coalesce(sum(CASE WHEN statut = 'livree' AND livree_le >= date_trunc('day', now()) THEN 1 ELSE 0 END), 0)::int AS livrees_jour,
       coalesce(sum(CASE WHEN statut = 'livree' AND livree_le >= date_trunc('day', now()) THEN prix ELSE 0 END), 0)::int AS ca_jour,
       round(avg(note)::numeric, 1) AS note_moyenne
     FROM courses`
  )).rows[0];
  const l = (await query(
    `SELECT coalesce(sum(CASE WHEN actif AND disponible THEN 1 ELSE 0 END), 0)::int AS disponibles,
            coalesce(sum(CASE WHEN NOT actif THEN 1 ELSE 0 END), 0)::int AS a_valider,
            count(*)::int AS total
     FROM utilisateurs WHERE role = 'livreur'`
  )).rows[0];
  res.json({
    ...c,
    commission_jour: Math.round((c.ca_jour * (p.commission_pct || 0)) / 100),
    livreurs: l,
  });
}));

router.get('/livreurs', a(async (req, res) => {
  const r = await query(
    `SELECT u.id, u.nom, u.telephone, u.actif, u.disponible, u.position_maj, u.cree_le,
            coalesce(s.nb_livrees, 0)::int AS nb_livrees, s.note_moyenne
     FROM utilisateurs u
     LEFT JOIN (
       SELECT livreur_id,
              sum(CASE WHEN statut = 'livree' THEN 1 ELSE 0 END) AS nb_livrees,
              round(avg(note)::numeric, 1) AS note_moyenne
       FROM courses WHERE livreur_id IS NOT NULL GROUP BY livreur_id
     ) s ON s.livreur_id = u.id
     WHERE u.role = 'livreur'
     ORDER BY u.actif, u.nom`
  );
  res.json(r.rows);
}));

router.post('/livreurs/:id/activer', a(async (req, res) => {
  const actif = !!(req.body && req.body.actif);
  const r = await query(
    `UPDATE utilisateurs SET actif = $2, disponible = CASE WHEN $2 THEN disponible ELSE false END
     WHERE id = $1 AND role = 'livreur' RETURNING id`,
    [req.params.id, actif]
  );
  if (!r.rows.length) return res.status(404).json({ erreur: 'Livreur introuvable' });
  res.json({ ok: true });
}));

router.get('/courses', a(async (req, res) => {
  const statut = req.query.statut;
  const r = statut
    ? await query(SELECT_COURSE + ' WHERE c.statut = $1 ORDER BY c.cree_le DESC LIMIT 100', [statut])
    : await query(SELECT_COURSE + ' ORDER BY c.cree_le DESC LIMIT 100');
  res.json(r.rows);
}));

// Lieux ajoutés par l'admin (quartiers, boutiques, repères connus de tous à Yène)
const { CATEGORIES } = require('../lieux');
const { pointValide } = require('../tarifs');

router.post('/lieux', a(async (req, res) => {
  const { nom, categorie, lat, lng } = req.body || {};
  const n = String(nom || '').trim().slice(0, 120);
  if (n.length < 2) return res.status(400).json({ erreur: 'Indiquez le nom du lieu' });
  if (!pointValide({ lat, lng })) return res.status(400).json({ erreur: 'Placez le lieu sur la carte' });
  const r = await query(
    `INSERT INTO lieux (nom, categorie, lat, lng, source) VALUES ($1, $2, $3, $4, 'admin') RETURNING id, nom, categorie, lat, lng, source`,
    [n, CATEGORIES.includes(categorie) ? categorie : 'autre', Number(lat), Number(lng)]
  );
  res.status(201).json(r.rows[0]);
}));

// Lieux appris des livraisons, en attente de validation (les plus confirmés d'abord)
router.get('/lieux-proposes', a(async (req, res) => {
  const r = await query(
    `SELECT id, nom, categorie, lat, lng, vu_fois, cree_le FROM lieux
     WHERE NOT valide ORDER BY vu_fois DESC, cree_le DESC LIMIT 100`
  );
  res.json(r.rows);
}));

// Valider un lieu proposé, en corrigeant éventuellement son nom et sa catégorie
router.post('/lieux/:id/valider', a(async (req, res) => {
  const { nom, categorie } = req.body || {};
  const n = String(nom || '').trim().slice(0, 120);
  const r = await query(
    `UPDATE lieux SET valide = true,
       nom = CASE WHEN $2 = '' THEN nom ELSE $2 END,
       categorie = $3
     WHERE id = $1 RETURNING id, nom, categorie, lat, lng, source`,
    [req.params.id, n, CATEGORIES.includes(categorie) ? categorie : 'autre']
  );
  if (!r.rows.length) return res.status(404).json({ erreur: 'Lieu introuvable' });
  res.json(r.rows[0]);
}));

router.delete('/lieux/:id', a(async (req, res) => {
  const r = await query('DELETE FROM lieux WHERE id = $1 RETURNING id', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ erreur: 'Lieu introuvable' });
  res.json({ ok: true });
}));

const CLES = ['prix_base', 'prix_km', 'prix_min', 'facteur_route', 'commission_pct', 'rayon_km', 'zone_km'];

router.get('/parametres', a(async (req, res) => res.json(await parametres())));

router.put('/parametres', a(async (req, res) => {
  const b = req.body || {};
  for (const cle of CLES) {
    if (b[cle] === undefined) continue;
    const v = Number(b[cle]);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ erreur: `Valeur invalide pour ${cle}` });
    await query(
      'INSERT INTO parametres (cle, valeur) VALUES ($1, $2) ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur',
      [cle, String(v)]
    );
  }
  res.json(await parametres());
}));

module.exports = router;
