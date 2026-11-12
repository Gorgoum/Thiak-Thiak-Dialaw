const { query } = require('./db');
const push = require('./push');
const { parametres, distanceKm } = require('./tarifs');

// Colonnes exposées : jamais le code de suivi ni l'abonnement push du client
const COLONNES = `c.id, c.client_nom, c.client_tel, c.livreur_id, c.type, c.description, c.montant_achat,
  c.depart_lat, c.depart_lng, c.depart_repere, c.arrivee_lat, c.arrivee_lng, c.arrivee_repere,
  c.destinataire_nom, c.destinataire_tel, c.distance_km, c.prix, c.paiement, c.paiement_statut, c.montant_du, c.paye_le, c.statut, c.note,
  c.cree_le, c.acceptee_le, c.recuperee_le, c.livree_le, c.annulee_le`;

const SELECT_COURSE = `
  SELECT ${COLONNES}, l.nom AS livreur_nom, l.telephone AS livreur_tel
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
  const r = await query(`SELECT id, lat, lng FROM utilisateurs WHERE role = 'livreur' AND actif AND disponible`);
  const depart = { lat: course.depart_lat, lng: course.depart_lng };
  const cibles = r.rows
    .filter((l) => l.lat == null || distanceKm(depart, l) <= (p.rayon_km || 10))
    .map((l) => l.id);

  io.to(['livreurs', 'admins']).emit('courses:changement');
  await push.envoyer(cibles, {
    titre: `Nouvelle course · ${fcfa(course.prix)}`,
    corps: `${course.depart_repere} → ${course.arrivee_repere}`,
    url: '/livreur.html',
    tag: 'course-' + course.id,
    urgent: true,
  });
}

const MESSAGES_CLIENT = {
  acceptee: (c) => `${c.livreur_nom} a accepté votre livraison et arrive au point de départ.`,
  recuperee: () => 'Votre colis a été récupéré, il est en route.',
  livree: () => 'Livraison terminée. Merci d\'avoir utilisé Thiak Thiak Dialaw !',
  en_attente: () => 'Le livreur s\'est désisté, nous cherchons un autre livreur.',
};

/** Diffuse un changement de statut au client (salle de suivi), au livreur, aux autres livreurs et aux admins. */
async function diffuserMaj(io, id, { notifierClient = true, message = null } = {}) {
  const c = await lireCourse(id);
  if (!c) return;
  const prive = (await query('SELECT suivi_token, abonnement_push FROM courses WHERE id = $1', [id])).rows[0];

  io.to('suivi:' + prive.suivi_token).emit('course:maj', c);
  if (c.livreur_id) io.to('user:' + c.livreur_id).emit('course:maj', c);
  io.to(['livreurs', 'admins']).emit('courses:changement');

  const msg = message ? () => message : MESSAGES_CLIENT[c.statut];
  if (notifierClient && msg && prive.abonnement_push) {
    const valide = await push.envoyerA(prive.abonnement_push, {
      titre: 'Thiak Thiak Dialaw',
      corps: msg(c),
      url: '/?suivi=' + prive.suivi_token,
      tag: 'suivi-' + c.id,
    });
    if (!valide) await query('UPDATE courses SET abonnement_push = NULL WHERE id = $1', [id]);
  }
  return c;
}

module.exports = { SELECT_COURSE, lireCourse, notifierNouvelleCourse, diffuserMaj };
