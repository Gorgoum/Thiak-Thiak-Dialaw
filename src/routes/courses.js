// Routes publiques côté client : pas de compte, le client est identifié par le code de suivi de sa course
const crypto = require('crypto');
const router = require('express').Router();
const { query } = require('../db');
const { normaliserTel, a } = require('../auth');
const { devis, pointValide, distanceKm } = require('../tarifs');
const { SELECT_COURSE, lireCourse, notifierNouvelleCourse, diffuserMaj } = require('../courses-service');
const nangu = require('../nangu');
const paiements = require('../paiements');

const texte = (v, max = 300) => String(v || '').trim().slice(0, max);
const nouveauCode = () => crypto.randomBytes(16).toString('base64url');

// Anti-abus : au plus 10 demandes par heure par adresse IP, et 3 courses en attente par numéro
const demandesParIp = new Map();
const MAX_PAR_HEURE = 10;
const MAX_EN_ATTENTE_PAR_TEL = 3;
function tropDeDemandes(ip) {
  const maintenant = Date.now();
  const liste = (demandesParIp.get(ip) || []).filter((t) => maintenant - t < 3600 * 1000);
  if (liste.length >= MAX_PAR_HEURE) { demandesParIp.set(ip, liste); return true; }
  liste.push(maintenant);
  demandesParIp.set(ip, liste);
  return false;
}

router.post('/devis', a(async (req, res) => {
  const { depart, arrivee } = req.body || {};
  if (!pointValide(depart) || !pointValide(arrivee)) return res.status(400).json({ erreur: 'Points invalides' });
  res.json(await devis(depart, arrivee));
}));

router.post('/', a(async (req, res) => {
  const b = req.body || {};
  const clientNom = texte(b.client_nom, 100);
  const clientTel = normaliserTel(b.client_tel);
  if (clientNom.length < 2) return res.status(400).json({ erreur: 'Indiquez votre nom' });
  if (!clientTel) return res.status(400).json({ erreur: 'Votre numéro est invalide (ex : 77 123 45 67)' });
  if (!pointValide(b.depart) || !pointValide(b.arrivee)) {
    return res.status(400).json({ erreur: 'Placez le départ et l\'arrivée sur la carte' });
  }
  if (distanceKm(b.depart, b.arrivee) < 0.03) {
    return res.status(400).json({ erreur: 'Le départ et l\'arrivée sont au même endroit' });
  }
  const departRepere = texte(b.depart_repere);
  const arriveeRepere = texte(b.arrivee_repere);
  const description = texte(b.description, 500);
  if (!departRepere || !arriveeRepere) return res.status(400).json({ erreur: 'Indiquez un repère pour le départ et l\'arrivée' });
  if (!description) return res.status(400).json({ erreur: 'Décrivez ce qu\'il faut livrer' });

  const type = b.type === 'achat' ? 'achat' : 'colis';
  const montantAchat = type === 'achat' ? Math.max(0, Math.round(Number(b.montant_achat) || 0)) : 0;
  let destTel = null;
  if (b.destinataire_tel) {
    destTel = normaliserTel(b.destinataire_tel);
    if (!destTel) return res.status(400).json({ erreur: 'Numéro du destinataire invalide' });
  }

  const enAttente = await query(`SELECT id FROM courses WHERE client_tel = $1 AND statut IN ('en_attente', 'attente_paiement')`, [clientTel]);
  if (enAttente.rows.length >= MAX_EN_ATTENTE_PAR_TEL) {
    return res.status(429).json({ erreur: 'Vous avez déjà 3 demandes en attente. Patientez ou annulez-en une.' });
  }
  if (tropDeDemandes(req.ip)) return res.status(429).json({ erreur: 'Trop de demandes. Réessayez dans une heure.' });

  // Le prix est toujours recalculé côté serveur
  // Moyen de paiement : espèces, ou en ligne avec Nangu si le fournisseur est disponible
  const paiement = ['wave', 'orange_money'].includes(b.paiement) ? b.paiement : 'especes';
  if (paiement !== 'especes' && !nangu.fournisseurs().includes(paiement)) {
    return res.status(400).json({ erreur: 'Ce moyen de paiement n\'est pas disponible. Choisissez les espèces.' });
  }
  const enLigne = paiement !== 'especes';

  const d = await devis(b.depart, b.arrivee);
  const code = nouveauCode();
  const r = await query(
    `INSERT INTO courses (client_nom, client_tel, suivi_token, type, description, montant_achat,
       depart_lat, depart_lng, depart_repere, arrivee_lat, arrivee_lng, arrivee_repere,
       destinataire_nom, destinataire_tel, distance_km, prix, paiement, paiement_statut, statut)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [clientNom, clientTel, code, type, description, montantAchat,
      b.depart.lat, b.depart.lng, departRepere, b.arrivee.lat, b.arrivee.lng, arriveeRepere,
      texte(b.destinataire_nom, 100) || null, destTel, d.distance_km, d.prix,
      paiement, enLigne ? 'en_attente' : 'a_la_livraison', enLigne ? 'attente_paiement' : 'en_attente']
  );
  const id = r.rows[0].id;

  if (!enLigne) {
    const course = await lireCourse(id);
    notifierNouvelleCourse(req.app.get('io'), course).catch((e) => console.error('Notification :', e.message));
    return res.status(201).json({ ...course, suivi_token: code });
  }

  // Paiement en ligne : la course reste invisible des livreurs jusqu'à la confirmation du paiement
  try {
    const p = await nangu.creerPaiement({ id, suivi: code, prix: d.prix, client_tel: clientTel, depart_repere: departRepere, arrivee_repere: arriveeRepere }, paiement);
    const infos = nangu.infosPaiement(p);
    await query('UPDATE courses SET nangu_id = $2, montant_du = $3, paiement_infos = $4 WHERE id = $1', [id, p.id, p.amount_due, infos]);
    const course = await lireCourse(id);
    return res.status(201).json({ ...course, suivi_token: code, paiement_infos: infos });
  } catch (e) {
    await query(`UPDATE courses SET statut = 'annulee', paiement_statut = 'annule', annulee_le = now() WHERE id = $1`, [id]);
    console.error('Création du paiement Nangu :', e.message);
    return res.status(502).json({ erreur: `Paiement ${paiement === 'wave' ? 'Wave' : 'Orange Money'} indisponible pour le moment (${e.message}). Réessayez ou choisissez les espèces.` });
  }
}));

// État du paiement en ligne d'une course (pour l'écran de paiement du client)
router.get('/suivi/:code/paiement', a(async (req, res) => {
  const lire = () => query(
    'SELECT id, statut, paiement, paiement_statut, nangu_id, montant_du, paiement_infos FROM courses WHERE suivi_token = $1',
    [String(req.params.code)]
  ).then((r) => r.rows[0]);
  let c = await lire();
  if (!c) return res.status(404).json({ erreur: 'Course introuvable' });
  if (c.paiement_statut === 'en_attente' && c.nangu_id) {
    // secours au webhook : relecture chez Nangu (avec la clé secrète, côté serveur)
    await paiements.synchroniser(req.app.get('io'), c.nangu_id);
    c = await lire();
  }
  res.json({
    statut: c.statut, paiement: c.paiement, paiement_statut: c.paiement_statut,
    montant_du: c.montant_du, infos: c.paiement_infos,
  });
}));

// Suivi de plusieurs courses à la fois : ?codes=a,b,c (codes gardés sur le téléphone du client)
router.get('/suivi', a(async (req, res) => {
  const codes = String(req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
  if (!codes.length) return res.json([]);
  const marques = codes.map((_, i) => '$' + (i + 1)).join(', ');
  const r = await query(
    SELECT_COURSE.replace('SELECT ', 'SELECT c.suivi_token, ') + ` WHERE c.suivi_token IN (${marques}) ORDER BY c.cree_le DESC`,
    codes
  );
  res.json(r.rows);
}));

/** Retrouve l'id d'une course à partir de son code de suivi. */
async function idDepuisCode(code) {
  const r = await query('SELECT id FROM courses WHERE suivi_token = $1', [String(code)]);
  return r.rows[0] && r.rows[0].id;
}

router.post('/suivi/:code/annuler', a(async (req, res) => {
  const r = await query(
    `UPDATE courses SET statut = 'annulee', annulee_le = now(),
       paiement_statut = CASE WHEN paiement_statut = 'en_attente' THEN 'annule' ELSE paiement_statut END
     WHERE suivi_token = $1 AND statut IN ('en_attente', 'attente_paiement')
     RETURNING id, nangu_id, paiement_statut`,
    [req.params.code]
  );
  if (!r.rows.length) return res.status(409).json({ erreur: 'Cette course ne peut plus être annulée (déjà prise par un livreur)' });
  const { id, nangu_id: nanguId, paiement_statut: etat } = r.rows[0];
  // paiement en ligne pas encore fait : on l'annule aussi chez Nangu (le lien ne marchera plus)
  if (nanguId && etat === 'annule') nangu.annulerPaiement(nanguId).catch((e) => console.error('Annulation Nangu :', e.message));
  res.json(await diffuserMaj(req.app.get('io'), id, { notifierClient: false }));
}));

router.post('/suivi/:code/noter', a(async (req, res) => {
  const note = Number(req.body && req.body.note);
  if (!Number.isInteger(note) || note < 1 || note > 5) return res.status(400).json({ erreur: 'Note entre 1 et 5' });
  const r = await query(
    `UPDATE courses SET note = $2 WHERE suivi_token = $1 AND statut = 'livree' RETURNING id`,
    [req.params.code, note]
  );
  if (!r.rows.length) return res.status(409).json({ erreur: 'Seule une course livrée peut être notée' });
  res.json(await lireCourse(r.rows[0].id));
}));

// Le client reçoit les notifications de sa course sans compte
router.post('/suivi/:code/push', a(async (req, res) => {
  const ab = req.body && req.body.abonnement;
  if (!ab || !ab.endpoint || !ab.keys) return res.status(400).json({ erreur: 'Abonnement invalide' });
  const id = await idDepuisCode(req.params.code);
  if (!id) return res.status(404).json({ erreur: 'Course introuvable' });
  await query('UPDATE courses SET abonnement_push = $2 WHERE id = $1', [id, ab]);
  res.json({ ok: true });
}));

module.exports = router;
