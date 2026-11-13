// Cycle de vie du paiement en ligne d'une course (Nangu : Wave / Orange Money).
const { query } = require('./db');
const nangu = require('./nangu');
const { notifierNouvelleCourse, diffuserMaj } = require('./courses-service');

async function courseParNangu(nanguId) {
  return (await query('SELECT id, statut, paiement_statut FROM courses WHERE nangu_id = $1', [nanguId])).rows[0];
}

/**
 * Paiement confirmé : la course devient visible des livreurs.
 * Aussi valable après une expiration (notification Wave arrivée en retard alors que le client avait payé à temps).
 */
async function confirmer(io, nanguId, montant) {
  const c = await courseParNangu(nanguId);
  if (!c || c.paiement_statut === 'paye') return false;
  const r = await query(
    `UPDATE courses SET paiement_statut = 'paye', paye_le = now(), montant_du = COALESCE($2, montant_du),
       statut = 'en_attente', annulee_le = NULL
     WHERE id = $1 AND statut IN ('attente_paiement', 'annulee') RETURNING id`,
    [c.id, montant || null]
  );
  if (!r.rows.length) return false;
  const course = await diffuserMaj(io, c.id, { message: 'Paiement reçu. Nous cherchons un livreur pour vous.' });
  notifierNouvelleCourse(io, course).catch((e) => console.error('Notification :', e.message));
  return true;
}

/** Paiement expiré ou annulé : la commande est annulée (si elle n'a pas été payée entre-temps). */
async function terminer(io, nanguId, etat) {
  const c = await courseParNangu(nanguId);
  if (!c || c.statut !== 'attente_paiement') return false;
  await query(
    `UPDATE courses SET paiement_statut = $2, statut = 'annulee', annulee_le = now()
     WHERE id = $1 AND statut = 'attente_paiement'`,
    [c.id, etat === 'expired' ? 'expire' : 'annule']
  );
  await diffuserMaj(io, c.id, {
    message: etat === 'expired' ? 'Le délai de paiement est dépassé : la commande est annulée.' : 'Paiement annulé.',
  });
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
  const course = await diffuserMaj(io, c.id, { message: 'Paiement reçu. Nous cherchons un livreur pour vous.' });
  if (rouvrir) notifierNouvelleCourse(io, course).catch((e) => console.error('Notification :', e.message));
  return course;
}

module.exports = { confirmer, terminer, appliquer, synchroniser, traiterEvenement, rapprocher, validerManuellement };
