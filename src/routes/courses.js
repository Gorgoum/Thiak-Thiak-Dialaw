// Routes publiques côté client : pas de compte, le client est identifié par le code de suivi de sa course
const crypto = require('crypto');
const router = require('express').Router();
const { query } = require('../db');
const { normaliserTel, a } = require('../auth');
const { devis, pointValide, distanceKm, fraisAchat, parametres, chauffeursProches } = require('../tarifs');
const { SELECT_COURSE, lireCourse, notifierNouvelleCourse, diffuserMaj } = require('../courses-service');
const nangu = require('../nangu');
const paiements = require('../paiements');

const texte = (v, max = 300) => String(v || '').trim().slice(0, max);
const nouveauCode = () => crypto.randomBytes(16).toString('base64url');

// Anti-abus : au plus 10 demandes par heure par adresse IP, et une seule commande en cours par numéro
const demandesParIp = new Map();
const MAX_PAR_HEURE = 10;
const MSG_DEJA_EN_COURS = "Vous avez déjà une commande en cours. Attendez qu'elle soit terminée, ou annulez-la, avant d'en passer une autre.";
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
  const d = await devis(depart, arrivee);
  // chauffeurs libres autour du départ (sans course en cours) : temps d'arrivée affiché sur chaque choix
  const occupes = new Set((await query("SELECT livreur_id FROM courses WHERE statut IN ('acceptee', 'recuperee') AND livreur_id IS NOT NULL")).rows.map((x) => x.livreur_id));
  const libres = (await query("SELECT id, lat, lng, vehicule, position_maj FROM utilisateurs WHERE role = 'livreur' AND actif AND disponible")).rows.filter((l) => !occupes.has(l.id));
  res.json({ ...d, chauffeurs: chauffeursProches(depart, libres, await parametres()) });
}));

// Accueil : chauffeurs libres autour du client (« Courses · à partir de 3 min »)
router.get('/chauffeurs-proches', a(async (req, res) => {
  const pt = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
  if (!pointValide(pt)) return res.status(400).json({ erreur: 'Position invalide' });
  const occupes = new Set((await query("SELECT livreur_id FROM courses WHERE statut IN ('acceptee', 'recuperee') AND livreur_id IS NOT NULL")).rows.map((x) => x.livreur_id));
  const libres = (await query("SELECT id, lat, lng, vehicule, position_maj FROM utilisateurs WHERE role = 'livreur' AND actif AND disponible")).rows.filter((l) => !occupes.has(l.id));
  res.json(chauffeursProches(pt, libres, await parametres()));
}));

router.post('/', a(async (req, res) => {
  const b = req.body || {};
  // commande de plats depuis le site d'un restaurant partenaire : le départ est le restaurant (pas ce qu'envoie le téléphone)
  let resto = null;
  if (b.restaurant) {
    resto = (await query('SELECT id, nom, adresse, lat, lng FROM restaurants WHERE code = $1 AND actif', [texte(b.restaurant, 40)])).rows[0];
    if (!resto) return res.status(400).json({ erreur: 'Ce restaurant ne prend pas de commandes pour le moment' });
    b.depart = { lat: Number(resto.lat), lng: Number(resto.lng) };
    b.depart_repere = resto.adresse ? `${resto.nom} · ${resto.adresse}` : resto.nom;
    b.service = 'livraison';
    b.type = 'achat';
  }
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
  // service : livraison d'un colis, ou trajet d'une personne (moto ou voiture)
  const service = b.service === 'trajet' ? 'trajet' : 'livraison';
  const vehicule = service === 'trajet' && ['voiture', 'confort'].includes(b.vehicule) ? b.vehicule : 'moto';
  const note = texte(b.description, 200);
  const description = service === 'trajet' ? `Trajet ${{ moto: 'à moto', voiture: 'Éco (voiture)', confort: 'Confort (voiture climatisée)' }[vehicule]}${note ? ' · ' + note : ''}` : texte(b.description, 500);
  if (!departRepere || !arriveeRepere) return res.status(400).json({ erreur: 'Indiquez un repère pour le départ et l\'arrivée' });
  if (!description) return res.status(400).json({ erreur: 'Décrivez ce qu\'il faut livrer' });

  const type = service === 'livraison' && b.type === 'achat' ? 'achat' : 'colis';
  const montantAchat = type === 'achat' ? Math.max(0, Math.round(Number(b.montant_achat) || 0)) : 0;
  let destTel = null;
  if (b.destinataire_tel) {
    destTel = normaliserTel(b.destinataire_tel);
    if (!destTel) return res.status(400).json({ erreur: 'Numéro du destinataire invalide' });
  }

  // une seule commande à la fois par numéro : en attente, à payer, acceptée ou en route
  const enCours = await query(`SELECT id FROM courses WHERE client_tel = $1 AND statut IN ('attente_paiement', 'en_attente', 'acceptee', 'recuperee') LIMIT 1`, [clientTel]);
  if (enCours.rows.length) return res.status(409).json({ erreur: MSG_DEJA_EN_COURS, course_en_cours: enCours.rows[0].id });
  if (tropDeDemandes(req.ip)) return res.status(429).json({ erreur: 'Trop de demandes. Réessayez dans une heure.' });

  // Le prix est toujours recalculé côté serveur
  // Moyen de paiement : espèces, ou en ligne avec Nangu si le fournisseur est disponible
  const paiement = ['wave', 'orange_money'].includes(b.paiement) ? b.paiement : 'especes';
  if (paiement !== 'especes' && !nangu.fournisseurs().includes(paiement)) {
    return res.status(400).json({ erreur: 'Ce moyen de paiement n\'est pas disponible. Choisissez les espèces.' });
  }
  const enLigne = paiement !== 'especes';

  const d = await devis(b.depart, b.arrivee);
  const fAchat = type === 'achat' ? fraisAchat(montantAchat, await parametres()) : 0;
  const code = nouveauCode();
  const r = await query(
    `INSERT INTO courses (client_nom, client_tel, suivi_token, type, description, montant_achat,
       depart_lat, depart_lng, depart_repere, arrivee_lat, arrivee_lng, arrivee_repere,
       destinataire_nom, destinataire_tel, distance_km, prix, paiement, paiement_statut, statut, service, vehicule, frais_service, frais_achat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
    [clientNom, clientTel, code, type, description, montantAchat,
      b.depart.lat, b.depart.lng, departRepere, b.arrivee.lat, b.arrivee.lng, arriveeRepere,
      texte(b.destinataire_nom, 100) || null, destTel, d.distance_km, (service !== 'trajet' ? d.prix : vehicule === 'confort' ? d.prix_confort : vehicule === 'voiture' ? d.prix_voiture : d.prix) + fAchat,
      // paiement en ligne : rien à payer tant qu'aucun livreur n'a accepté (le paiement est créé à l'acceptation)
      paiement, enLigne ? 'en_attente' : 'a_la_livraison', 'en_attente', service, vehicule, d.frais_service || 0, fAchat]
  );
  const id = r.rows[0].id;
  if (resto) await query('UPDATE courses SET restaurant_id = $2 WHERE id = $1', [id, resto.id]);
  const course = await lireCourse(id);
  notifierNouvelleCourse(req.app.get('io'), course).catch((e) => console.error('Notification :', e.message));
  res.status(201).json({ ...course, suivi_token: code });
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

// Annulation par le client : possible tant qu'il n'a rien payé
// (y compris quand un livreur a accepté une course à payer en ligne et attend le paiement).
// Une course déjà payée ne s'annule plus ici : l'argent est sur le compte de la plateforme, c'est l'admin qui rembourse.
router.post('/suivi/:code/annuler', a(async (req, res) => {
  const avant = (await query('SELECT id, statut, paiement, paiement_statut, livreur_id FROM courses WHERE suivi_token = $1', [String(req.params.code)])).rows[0];
  if (!avant) return res.status(404).json({ erreur: 'Course introuvable' });
  if (avant.paiement_statut === 'paye' && !['livree', 'annulee'].includes(avant.statut)) {
    return res.status(409).json({ erreur: 'Cette commande est déjà payée : pour l\'annuler et être remboursé, appelez Yobalema Yène.' });
  }
  const r = await query(
    `UPDATE courses SET statut = 'annulee', annulee_le = now(),
       paiement_statut = CASE WHEN paiement_statut = 'en_attente' THEN 'annule' ELSE paiement_statut END
     WHERE suivi_token = $1 AND paiement_statut <> 'paye'
       AND (statut IN ('en_attente', 'attente_paiement') OR (statut = 'acceptee' AND paiement <> 'especes'))
     RETURNING id, nangu_id, paiement_statut`,
    [req.params.code]
  );
  if (!r.rows.length) return res.status(409).json({ erreur: 'Cette course ne peut plus être annulée (déjà prise par un livreur)' });
  const { id, nangu_id: nanguId, paiement_statut: etat } = r.rows[0];
  // paiement en ligne pas encore fait : on l'annule aussi chez Nangu (le lien ne marchera plus)
  if (nanguId && etat === 'annule') nangu.annulerPaiement(nanguId).catch((e) => console.error('Annulation Nangu :', e.message));
  const course = await diffuserMaj(req.app.get('io'), id, { notifierClient: false });
  // le livreur qui attendait le paiement est libéré et prévenu
  if (avant.statut === 'acceptee' && avant.livreur_id) {
    req.app.get('io').to('user:' + avant.livreur_id).emit('course:maj', course);
    require('../push').envoyer([avant.livreur_id], { titre: 'Course annulée', corps: 'Le client a annulé avant de payer. Vous êtes libre pour une autre course.', url: '/livreur.html' })
      .catch(() => {});
  }
  res.json(course);
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
  // le destinataire d'un colis a sa propre place : il ne remplace pas les notifications du client
  const colonne = req.body.role === 'destinataire' ? 'abonnement_dest' : 'abonnement_push';
  await query(`UPDATE courses SET ${colonne} = $2 WHERE id = $1`, [id, ab]);
  res.json({ ok: true });
}));

module.exports = router;
