// Routes côté livreur
const router = require('express').Router();
const { query } = require('../db');
const { exiger, a } = require('../auth');
const { distanceKm, pointValide, parametres, messageSurPlace } = require('../tarifs');
const { SELECT_COURSE, lireCourse, notifierNouvelleCourse, diffuserMaj } = require('../courses-service');
const { apprendreDeLaCourse } = require('../lieux');
const argent = require('../argent');
const paiements = require('../paiements');

// Tout livreur doit être connecté ET validé par l'admin
router.use(exiger('livreur'), a(async (req, res, next) => {
  const u = (await query('SELECT id, actif, lat, lng, vehicule FROM utilisateurs WHERE id = $1', [req.user.id])).rows[0];
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
  const { lat, lng, precision } = req.body || {};
  if (!pointValide({ lat, lng })) return res.status(400).json({ erreur: 'Position invalide' });
  await query('UPDATE utilisateurs SET lat = $2, lng = $3, position_maj = now() WHERE id = $1', [req.user.id, lat, lng]);
  // le client voit sa moto / sa voiture arriver en direct (seulement pendant la course)
  const enCours = (await query("SELECT id, suivi_token FROM courses WHERE livreur_id = $1 AND statut IN ('acceptee', 'recuperee')", [req.user.id])).rows;
  const io = req.app.get('io');
  for (const x of enCours) io.to('suivi:' + x.suivi_token).emit('livreur:position', { course_id: x.id, lat: Number(lat), lng: Number(lng) });
  const transitions = enCours.length ? await detecterArrivees(io, req.user.id, { lat: Number(lat), lng: Number(lng) }, precision) : [];
  res.json({ ok: true, en_course: enCours.length > 0, transitions });
}));

// Courses en attente, sans le téléphone du client (révélé seulement après acceptation)
router.get('/courses-disponibles', a(async (req, res) => {
  const r = await query(
    `SELECT id, type, description, montant_achat, depart_lat, depart_lng, depart_repere,
            arrivee_lat, arrivee_lng, arrivee_repere, distance_km, prix, paiement, paiement_statut, cree_le, service, vehicule
     FROM courses WHERE statut = 'en_attente' AND (service = 'livraison' OR vehicule = $1) ORDER BY cree_le DESC LIMIT 50`,
    [req.livreur.vehicule || 'moto'] // un trajet en voiture n'est proposé qu'aux voitures
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

// Mon argent : solde, journée, historique
router.get('/argent', a(async (req, res) => res.json(await argent.argentLivreur(req.user.id))));

router.post('/courses/:id/accepter', a(async (req, res) => {
  const demande = (await query('SELECT service, vehicule FROM courses WHERE id = $1', [req.params.id])).rows[0];
  if (demande && demande.service === 'trajet' && demande.vehicule !== (req.livreur.vehicule || 'moto')) {
    return res.status(409).json({ erreur: `Ce trajet demande une ${demande.vehicule}.` });
  }
  const b = await argent.bloque(req.user.id);
  if (b) {
    return res.status(403).json({
      erreur: `Vous devez ${Math.abs(b.solde).toLocaleString('fr-FR')} FCFA à la plateforme (plafond ${b.plafond.toLocaleString('fr-FR')} FCFA). Reversez-les pour accepter de nouvelles courses.`,
    });
  }
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
  const io = req.app.get('io');
  const c = (await query('SELECT paiement, paiement_statut FROM courses WHERE id = $1', [req.params.id])).rows[0];
  if (c.paiement !== 'especes' && c.paiement_statut !== 'paye') {
    // course à payer en ligne : le client paie maintenant qu'un livreur est trouvé
    try {
      const origine = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      await paiements.demanderPaiement(io, req.params.id, origine);
    } catch (e) {
      // Nangu indisponible : on rend la course aux autres livreurs plutôt que de faire attendre celui-ci
      console.error('Demande de paiement :', e.message);
      await query(`UPDATE courses SET statut = 'en_attente', livreur_id = NULL, acceptee_le = NULL WHERE id = $1 AND statut = 'acceptee'`, [req.params.id]);
      await diffuserMaj(io, req.params.id, { notifierClient: false });
      return res.status(502).json({ erreur: 'Le paiement du client ne peut pas être lancé pour le moment. Réessayez dans un instant.' });
    }
    return res.json(await lireCourse(req.params.id));
  }
  res.json(await diffuserMaj(io, req.params.id));
}));

/**
 * Le livreur est-il vraiment sur place ? Sa position est envoyée avec le bouton (sinon la dernière connue).
 * Renvoie null si c'est bon (ou si la course n'est pas à lui : la mise à jour répondra), sinon le message.
 */
async function controleSurPlace(req, versArrivee) {
  const c = (await query(
    'SELECT depart_lat, depart_lng, depart_repere, arrivee_lat, arrivee_lng, arrivee_repere FROM courses WHERE id = $1 AND livreur_id = $2',
    [req.params.id, req.user.id]
  )).rows[0];
  if (!c) return null;
  const p = await parametres();
  const b = req.body || {};
  let position = null;
  if (pointValide({ lat: b.lat, lng: b.lng })) {
    position = { lat: Number(b.lat), lng: Number(b.lng) };
    await query('UPDATE utilisateurs SET lat = $2, lng = $3, position_maj = now() WHERE id = $1', [req.user.id, position.lat, position.lng]);
  } else if (req.livreur.lat != null) {
    position = { lat: Number(req.livreur.lat), lng: Number(req.livreur.lng) };
  }
  return messageSurPlace({
    position,
    cible: versArrivee ? { lat: c.arrivee_lat, lng: c.arrivee_lng } : { lat: c.depart_lat, lng: c.depart_lng },
    repere: versArrivee ? c.arrivee_repere : c.depart_repere,
    rayon: p.rayon_arrivee_m ?? 200,
    precision: b.precision,
    versArrivee,
  });
}

// =========================================================================
// Arrivées détectées par le GPS, comme Google Maps (pas de bouton à toucher)
//  - à moins de RAYON du départ A        → « arrivé » (le client est prévenu)
//  - reparti à plus de RAYON + 150 m de A → passager à bord / colis récupéré
//    (après au moins 30 s sur place, et seulement si la course est payée quand elle se paie en ligne)
//  - à moins de RAYON de l'arrivée B     → course terminée
// Une position trop imprécise (> 100 m) n'est jamais utilisée.
// =========================================================================
async function detecterArrivees(io, livreurId, pos, precision) {
  if (precision !== undefined && precision !== null && precision !== '' && Number(precision) > 100) return [];
  const p = await parametres();
  const rayon = p.rayon_arrivee_m || 200;
  const courses = (await query(
    `SELECT id, statut, service, arrive_le, paiement, paiement_statut, depart_lat, depart_lng, arrivee_lat, arrivee_lng
     FROM courses WHERE livreur_id = $1 AND statut IN ('acceptee', 'recuperee')`, [livreurId]
  )).rows;
  const faits = [];
  for (const c of courses) {
    const dA = distanceKm(pos, { lat: c.depart_lat, lng: c.depart_lng }) * 1000;
    const dB = distanceKm(pos, { lat: c.arrivee_lat, lng: c.arrivee_lng }) * 1000;
    const trajet = c.service === 'trajet';
    const payee = c.paiement === 'especes' || c.paiement_statut === 'paye';
    if (c.statut === 'acceptee' && !c.arrive_le && dA <= rayon) {
      const r = await query(`UPDATE courses SET arrive_le = now() WHERE id = $1 AND statut = 'acceptee' AND arrive_le IS NULL RETURNING id`, [c.id]);
      if (!r.rows.length) continue;
      await diffuserMaj(io, c.id, {
        titre: trajet ? 'Votre chauffeur est là' : 'Le livreur est arrivé',
        message: trajet ? 'Votre chauffeur est arrivé au point de départ.' : 'Le livreur est arrivé au point de départ pour récupérer le colis.',
        urgent: true,
      });
      faits.push({ id: c.id, etape: 'arrive' });
    } else if (c.statut === 'acceptee' && c.arrive_le && payee && dA > rayon + 150 && Date.now() - new Date(c.arrive_le).getTime() > 30000) {
      const r = await query(`UPDATE courses SET statut = 'recuperee', recuperee_le = now() WHERE id = $1 AND statut = 'acceptee' RETURNING id`, [c.id]);
      if (!r.rows.length) continue;
      await diffuserMaj(io, c.id);
      faits.push({ id: c.id, etape: 'recuperee' });
    } else if (c.statut === 'recuperee' && dB <= rayon) {
      const r = await query(`UPDATE courses SET statut = 'livree', livree_le = now() WHERE id = $1 AND statut = 'recuperee' RETURNING id`, [c.id]);
      if (!r.rows.length) continue;
      const course = await diffuserMaj(io, c.id);
      await argent.inscrireCoursesLivrees(c.id); // part du livreur ou commission, au registre
      apprendreDeLaCourse(course)
        .then(() => io.to('admins').emit('lieux:proposes'))
        .catch((err) => console.error('Apprentissage des lieux :', err.message));
      faits.push({ id: c.id, etape: 'livree' });
    }
  }
  return faits;
}

// « Je suis arrivé » au point de départ : le client est prévenu (passager : « votre chauffeur est là »)
router.post('/courses/:id/arrive', a(async (req, res) => {
  const loin = await controleSurPlace(req, false);
  if (loin) return res.status(409).json({ erreur: loin });
  const r = await query(
    `UPDATE courses SET arrive_le = now() WHERE id = $1 AND livreur_id = $2 AND statut = 'acceptee' RETURNING id, service`,
    [req.params.id, req.user.id]
  );
  if (!r.rows.length) return res.status(409).json({ erreur: 'Action impossible à ce stade de la course' });
  const trajet = r.rows[0].service === 'trajet';
  res.json(await diffuserMaj(req.app.get('io'), req.params.id, {
    titre: trajet ? 'Votre chauffeur est là' : 'Le livreur est arrivé',
    message: trajet ? 'Votre chauffeur est arrivé au point de départ.' : 'Le livreur est arrivé au point de départ pour récupérer le colis.',
    urgent: true,
  }));
}));

// Transitions autorisées : acceptee → recuperee → livree
const ETAPES = {
  recuperee: { depuis: 'acceptee', colonne: 'recuperee_le' },
  livree: { depuis: 'recuperee', colonne: 'livree_le' },
};
for (const [statut, e] of Object.entries(ETAPES)) {
  router.post(`/courses/:id/${statut}`, a(async (req, res) => {
    if (statut === 'recuperee') {
      // course à payer en ligne : on ne prend pas le colis avant que le client ait payé
      const c = (await query('SELECT paiement, paiement_statut FROM courses WHERE id = $1 AND livreur_id = $2', [req.params.id, req.user.id])).rows[0];
      if (c && c.paiement !== 'especes' && c.paiement_statut !== 'paye') {
        return res.status(409).json({ erreur: 'Le client n\'a pas encore payé. Attendez le paiement avant de récupérer le colis.' });
      }
    }
    const loin = await controleSurPlace(req, statut === 'livree');
    if (loin) return res.status(409).json({ erreur: loin });
    const r = await query(
      `UPDATE courses SET statut = $3, ${e.colonne} = now()
       WHERE id = $1 AND livreur_id = $2 AND statut = $4 RETURNING id`,
      [req.params.id, req.user.id, statut, e.depuis]
    );
    if (!r.rows.length) return res.status(409).json({ erreur: 'Action impossible à ce stade de la course' });
    const course = await diffuserMaj(req.app.get('io'), req.params.id);
    if (statut === 'livree') {
      await argent.inscrireCoursesLivrees(course.id); // part du livreur ou commission, au registre
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
