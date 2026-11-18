// Lecture des courses et diffusion des changements (temps réel + notifications).
import { envoyer, envoyerA } from './push.js';
import { parametres, distanceKm } from './tarifs.js';

const COLONNES = `c.id, c.client_nom, c.client_tel, c.livreur_id, c.type, c.description, c.montant_achat,
  c.depart_lat, c.depart_lng, c.depart_repere, c.arrivee_lat, c.arrivee_lng, c.arrivee_repere,
  c.destinataire_nom, c.destinataire_tel, c.distance_km, c.prix, c.paiement, c.paiement_statut, c.montant_du, c.paye_le,
  c.statut, c.note, c.cree_le, c.acceptee_le, c.recuperee_le, c.livree_le, c.annulee_le,
  c.service, c.vehicule, c.arrive_le`;

export const SELECT_COURSE = `
  SELECT ${COLONNES}, l.nom AS livreur_nom, l.telephone AS livreur_tel, l.vehicule AS livreur_vehicule, l.plaque AS livreur_plaque, l.modele AS livreur_modele,
         CASE WHEN c.statut IN ('acceptee', 'recuperee') THEN l.lat END AS livreur_lat,
         CASE WHEN c.statut IN ('acceptee', 'recuperee') THEN l.lng END AS livreur_lng
  FROM courses c
  LEFT JOIN utilisateurs l ON l.id = c.livreur_id`;

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
    .filter((l) => !trajet || (l.vehicule || 'moto') === course.vehicule) // un trajet en voiture → les voitures seulement
    .filter((l) => l.lat == null || distanceKm(depart, l) <= (p.rayon_km || 10)).map((l) => l.id);
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

export async function diffuserMaj(c, id, { notifierClient = true, message = null, paiementRecu = false, titre = null, suffixe = '', urgent = false } = {}) {
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
  return course;
}
