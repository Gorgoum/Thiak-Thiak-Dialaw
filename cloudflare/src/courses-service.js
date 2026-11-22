// Lecture des courses et diffusion des changements (temps réel + notifications).
import { envoyer, envoyerA } from './push.js';
import { parametres, distanceKm, peutFaire } from './tarifs.js';

const COLONNES = `c.id, c.client_nom, c.client_tel, c.livreur_id, c.type, c.description, c.montant_achat,
  c.depart_lat, c.depart_lng, c.depart_repere, c.arrivee_lat, c.arrivee_lng, c.arrivee_repere,
  c.destinataire_nom, c.destinataire_tel, c.distance_km, c.prix, c.paiement, c.paiement_statut, c.montant_du, c.paye_le,
  c.statut, c.note, c.cree_le, c.acceptee_le, c.recuperee_le, c.livree_le, c.annulee_le,
  c.service, c.vehicule, c.arrive_le, c.frais_service, c.frais_achat, c.rembourse_le, c.rembourse_montant, c.rembourse_ref,
  c.restaurant_id, c.plats_prets_le`;

export const SELECT_COURSE = `
  SELECT ${COLONNES}, l.nom AS livreur_nom, l.telephone AS livreur_tel, l.vehicule AS livreur_vehicule, l.plaque AS livreur_plaque, l.modele AS livreur_modele,
         CASE WHEN c.statut IN ('acceptee', 'recuperee') THEN l.lat END AS livreur_lat,
         CASE WHEN c.statut IN ('acceptee', 'recuperee') THEN l.lng END AS livreur_lng
         , rs.nom AS restaurant_nom
  FROM courses c
  LEFT JOIN utilisateurs l ON l.id = c.livreur_id
  LEFT JOIN restaurants rs ON rs.id = c.restaurant_id`;

/** Message d'excuse au client : course annulée faute de chauffeur, et remboursement s'il avait payé. */
export function messageExcuse(course, rembourse = null) {
  const trajet = course.service === 'trajet';
  const moyen = course.paiement === 'orange_money' ? 'Orange Money' : 'Wave';
  const montant = rembourse ?? (course.paiement_statut === 'paye' ? (course.montant_du || course.prix) : null);
  const fcfa = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';
  return `Nous sommes désolés : aucun${trajet ? 'e voiture n\'est disponible' : ' livreur n\'est disponible'} pour le moment, votre ${trajet ? 'course' : 'livraison'} est annulée.`
    + (montant ? ` Votre paiement de ${fcfa(montant)} vous ${rembourse != null ? 'a été remboursé' : 'sera remboursé'} par ${moyen}.` : '')
    + ' Merci de votre compréhension. Yobalema Yène';
}

export async function lireCourse(c, id) {
  return (await c.db.query(SELECT_COURSE + ' WHERE c.id = $1', [id])).rows[0];
}

const fcfa = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';

export async function notifierNouvelleCourse(c, course) {
  const p = await parametres(c.db);
  const r = await c.db.query(`SELECT id, lat, lng, vehicule FROM utilisateurs WHERE role = 'livreur' AND actif = 1 AND disponible = 1`);
  const depart = { lat: course.depart_lat, lng: course.depart_lng };
  const trajet = course.service === 'trajet';
  const cibles = r.rows
    .filter((l) => !trajet || peutFaire(l.vehicule, course.vehicule)) // chaque gamme à ses chauffeurs
    .filter((l) => l.lat == null || distanceKm(depart, l) * (p.facteur_route || 1.3) <= (p.rayon_km || 10)).map((l) => l.id);
  c.io.to(['livreurs', 'admins']).emit('courses:changement');
  await envoyer(c, cibles, {
    titre: `${trajet ? `Nouveau trajet en ${course.vehicule}` : 'Nouvelle livraison'} · ${fcfa(course.prix)}`,
    corps: `${course.depart_repere} → ${course.arrivee_repere}`,
    url: '/livreur.html',
    tag: 'course-' + course.id,
    urgent: true,
  });
}

const MESSAGES_CLIENT = {
  acceptee: (x) => (x.service === 'trajet'
    ? `${x.livreur_nom} a accepté votre course et arrive vous chercher${x.livreur_plaque ? ` (${x.livreur_modele || x.vehicule}, ${x.livreur_plaque})` : ''}.`
    : `${x.livreur_nom} a accepté votre livraison et arrive au point de départ.`),
  recuperee: (x) => (x.service === 'trajet' ? 'Bonne route ! Votre course a commencé.' : 'Votre colis a été récupéré, il est en route.'),
  livree: (x) => (x.service === 'trajet' ? 'Vous êtes arrivé. Merci d\'avoir voyagé avec Yobalema Yène !' : 'Livraison terminée. Merci d\'avoir utilisé Yobalema Yène !'),
  en_attente: (x) => (x.service === 'trajet' ? 'Le chauffeur s\'est désisté, nous cherchons un autre chauffeur.' : 'Le livreur s\'est désisté, nous cherchons un autre livreur.'),
};


/** Messages au destinataire d'un colis (il n'a pas commandé : on lui dit qui envoie). */
const MESSAGES_DEST = {
  acceptee: (c) => `Un livreur a pris en charge le colis que ${c.client_nom || 'quelqu\'un'} vous envoie.`,
  recuperee: (c) => `Votre colis est en route${c.client_nom ? ` (envoyé par ${c.client_nom})` : ''}.`,
  livree: () => 'Votre colis a été livré. Bonne journée !',
  annulee: () => 'La livraison de votre colis a été annulée.',
};

/** Notification au destinataire d'un colis, s'il a ouvert son lien de suivi et accepté les notifications. */
export async function prevenirDestinataire(c, id, corps, titre = 'Votre colis Yobalema') {
  const x = (await c.db.query('SELECT suivi_token, abonnement_dest FROM courses WHERE id = $1', [id])).rows[0];
  if (!x || !x.abonnement_dest) return false;
  const ok = await envoyerA(c.env, x.abonnement_dest, { titre, corps, url: '/?suivi=' + x.suivi_token + '&pour=destinataire', tag: 'colis-' + id, urgent: true });
  if (!ok) await c.db.query('UPDATE courses SET abonnement_dest = NULL WHERE id = $1', [id]);
  return ok;
}

export async function diffuserMaj(c, id, { notifierClient = true, message = null, paiementRecu = false, titre = null, suffixe = '', urgent = false, notifierDest = true } = {}) {
  const course = await lireCourse(c, id);
  if (!course) return null;
  const prive = (await c.db.query('SELECT suivi_token, abonnement_push FROM courses WHERE id = $1', [id])).rows[0];
  c.io.to('suivi:' + prive.suivi_token).emit('course:maj', course);
  if (course.livreur_id) c.io.to('user:' + course.livreur_id).emit('course:maj', course);
  c.io.to(['livreurs', 'admins']).emit('courses:changement');

  const msg = message ? () => message : MESSAGES_CLIENT[course.statut];
  if (notifierClient && msg && prive.abonnement_push) {
    // Paiement reçu : l'alerte sert de retour (même adresse que le return_url de Nangu) et reste affichée jusqu'au toucher
    const valide = await envoyerA(c.env, prive.abonnement_push, paiementRecu
      ? { titre: 'Paiement reçu ✓', corps: 'Touchez pour revenir à votre livraison. Nous cherchons un livreur.', url: '/retour-paiement/' + prive.suivi_token, tag: 'suivi-' + course.id, urgent: true }
      : { titre: titre || 'Yobalema Yène', corps: msg(course), url: '/?suivi=' + prive.suivi_token + suffixe, tag: 'suivi-' + course.id, urgent });
    if (!valide) await c.db.query('UPDATE courses SET abonnement_push = NULL WHERE id = $1', [id]);
  }
  // le destinataire d'un colis suit aussi les grandes étapes
  if (notifierDest && course.service !== 'trajet' && MESSAGES_DEST[course.statut]) await prevenirDestinataire(c, id, MESSAGES_DEST[course.statut](course));
  return course;
}
