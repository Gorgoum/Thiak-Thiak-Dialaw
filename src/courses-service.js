const { query } = require('./db');
const push = require('./push');
const { parametres, distanceKm, peutFaire } = require('./tarifs');

// Colonnes exposées : jamais le code de suivi ni l'abonnement push du client
const COLONNES = `c.id, c.client_nom, c.client_tel, c.livreur_id, c.type, c.description, c.montant_achat,
  c.depart_lat, c.depart_lng, c.depart_repere, c.arrivee_lat, c.arrivee_lng, c.arrivee_repere,
  c.destinataire_nom, c.destinataire_tel, c.distance_km, c.prix, c.paiement, c.paiement_statut, c.montant_du, c.paye_le, c.statut, c.note,
  c.cree_le, c.acceptee_le, c.recuperee_le, c.livree_le, c.annulee_le,
  c.service, c.vehicule, c.arrive_le, c.frais_service, c.frais_achat, c.rembourse_le, c.rembourse_montant, c.rembourse_ref`;

const SELECT_COURSE = `
  SELECT ${COLONNES}, l.nom AS livreur_nom, l.telephone AS livreur_tel, l.vehicule AS livreur_vehicule, l.plaque AS livreur_plaque, l.modele AS livreur_modele,
         CASE WHEN c.statut IN ('acceptee', 'recuperee') THEN l.lat END AS livreur_lat,
         CASE WHEN c.statut IN ('acceptee', 'recuperee') THEN l.lng END AS livreur_lng
  FROM courses c
  LEFT JOIN utilisateurs l ON l.id = c.livreur_id`;

async function lireCourse(id) {
  const r = await query(SELECT_COURSE + ' WHERE c.id = $1', [id]);
  return r.rows[0];
}

const fcfa = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';

/** Prévient les livreurs disponibles dans le rayon (ou sans position connue) d'une nouvelle course. */
async function notifierNouvelleCourse(io, course) {
  const p = await parametres();
  const r = await query(`SELECT id, lat, lng, vehicule FROM utilisateurs WHERE role = 'livreur' AND actif AND disponible`);
  const depart = { lat: course.depart_lat, lng: course.depart_lng };
  const trajet = course.service === 'trajet';
  const cibles = r.rows
    .filter((l) => !trajet || peutFaire(l.vehicule, course.vehicule)) // chaque gamme à ses chauffeurs
    .filter((l) => l.lat == null || distanceKm(depart, l) <= (p.rayon_km || 10))
    .map((l) => l.id);

  io.to(['livreurs', 'admins']).emit('courses:changement');
  await push.envoyer(cibles, {
    titre: `${trajet ? `Nouveau trajet en ${course.vehicule}` : 'Nouvelle livraison'} · ${fcfa(course.prix)}`,
    corps: `${course.depart_repere} → ${course.arrivee_repere}`,
    url: '/livreur.html',
    tag: 'course-' + course.id,
    urgent: true,
  });
}

const MESSAGES_CLIENT = {
  acceptee: (c) => (c.service === 'trajet'
    ? `${c.livreur_nom} a accepté votre course et arrive vous chercher${c.livreur_plaque ? ` (${c.livreur_modele || c.vehicule}, ${c.livreur_plaque})` : ''}.`
    : `${c.livreur_nom} a accepté votre livraison et arrive au point de départ.`),
  recuperee: (c) => (c.service === 'trajet' ? 'Bonne route ! Votre course a commencé.' : 'Votre colis a été récupéré, il est en route.'),
  livree: (c) => (c.service === 'trajet' ? 'Vous êtes arrivé. Merci d\'avoir voyagé avec Yobalema Yène !' : 'Livraison terminée. Merci d\'avoir utilisé Yobalema Yène !'),
  en_attente: (c) => (c.service === 'trajet' ? 'Le chauffeur s\'est désisté, nous cherchons un autre chauffeur.' : 'Le livreur s\'est désisté, nous cherchons un autre livreur.'),
};

/** Diffuse un changement de statut au client (salle de suivi), au livreur, aux autres livreurs et aux admins. */
async function diffuserMaj(io, id, { notifierClient = true, message = null, paiementRecu = false, titre = null, suffixe = '', urgent = false } = {}) {
  const c = await lireCourse(id);
  if (!c) return;
  const prive = (await query('SELECT suivi_token, abonnement_push FROM courses WHERE id = $1', [id])).rows[0];

  io.to('suivi:' + prive.suivi_token).emit('course:maj', c);
  if (c.livreur_id) io.to('user:' + c.livreur_id).emit('course:maj', c);
  io.to(['livreurs', 'admins']).emit('courses:changement');

  const msg = message ? () => message : MESSAGES_CLIENT[c.statut];
  if (notifierClient && msg && prive.abonnement_push) {
    // Paiement reçu : l'alerte sert de retour (même adresse que le return_url de Nangu) et reste affichée jusqu'au toucher
    const valide = await push.envoyerA(prive.abonnement_push, paiementRecu ? {
      titre: 'Paiement reçu ✓',
      corps: 'Touchez pour revenir à votre livraison. Nous cherchons un livreur.',
      url: '/retour-paiement/' + prive.suivi_token,
      tag: 'suivi-' + c.id,
      urgent: true,
    } : {
      titre: titre || 'Yobalema Yène',
      corps: msg(c),
      url: '/?suivi=' + prive.suivi_token + suffixe, // suffixe : « &payer=1 » ouvre l'écran de paiement
      tag: 'suivi-' + c.id,
      urgent,
    });
    if (!valide) await query('UPDATE courses SET abonnement_push = NULL WHERE id = $1', [id]);
  }
  return c;
}

/** Message d'excuse au client : course annulée faute de chauffeur, et remboursement s'il avait payé. */
function messageExcuse(course, rembourse = null) {
  const trajet = course.service === 'trajet';
  const moyen = course.paiement === 'orange_money' ? 'Orange Money' : 'Wave';
  const montant = rembourse ?? (course.paiement_statut === 'paye' ? (course.montant_du || course.prix) : null);
  const fcfa = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';
  return `Nous sommes désolés : aucun${trajet ? 'e voiture n\'est disponible' : ' livreur n\'est disponible'} pour le moment, votre ${trajet ? 'course' : 'livraison'} est annulée.`
    + (montant ? ` Votre paiement de ${fcfa(montant)} vous ${rembourse != null ? 'a été remboursé' : 'sera remboursé'} par ${moyen}.` : '')
    + ' Merci de votre compréhension. Yobalema Yène';
}

module.exports = { messageExcuse, SELECT_COURSE, lireCourse, notifierNouvelleCourse, diffuserMaj };
