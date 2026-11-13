// Routes administrateur : tableau de bord, validation des livreurs, courses, tarifs
const router = require('express').Router();
const { query } = require('../db');
const { exiger, a } = require('../auth');
const { parametres } = require('../tarifs');
const { SELECT_COURSE } = require('../courses-service');

router.use(exiger('admin'));
// Un admin retiré perd l'accès tout de suite, même si son jeton n'a pas expiré
router.use(a(async (req, res, next) => {
  const r = await query(`SELECT 1 FROM utilisateurs WHERE id = $1 AND role = 'admin'`, [req.user.id]);
  if (!r.rows.length) return res.status(401).json({ erreur: 'Compte administrateur introuvable, reconnectez-vous' });
  next();
}));

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

// Modifier le nom ou la catégorie d'un lieu
router.put('/lieux/:id', a(async (req, res) => {
  const { nom, categorie } = req.body || {};
  const n = String(nom || '').trim().slice(0, 120);
  if (n.length < 2) return res.status(400).json({ erreur: 'Indiquez le nom du lieu' });
  const r = await query(
    'UPDATE lieux SET nom = $2, categorie = $3 WHERE id = $1 RETURNING id, nom, categorie, lat, lng, source',
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

const CLES = ['prix_base', 'prix_km', 'prix_min', 'facteur_route', 'commission_pct', 'rayon_km', 'zone_km', 'plafond_dette'];

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

// =========================================================================
// Comptes : livreurs et administrateurs (ajouter, modifier, supprimer)
// =========================================================================
const bcrypt = require('bcryptjs');
const { normaliserTel } = require('../auth');
const argent = require('../argent');

// =========================================================================
// Argent des livreurs : soldes, historique, règlements, export
// =========================================================================
router.get('/soldes', a(async (req, res) => res.json(await argent.soldes())));
router.get('/livreurs/:id/mouvements', a(async (req, res) => res.json(await argent.mouvementsLivreur(req.params.id))));
router.post('/livreurs/:id/reglements', a(async (req, res) => {
  try {
    const b = req.body || {};
    const r = await argent.enregistrerReglement(req.params.id, { montant: b.montant, reference: b.reference, adminId: req.user.id });
    req.app.get('io').to('user:' + req.params.id).emit('argent:maj', r);
    res.status(201).json(r);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ erreur: e.message });
    throw e;
  }
}));
// Export Excel (CSV) : ?mois=2026-11 (mois en cours par défaut)
router.get('/mouvements.csv', a(async (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(String(req.query.mois || '')) ? req.query.mois : new Date().toISOString().slice(0, 7);
  const [an, mo] = m.split('-').map(Number);
  const du = new Date(Date.UTC(an, mo - 1, 1)).toISOString();
  const au = new Date(Date.UTC(an, mo, 1)).toISOString();
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="thiak-thiak-argent-${m}.csv"`);
  res.send(await argent.exportCsv({ du, au }));
}));
const { diffuserMaj, notifierNouvelleCourse } = require('../courses-service');
const push = require('../push');

/** Vérifie nom, téléphone et PIN (PIN facultatif en modification). Renvoie les valeurs propres. */
async function lireCompte(b, { id = null, pinObligatoire = true } = {}) {
  const nom = String(b.nom || '').trim().slice(0, 100);
  const tel = normaliserTel(b.telephone);
  const pin = String(b.pin || '').trim();
  if (nom.length < 2) return { erreur: 'Indiquez le nom' };
  if (!tel) return { erreur: 'Numéro invalide (ex : 77 123 45 67)' };
  if ((pinObligatoire || pin) && !/^\d{4}$/.test(pin)) return { erreur: 'Le code PIN doit contenir 4 chiffres' };
  const pris = await query('SELECT id FROM utilisateurs WHERE telephone = $1 AND id <> $2', [tel, id || 0]);
  if (pris.rows.length) return { erreur: 'Ce numéro est déjà utilisé par un autre compte' };
  return { nom, tel, pin };
}

async function creerCompte(req, res, role) {
  const v = await lireCompte(req.body || {});
  if (v.erreur) return res.status(400).json({ erreur: v.erreur });
  const r = await query(
    `INSERT INTO utilisateurs (nom, telephone, pin_hash, role, actif) VALUES ($1, $2, $3, $4, true)
     RETURNING id, nom, telephone, role, actif`,
    [v.nom, v.tel, await bcrypt.hash(v.pin, 10), role]
  );
  req.app.get('io').to('admins').emit('livreurs:changement');
  res.status(201).json(r.rows[0]);
}

async function modifierCompte(req, res, role) {
  const v = await lireCompte(req.body || {}, { id: req.params.id, pinObligatoire: false });
  if (v.erreur) return res.status(400).json({ erreur: v.erreur });
  const r = v.pin
    ? await query(`UPDATE utilisateurs SET nom = $2, telephone = $3, pin_hash = $4 WHERE id = $1 AND role = '${role}' RETURNING id, nom, telephone`,
      [req.params.id, v.nom, v.tel, await bcrypt.hash(v.pin, 10)])
    : await query(`UPDATE utilisateurs SET nom = $2, telephone = $3 WHERE id = $1 AND role = '${role}' RETURNING id, nom, telephone`,
      [req.params.id, v.nom, v.tel]);
  if (!r.rows.length) return res.status(404).json({ erreur: 'Compte introuvable' });
  req.app.get('io').to('admins').emit('livreurs:changement');
  res.json(r.rows[0]);
}

router.post('/livreurs', a((req, res) => creerCompte(req, res, 'livreur')));
router.put('/livreurs/:id', a((req, res) => modifierCompte(req, res, 'livreur')));

// Supprimer un livreur : impossible pendant une course ; ses anciennes courses restent, sans nom de livreur
router.delete('/livreurs/:id', a(async (req, res) => {
  const enCours = await query(`SELECT 1 FROM courses WHERE livreur_id = $1 AND statut IN ('acceptee', 'recuperee')`, [req.params.id]);
  if (enCours.rows.length) return res.status(409).json({ erreur: 'Ce livreur a une course en cours : remettez-la en attente avant de le supprimer' });
  const s = await argent.solde(req.params.id);
  if (s) return res.status(409).json({ erreur: `Réglez d'abord son solde (${Math.abs(s).toLocaleString('fr-FR')} FCFA ${s > 0 ? 'à lui verser' : 'à reverser par lui'}) avant de le supprimer` });
  await query('UPDATE courses SET livreur_id = NULL WHERE livreur_id = $1', [req.params.id]);
  const r = await query(`DELETE FROM utilisateurs WHERE id = $1 AND role = 'livreur' RETURNING id`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ erreur: 'Livreur introuvable' });
  req.app.get('io').to('admins').emit('livreurs:changement');
  res.json({ ok: true });
}));

router.get('/admins', a(async (req, res) => {
  const r = await query(`SELECT id, nom, telephone, cree_le FROM utilisateurs WHERE role = 'admin' ORDER BY nom`);
  res.json(r.rows.map((u) => ({ ...u, moi: u.id === req.user.id })));
}));
router.post('/admins', a((req, res) => creerCompte(req, res, 'admin')));
router.put('/admins/:id', a((req, res) => modifierCompte(req, res, 'admin')));
router.delete('/admins/:id', a(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ erreur: 'Vous ne pouvez pas supprimer votre propre compte' });
  const n = (await query(`SELECT count(*)::int AS n FROM utilisateurs WHERE role = 'admin'`)).rows[0].n;
  if (n <= 1) return res.status(400).json({ erreur: 'Il faut garder au moins un administrateur' });
  const r = await query(`DELETE FROM utilisateurs WHERE id = $1 AND role = 'admin' RETURNING id`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ erreur: 'Administrateur introuvable' });
  res.json({ ok: true });
}));

// =========================================================================
// Courses : modifier, annuler, attribuer, remettre en attente, terminer, supprimer
// =========================================================================
const FINIES = ['livree', 'annulee'];
const lireStatut = async (id) => (await query('SELECT id, statut, livreur_id, paiement_statut FROM courses WHERE id = $1', [id])).rows[0];

router.put('/courses/:id', a(async (req, res) => {
  const b = req.body || {};
  const c = await lireStatut(req.params.id);
  if (!c) return res.status(404).json({ erreur: 'Course introuvable' });
  const texte = (v, max) => String(v || '').trim().slice(0, max);
  const prix = Math.round(Number(b.prix));
  if (!Number.isFinite(prix) || prix < 0) return res.status(400).json({ erreur: 'Prix invalide' });
  if (texte(b.description, 500).length < 2) return res.status(400).json({ erreur: 'Indiquez ce qu\'il faut livrer' });
  if (!texte(b.depart_repere, 300) || !texte(b.arrivee_repere, 300)) return res.status(400).json({ erreur: 'Indiquez le départ et l\'arrivée' });
  const tel = normaliserTel(b.client_tel);
  if (!tel) return res.status(400).json({ erreur: 'Numéro du client invalide' });
  const destTel = b.destinataire_tel ? normaliserTel(b.destinataire_tel) : null;
  if (b.destinataire_tel && !destTel) return res.status(400).json({ erreur: 'Numéro du destinataire invalide' });
  await query(
    `UPDATE courses SET description = $2, prix = $3, depart_repere = $4, arrivee_repere = $5,
       client_nom = $6, client_tel = $7, destinataire_nom = $8, destinataire_tel = $9 WHERE id = $1`,
    [req.params.id, texte(b.description, 500), prix, texte(b.depart_repere, 300), texte(b.arrivee_repere, 300),
      texte(b.client_nom, 100) || 'Client', tel, texte(b.destinataire_nom, 100) || null, destTel]
  );
  res.json(await diffuserMaj(req.app.get('io'), req.params.id, { notifierClient: false }));
}));

router.post('/courses/:id/annuler', a(async (req, res) => {
  const c = await lireStatut(req.params.id);
  if (!c) return res.status(404).json({ erreur: 'Course introuvable' });
  if (FINIES.includes(c.statut)) return res.status(400).json({ erreur: 'Cette course est déjà terminée' });
  await query(`UPDATE courses SET statut = 'annulee', annulee_le = now() WHERE id = $1`, [req.params.id]);
  const course = await diffuserMaj(req.app.get('io'), req.params.id, { message: 'Votre livraison a été annulée par Thiak Thiak Dialaw. Appelez-nous pour plus d\'informations.' });
  res.json({ ...course, a_rembourser: c.paiement_statut === 'paye' });
}));

// Remettre en attente : le livreur est retiré et les autres livreurs sont de nouveau prévenus
router.post('/courses/:id/liberer', a(async (req, res) => {
  const c = await lireStatut(req.params.id);
  if (!c) return res.status(404).json({ erreur: 'Course introuvable' });
  if (!['acceptee', 'recuperee'].includes(c.statut)) return res.status(400).json({ erreur: 'Seule une course en cours peut être remise en attente' });
  await query(`UPDATE courses SET statut = 'en_attente', livreur_id = NULL, acceptee_le = NULL, recuperee_le = NULL WHERE id = $1`, [req.params.id]);
  const io = req.app.get('io');
  const course = await diffuserMaj(io, req.params.id, { message: 'Nous cherchons un autre livreur pour votre livraison.' });
  io.to('user:' + c.livreur_id).emit('course:maj', course); // l'ancien livreur voit la course disparaître
  await notifierNouvelleCourse(io, course);
  res.json(course);
}));

// Attribuer (ou réattribuer) une course à un livreur précis
router.post('/courses/:id/attribuer', a(async (req, res) => {
  const livreurId = Number((req.body || {}).livreur_id);
  const c = await lireStatut(req.params.id);
  if (!c) return res.status(404).json({ erreur: 'Course introuvable' });
  if (!['en_attente', 'acceptee'].includes(c.statut)) return res.status(400).json({ erreur: 'Cette course ne peut plus changer de livreur' });
  const l = (await query(`SELECT id, actif FROM utilisateurs WHERE id = $1 AND role = 'livreur'`, [livreurId])).rows[0];
  if (!l || !l.actif) return res.status(400).json({ erreur: 'Choisissez un livreur validé' });
  const occupe = await query(`SELECT 1 FROM courses WHERE livreur_id = $1 AND statut IN ('acceptee', 'recuperee') AND id <> $2`, [livreurId, req.params.id]);
  if (occupe.rows.length) return res.status(409).json({ erreur: 'Ce livreur a déjà une course en cours' });
  await query(`UPDATE courses SET statut = 'acceptee', livreur_id = $2, acceptee_le = now() WHERE id = $1`, [req.params.id, livreurId]);
  const io = req.app.get('io');
  const course = await diffuserMaj(io, req.params.id);
  if (c.livreur_id && c.livreur_id !== livreurId) io.to('user:' + c.livreur_id).emit('course:maj', course);
  await push.envoyer([livreurId], {
    titre: 'Course attribuée par l\'administrateur', corps: `${course.depart_repere} → ${course.arrivee_repere}`,
    url: '/livreur.html', tag: 'course-' + course.id, urgent: true,
  });
  res.json(course);
}));

// Marquer livrée (correction quand le livreur a oublié de confirmer)
router.post('/courses/:id/terminer', a(async (req, res) => {
  const c = await lireStatut(req.params.id);
  if (!c) return res.status(404).json({ erreur: 'Course introuvable' });
  if (!['acceptee', 'recuperee'].includes(c.statut)) return res.status(400).json({ erreur: 'Seule une course en cours peut être marquée livrée' });
  await query(`UPDATE courses SET statut = 'livree', livree_le = now(), recuperee_le = coalesce(recuperee_le, now()) WHERE id = $1`, [req.params.id]);
  await argent.inscrireCoursesLivrees(Number(req.params.id));
  res.json(await diffuserMaj(req.app.get('io'), req.params.id));
}));

// Paiement en ligne : vérifier chez Nangu, ou valider à la main
const paiements = require('../paiements');
const erreurPaiement = (res, e) => res.status(e.status || 502).json({ erreur: e.status ? e.message : 'Nangu ne répond pas : ' + e.message });

router.post('/courses/:id/rapprocher', a(async (req, res) => {
  try {
    const r = await paiements.rapprocher(req.app.get('io'), req.params.id);
    const { lireCourse } = require('../courses-service');
    res.json({ ...r, course: await lireCourse(req.params.id) });
  } catch (e) { erreurPaiement(res, e); }
}));

router.post('/courses/:id/valider-paiement', a(async (req, res) => {
  try {
    res.json(await paiements.validerManuellement(req.app.get('io'), req.params.id, { adminId: req.user.id, reference: (req.body || {}).reference }));
  } catch (e) { erreurPaiement(res, e); }
}));

router.delete('/courses/:id', a(async (req, res) => {
  const c = await lireStatut(req.params.id);
  if (!c) return res.status(404).json({ erreur: 'Course introuvable' });
  if (['acceptee', 'recuperee'].includes(c.statut)) return res.status(409).json({ erreur: 'Course en cours : annulez-la ou remettez-la en attente avant de la supprimer' });
  await query('DELETE FROM courses WHERE id = $1', [req.params.id]);
  req.app.get('io').to(['livreurs', 'admins']).emit('courses:changement');
  res.json({ ok: true });
}));

module.exports = router;
