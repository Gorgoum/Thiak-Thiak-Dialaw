// Lecture des courses et diffusion des changements (temps réel + notifications).
import { envoyer, envoyerA } from './push.js';
import { parametres, distanceKm } from './tarifs.js';

const COLONNES = `c.id, c.client_nom, c.client_tel, c.livreur_id, c.type, c.description, c.montant_achat,
  c.depart_lat, c.depart_lng, c.depart_repere, c.arrivee_lat, c.arrivee_lng, c.arrivee_repere,
  c.destinataire_nom, c.destinataire_tel, c.distance_km, c.prix, c.paiement, c.paiement_statut, c.montant_du, c.paye_le,
  c.statut, c.note, c.cree_le, c.acceptee_le, c.recuperee_le, c.livree_le, c.annulee_le`;

export const SELECT_COURSE = `
  SELECT ${COLONNES}, l.nom AS livreur_nom, l.telephone AS livreur_tel
  FROM courses c
  LEFT JOIN utilisateurs l ON l.id = c.livreur_id`;

export async function lireCourse(c, id) {
  return (await c.db.query(SELECT_COURSE + ' WHERE c.id = $1', [id])).rows[0];
}

const fcfa = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';

export async function notifierNouvelleCourse(c, course) {
  const p = await parametres(c.db);
  const r = await c.db.query(`SELECT id, lat, lng FROM utilisateurs WHERE role = 'livreur' AND actif = 1 AND disponible = 1`);
  const depart = { lat: course.depart_lat, lng: course.depart_lng };
  const cibles = r.rows.filter((l) => l.lat == null || distanceKm(depart, l) <= (p.rayon_km || 10)).map((l) => l.id);
  c.io.to(['livreurs', 'admins']).emit('courses:changement');
  await envoyer(c, cibles, {
    titre: `Nouvelle course · ${fcfa(course.prix)}`,
    corps: `${course.depart_repere} → ${course.arrivee_repere}`,
    url: '/livreur.html',
    tag: 'course-' + course.id,
    urgent: true,
  });
}

const MESSAGES_CLIENT = {
  acceptee: (x) => `${x.livreur_nom} a accepté votre livraison et arrive au point de départ.`,
  recuperee: () => 'Votre colis a été récupéré, il est en route.',
  livree: () => 'Livraison terminée. Merci d\'avoir utilisé Thiak Thiak Dialaw !',
  en_attente: () => 'Le livreur s\'est désisté, nous cherchons un autre livreur.',
};

export async function diffuserMaj(c, id, { notifierClient = true, message = null } = {}) {
  const course = await lireCourse(c, id);
  if (!course) return null;
  const prive = (await c.db.query('SELECT suivi_token, abonnement_push FROM courses WHERE id = $1', [id])).rows[0];
  c.io.to('suivi:' + prive.suivi_token).emit('course:maj', course);
  if (course.livreur_id) c.io.to('user:' + course.livreur_id).emit('course:maj', course);
  c.io.to(['livreurs', 'admins']).emit('courses:changement');

  const msg = message ? () => message : MESSAGES_CLIENT[course.statut];
  if (notifierClient && msg && prive.abonnement_push) {
    const valide = await envoyerA(c.env, prive.abonnement_push, {
      titre: 'Thiak Thiak Dialaw', corps: msg(course), url: '/?suivi=' + prive.suivi_token, tag: 'suivi-' + course.id,
    });
    if (!valide) await c.db.query('UPDATE courses SET abonnement_push = NULL WHERE id = $1', [id]);
  }
  return course;
}
