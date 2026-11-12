// Cycle de vie du paiement en ligne d'une course.
import { MAINTENANT } from './db.js';
import * as nangu from './nangu.js';
import { notifierNouvelleCourse, diffuserMaj } from './courses-service.js';

const courseParNangu = async (c, id) =>
  (await c.db.query('SELECT id, statut, paiement_statut FROM courses WHERE nangu_id = $1', [id])).rows[0];

export async function confirmer(c, nanguId, montant) {
  const x = await courseParNangu(c, nanguId);
  if (!x || x.paiement_statut === 'paye') return false;
  const r = await c.db.query(
    `UPDATE courses SET paiement_statut = 'paye', paye_le = ${MAINTENANT}, montant_du = COALESCE($2, montant_du),
       statut = 'en_attente', annulee_le = NULL
     WHERE id = $1 AND statut IN ('attente_paiement', 'annulee') RETURNING id`,
    [x.id, montant || null]
  );
  if (!r.rows.length) return false;
  const course = await diffuserMaj(c, x.id, { message: 'Paiement reçu. Nous cherchons un livreur pour vous.' });
  c.attendre(notifierNouvelleCourse(c, course).catch((e) => console.error('Notification :', e.message)));
  return true;
}

export async function terminer(c, nanguId, etat) {
  const x = await courseParNangu(c, nanguId);
  if (!x || x.statut !== 'attente_paiement') return false;
  await c.db.query(
    `UPDATE courses SET paiement_statut = $2, statut = 'annulee', annulee_le = ${MAINTENANT}
     WHERE id = $1 AND statut = 'attente_paiement'`,
    [x.id, etat === 'expired' ? 'expire' : 'annule']
  );
  await diffuserMaj(c, x.id, { message: etat === 'expired' ? 'Le délai de paiement est dépassé : la commande est annulée.' : 'Paiement annulé.' });
  return true;
}

export async function appliquer(c, p) {
  if (!p || !p.id) return false;
  if (p.status === 'succeeded') return confirmer(c, p.id, p.amount_due);
  if (p.status === 'expired' || p.status === 'canceled') return terminer(c, p.id, p.status);
  return false;
}

const derniereLecture = new Map();

/** Secours au webhook : relecture chez Nangu (au plus toutes les 4 s par paiement et par instance). */
export async function synchroniser(c, nanguId) {
  if (!nangu.actif(c.env) || !nanguId) return;
  if (Date.now() - (derniereLecture.get(nanguId) || 0) < 4000) return;
  derniereLecture.set(nanguId, Date.now());
  try { await appliquer(c, await nangu.lirePaiement(c.env, nanguId)); } catch (e) { console.error('Lecture Nangu :', e.message); }
}

/** Relève planifiée (toutes les minutes) : paiements en attente créés depuis moins de 2 heures. */
export async function releverPaiementsEnAttente(c) {
  if (!nangu.actif(c.env)) return 0;
  const r = await c.db.query(
    `SELECT nangu_id FROM courses WHERE paiement_statut = 'en_attente' AND nangu_id IS NOT NULL
       AND cree_le >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours') LIMIT 50`
  );
  for (const { nangu_id: id } of r.rows) {
    try { await appliquer(c, await nangu.lirePaiement(c.env, id)); } catch (e) { console.error('Relève Nangu :', e.message); }
  }
  return r.rows.length;
}

export async function traiterEvenement(c, evt) {
  const deja = await c.db.query('SELECT id FROM evenements_nangu WHERE id = $1', [evt.id]);
  if (deja.rows.length) return false;
  await c.db.query('INSERT INTO evenements_nangu (id, type) VALUES ($1, $2)', [evt.id, String(evt.type)]);
  if (['payment.succeeded', 'payment.expired', 'payment.canceled'].includes(evt.type)) await appliquer(c, evt.data && evt.data.payment);
  return true;
}
