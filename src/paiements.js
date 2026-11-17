// Cycle de vie du paiement en ligne d'une course (Nangu : Wave / Orange Money).
//
// Le client ne paie qu'APRÈS l'acceptation d'un livreur (jamais d'argent bloqué sans livreur) :
//   commande (en attente, rien à payer) → un livreur accepte → paiement créé, client prévenu
//   → paiement reçu : le livreur peut récupérer le colis
//   → pas de paiement en 10 minutes : course annulée, livreur libéré, rien à rembourser.
const { query } = require('./db');
const nangu = require('./nangu');
const push = require('./push');
const { notifierNouvelleCourse, diffuserMaj } = require('./courses-service');

const DELAI_PAIEMENT = 10 * 60; // secondes laissées au client pour payer, une fois le livreur trouvé
const NOMS = { wave: 'Wave', orange_money: 'Orange Money' };
const fcfa = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';

async function courseParNangu(nanguId) {
  return (await query('SELECT id, statut, paiement_statut, livreur_id FROM courses WHERE nangu_id = $1', [nanguId])).rows[0];
}

const alerterLivreur = (livreurId, titre, corps) => livreurId && push.envoyer([livreurId], { titre, corps, url: '/livreur.html', urgent: true })
  .catch((e) => console.error('Notification livreur :', e.message));

/**
 * Un livreur a accepté une course payée en ligne : on crée (ou reprend) le paiement et on prévient le client.
 * origine : adresse publique du site, pour le retour automatique après paiement (https uniquement).
 * Lève une erreur si Nangu ne répond pas (l'acceptation est alors annulée par l'appelant).
 */
async function demanderPaiement(io, courseId, origine) {
  const c = (await query(
    `SELECT id, suivi_token, prix, client_tel, depart_repere, arrivee_repere, paiement, paiement_statut, nangu_id
     FROM courses WHERE id = $1`, [courseId]
  )).rows[0];
  if (!c || c.paiement === 'especes' || c.paiement_statut === 'paye') return null;
  let p = null;
  // un paiement encore valable (plus de 2 minutes devant lui) est réutilisé
  if (c.nangu_id) {
    try {
      const actuel = await nangu.lirePaiement(c.nangu_id);
      if (actuel.status === 'succeeded') { await confirmer(io, actuel.id, actuel.amount_due); return actuel; }
      if (actuel.status === 'pending' && new Date(actuel.expires_at) - Date.now() > 120000) p = actuel;
    } catch { /* on en crée un nouveau */ }
  }
  if (!p) {
    const retour = origine && origine.startsWith('https://') ? `${origine}/retour-paiement/${c.suivi_token}` : null;
    p = await nangu.creerPaiement({
      id: c.id, suivi: c.suivi_token, essai: Date.now().toString(36), prix: c.prix, client_tel: c.client_tel,
      depart_repere: c.depart_repere, arrivee_repere: c.arrivee_repere, retour, expireDans: DELAI_PAIEMENT,
    }, c.paiement);
    const infos = nangu.infosPaiement(p);
    await query(`UPDATE courses SET nangu_id = $2, montant_du = $3, paiement_infos = $4, paiement_statut = 'en_attente' WHERE id = $1`,
      [c.id, p.id, p.amount_due, infos]);
  }
  await diffuserMaj(io, c.id, {
    titre: 'Un livreur a accepté !',
    message: `Payez maintenant ${fcfa(p.amount_due || c.prix)} avec ${NOMS[c.paiement]} pour qu'il vienne chercher le colis (10 minutes).`,
    suffixe: '&payer=1',
    urgent: true,
  });
  return p;
}

/**
 * Paiement confirmé.
 * - Livreur déjà là (cas normal) : il est prévenu qu'il peut récupérer le colis.
 * - Pas encore de livreur (ancien fonctionnement, livreur désisté, ou paiement arrivé en retard
 *   sur une course annulée) : la course redevient visible des livreurs.
 */
async function confirmer(io, nanguId, montant) {
  const c = await courseParNangu(nanguId);
  if (!c || c.paiement_statut === 'paye') return false;
  const r = await query(
    `UPDATE courses SET paiement_statut = 'paye', paye_le = now(), montant_du = COALESCE($2, montant_du),
       statut = CASE WHEN statut IN ('attente_paiement', 'annulee') THEN 'en_attente' ELSE statut END,
       annulee_le = CASE WHEN statut IN ('attente_paiement', 'annulee') THEN NULL ELSE annulee_le END
     WHERE id = $1 AND statut IN ('attente_paiement', 'annulee', 'en_attente', 'acceptee', 'recuperee') RETURNING id`,
    [c.id, montant || null]
  );
  if (!r.rows.length) return false;
  // Pas d'alerte au client : la page de paiement Nangu envoie elle-même « Paiement reçu » et le ramène
  const course = await diffuserMaj(io, c.id, { notifierClient: false });
  if (course.statut === 'acceptee' && course.livreur_id) {
    alerterLivreur(course.livreur_id, 'Paiement reçu ✓', `Le client a payé. Vous pouvez récupérer le colis : ${course.depart_repere}`);
  } else if (course.statut === 'en_attente') {
    notifierNouvelleCourse(io, course).catch((e) => console.error('Notification :', e.message));
  }
  return true;
}

/**
 * Paiement expiré ou annulé sans avoir été payé : la course est annulée.
 * Le livreur qui attendait est libéré et prévenu ; le client n'a rien payé, il n'y a rien à rembourser.
 */
async function terminer(io, nanguId, etat) {
  const c = await courseParNangu(nanguId);
  if (!c || c.paiement_statut === 'paye' || !['attente_paiement', 'en_attente', 'acceptee'].includes(c.statut)) return false;
  await query(
    `UPDATE courses SET paiement_statut = $2, statut = 'annulee', annulee_le = now()
     WHERE id = $1 AND paiement_statut <> 'paye' AND statut IN ('attente_paiement', 'en_attente', 'acceptee')`,
    [c.id, etat === 'expired' ? 'expire' : 'annule']
  );
  await diffuserMaj(io, c.id, {
    message: etat === 'expired' ? 'Le délai de paiement est dépassé : la commande est annulée. Vous n\'avez rien payé.' : 'Paiement annulé : la commande est annulée.',
  });
  if (c.statut === 'acceptee') alerterLivreur(c.livreur_id, 'Course annulée', 'Le client n\'a pas payé à temps. Vous êtes libre pour une autre course.');
  return true;
}

/** Applique l'état d'un paiement Nangu (reçu par webhook ou relu chez Nangu). */
async function appliquer(io, p) {
  if (!p || !p.id) return;
  if (p.status === 'succeeded') return confirmer(io, p.id, p.amount_due);
  if (p.status === 'expired' || p.status === 'canceled') return terminer(io, p.id, p.status);
  return false;
}

// Relecture chez Nangu : au plus une fois toutes les 4 s par paiement
const derniereLecture = new Map();

/** Secours au webhook : pendant que le client attend, le serveur relit l'état chez Nangu avec sa clé. */
async function synchroniser(io, nanguId) {
  if (!nangu.actif() || !nanguId) return;
  const t = derniereLecture.get(nanguId) || 0;
  if (Date.now() - t < 4000) return;
  derniereLecture.set(nanguId, Date.now());
  try {
    await appliquer(io, await nangu.lirePaiement(nanguId));
  } catch (e) {
    console.error('Lecture du paiement Nangu :', e.message);
  }
}

/** Traite un événement webhook une seule fois. Renvoie false s'il avait déjà été traité. */
async function traiterEvenement(io, evt) {
  const deja = await query('SELECT id FROM evenements_nangu WHERE id = $1', [evt.id]);
  if (deja.rows.length) return false;
  await query('INSERT INTO evenements_nangu (id, type) VALUES ($1, $2)', [evt.id, String(evt.type)]);
  const p = evt.data && evt.data.payment;
  if (['payment.succeeded', 'payment.expired', 'payment.canceled'].includes(evt.type)) await appliquer(io, p);
  return true;
}

/**
 * Rapprochement par l'admin : relit l'état réel du paiement chez Nangu et l'applique.
 * Renvoie le statut Nangu (succeeded, pending, expired, canceled…) et la course à jour.
 */
async function rapprocher(io, courseId) {
  const c = (await query('SELECT id, nangu_id FROM courses WHERE id = $1', [courseId])).rows[0];
  if (!c) throw Object.assign(new Error('Course introuvable'), { status: 404 });
  if (!c.nangu_id) throw Object.assign(new Error('Aucun paiement Nangu pour cette course'), { status: 400 });
  if (!nangu.actif()) throw Object.assign(new Error('Paiement en ligne non configuré (clé Nangu absente)'), { status: 400 });
  const p = await nangu.lirePaiement(c.nangu_id);
  derniereLecture.set(c.nangu_id, Date.now());
  const change = await appliquer(io, p);
  return { statut_nangu: p.status, montant: p.amount_due ?? null, change: !!change };
}

/**
 * Validation manuelle par l'admin (argent vu sur le compte Wave / Orange Money, notification perdue…).
 * La course devient visible des livreurs si elle attendait ce paiement. Trace gardée dans evenements_nangu.
 */
async function validerManuellement(io, courseId, { adminId, reference = '' }) {
  const c = (await query('SELECT id, statut, paiement, paiement_statut FROM courses WHERE id = $1', [courseId])).rows[0];
  if (!c) throw Object.assign(new Error('Course introuvable'), { status: 404 });
  if (c.paiement === 'especes') throw Object.assign(new Error('Cette course se paie en espèces au livreur'), { status: 400 });
  if (c.paiement_statut === 'paye') throw Object.assign(new Error('Ce paiement est déjà validé'), { status: 400 });
  const rouvrir = ['attente_paiement', 'annulee'].includes(c.statut);
  await query(
    `UPDATE courses SET paiement_statut = 'paye', paye_le = now(),
       statut = CASE WHEN statut IN ('attente_paiement', 'annulee') THEN 'en_attente' ELSE statut END,
       annulee_le = CASE WHEN statut IN ('attente_paiement', 'annulee') THEN NULL ELSE annulee_le END
     WHERE id = $1`,
    [c.id]
  );
  const ref = String(reference || '').trim().slice(0, 80);
  await query('INSERT INTO evenements_nangu (id, type) VALUES ($1, $2)',
    [`manuel-${c.id}-${Date.now()}`, `admin:${adminId}:valide:course-${c.id}${ref ? ':' + ref : ''}`]);
  const course = await diffuserMaj(io, c.id, { message: 'Paiement reçu. Nous cherchons un livreur pour vous.', paiementRecu: true });
  if (rouvrir) notifierNouvelleCourse(io, course).catch((e) => console.error('Notification :', e.message));
  if (course.statut === 'acceptee') alerterLivreur(course.livreur_id, 'Paiement reçu ✓', 'Le client a payé. Vous pouvez récupérer le colis.');
  return course;
}

module.exports = {
  confirmer, terminer, appliquer, synchroniser, traiterEvenement, rapprocher, validerManuellement, demanderPaiement,
};
