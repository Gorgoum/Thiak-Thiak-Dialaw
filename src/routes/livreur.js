// Routes côté livreur thiak thiak
const router = require('express').Router();
const { query } = require('../db');
const { exiger, a } = require('../auth');
const { distanceKm, pointValide, parametres } = require('../tarifs');
const { SELECT_COURSE, lireCourse, notifierNouvelleCourse, diffuserMaj } = require('../courses-service');
const { apprendreDeLaCourse } = require('../lieux');

// Tout livreur doit être connecté ET validé par l'admin
router.use(exiger('livreur'), a(async (req, res, next) => {
  const u = (await query('SELECT id, actif, lat, lng FROM utilisateurs WHERE id = $1', [req.user.id])).rows[0];
  if (!u) return res.status(401).json({ erreur: 'Compte introuvable' });
  if (!u.actif) return res.status(403).json({ erreur: 'Votre compte livreur attend la validation de l\'administrateur' });
  req.livreur = u;
  next();
}));

router.post('/disponibilite', a(async (req, res) => {
  const { disponible, lat, lng } = req.body || {};
  await query('UPDATE utilisateurs SET disponible = $2 WHERE id = $1', [req.user.id, !!disponible]);
  if (pointValide({ lat, lng })) {
    await query('UPDATE utilisateurs SET lat = $2, lng = $3, position_maj = now() WHERE id = $1', [req.user.id, lat, lng]);
  }
  req.app.get('io').to('admins').emit('livreurs:changement');
  res.json({ disponible: !!disponible });
}));

router.post('/position', a(async (req, res) => {
  const { lat, lng } = req.body || {};
  if (!pointValide({ lat, lng })) return res.status(400).json({ erreur: 'Position invalide' });
  await query('UPDATE utilisateurs SET lat = $2, lng = $3, position_maj = now() WHERE id = $1', [req.user.id, lat, lng]);
  res.json({ ok: true });
}));

// Courses en attente, sans le téléphone du client (révélé seulement après acceptation)
router.get('/courses-disponibles', a(async (req, res) => {
  const r = await query(
    `SELECT id, type, description, montant_achat, depart_lat, depart_lng, depart_repere,
            arrivee_lat, arrivee_lng, arrivee_repere, distance_km, prix, paiement, paiement_statut, cree_le
     FROM courses WHERE statut = 'en_attente' ORDER BY cree_le DESC LIMIT 50`
  );
  const moi = req.livreur;
  const p = await parametres();
  const liste = r.rows.map((c) => ({
    ...c,
    distance_moi_km: moi.lat != null
      ? Math.round(distanceKm(moi, { lat: c.depart_lat, lng: c.depart_lng }) * (p.facteur_route || 1) * 10) / 10
      : null,
  }));
  liste.sort((x, y) => (x.distance_moi_km ?? 999) - (y.distance_moi_km ?? 999));
  res.json(liste);
}));

router.get('/mes-courses', a(async (req, res) => {
  const r = await query(SELECT_COURSE + ' WHERE c.livreur_id = $1 ORDER BY c.cree_le DESC LIMIT 30', [req.user.id]);
  res.json(r.rows);
}));

router.get('/gains', a(async (req, res) => {
  const p = await parametres();
  const r = await query(
    `SELECT count(*)::int AS nb, coalesce(sum(prix), 0)::int AS total
     FROM courses WHERE livreur_id = $1 AND statut = 'livree' AND livree_le >= date_trunc('day', now())`,
    [req.user.id]
  );
  const { nb, total } = r.rows[0];
  const commission = Math.round((total * (p.commission_pct || 0)) / 100);
  res.json({ nb, total, commission, net: total - commission, commission_pct: p.commission_pct });
}));

router.post('/courses/:id/accepter', a(async (req, res) => {
  try {
    const r = await query(
      `UPDATE courses SET statut = 'acceptee', livreur_id = $2, acceptee_le = now()
       WHERE id = $1 AND statut = 'en_attente' RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(409).json({ erreur: 'Trop tard, cette course a déjà été prise ou annulée' });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erreur: 'Terminez d\'abord votre course en cours' });
    throw e;
  }
  res.json(await diffuserMaj(req.app.get('io'), req.params.id));
}));

// Transitions autorisées : acceptee → recuperee → livree
const ETAPES = {
  recuperee: { depuis: 'acceptee', colonne: 'recuperee_le' },
  livree: { depuis: 'recuperee', colonne: 'livree_le' },
};
for (const [statut, e] of Object.entries(ETAPES)) {
  router.post(`/courses/:id/${statut}`, a(async (req, res) => {
    const r = await query(
      `UPDATE courses SET statut = $3, ${e.colonne} = now()
       WHERE id = $1 AND livreur_id = $2 AND statut = $4 RETURNING id`,
      [req.params.id, req.user.id, statut, e.depuis]
    );
    if (!r.rows.length) return res.status(409).json({ erreur: 'Action impossible à ce stade de la course' });
    const course = await diffuserMaj(req.app.get('io'), req.params.id);
    if (statut === 'livree') {
      // livraison réussie : ses repères deviennent des lieux proposés à l'admin
      apprendreDeLaCourse(course)
        .then(() => req.app.get('io').to('admins').emit('lieux:proposes'))
        .catch((err) => console.error('Apprentissage des lieux :', err.message));
    }
    res.json(course);
  }));
}

// Le livreur se désiste avant d'avoir récupéré le colis : la course repart aux autres livreurs
router.post('/courses/:id/liberer', a(async (req, res) => {
  const r = await query(
    `UPDATE courses SET statut = 'en_attente', livreur_id = NULL, acceptee_le = NULL
     WHERE id = $1 AND livreur_id = $2 AND statut = 'acceptee' RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!r.rows.length) return res.status(409).json({ erreur: 'Impossible de libérer cette course' });
  const io = req.app.get('io');
  io.to('user:' + req.user.id).emit('course:maj', { id: Number(req.params.id) });
  const c = await diffuserMaj(io, req.params.id);
  notifierNouvelleCourse(io, c).catch((e) => console.error('Notification :', e.message));
  res.json({ ok: true });
}));

module.exports = router;
