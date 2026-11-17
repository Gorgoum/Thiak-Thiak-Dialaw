// Cycle de vie du paiement en ligne d'une course.
//
// Le client ne paie qu'APRÈS l'acceptation d'un livreur (jamais d'argent bloqué sans livreur) :
//   commande (en attente, rien à payer) → un livreur accepte → paiement créé, client prévenu
//   → paiement reçu : le livreur peut récupérer le colis
//   → pas de paiement en 10 minutes : course annulée, livreur libéré, rien à rembourser.
import { MAINTENANT } from './db.js';
import * as nangu from './nangu.js';
import { notifierNouvelleCourse, diffuserMaj } from './courses-service.js';
import { envoyer } from './push.js';

const DELAI_PAIEMENT = 10 * 60;
const NOMS = { wave: 'Wave', orange_money: 'Orange Money' };
const fcfa = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';

const courseParNangu = async (c, id) =>
  (await c.db.query('SELECT id, statut, paiement_statut, livreur_id FROM courses WHERE nangu_id = $1', [id])).rows[0];

const alerterLivreur = (c, livreurId, titre, corps) => {
  if (livreurId) c.attendre(envoyer(c, [livreurId], { titre, corps, url: '/livreur.html', urgent: true }).catch((e) => console.error('Notification livreur :', e.message)));
};

/** Un livreur a accepté une course payée en ligne : on crée (ou reprend) le paiement et on prévient le client. */
export async function demanderPaiement(c, courseId) {
  const x = (await c.db.query(
    `SELECT id, suivi_token, prix, client_tel, depart_repere, arrivee_repere, paiement, paiement_statut, nangu_id
     FROM courses WHERE id = $1`, [courseId]
  )).rows[0];
  if (!x || x.paiement === 'especes' || x.paiement_statut === 'paye') return null;
  let p = null;
  if (x.nangu_id) {
    try {
      const actuel = await nangu.lirePaiement(c.env, x.nangu_id);
      if (actuel.status === 'succeeded') { await confirmer(c, actuel.id, actuel.amount_due); return actuel; }
      if (actuel.status === 'pending' && new Date(actuel.expires_at) - Date.now() > 120000) p = actuel;
    } catch { /* on en crée un nouveau */ }
  }
  if (!p) {
    const retour = c.url.protocol === 'https:' ? `${c.url.origin}/retour-paiement/${x.suivi_token}` : null;
    p = await nangu.creerPaiement(c.env, {
      id: x.id, suivi: x.suivi_token, essai: Date.now().toString(36), prix: x.prix, client_tel: x.client_tel,
      depart_repere: x.depart_repere, arrivee_repere: x.arrivee_repere, retour, expireDans: DELAI_PAIEMENT,
    }, x.paiement);
    const infos = nangu.infosPaiement(c.env, p);
    await c.db.query(`UPDATE courses SET nangu_id = $2, montant_du = $3, paiement_infos = $4, paiement_statut = 'en_attente' WHERE id = $1`,
      [x.id, p.id, p.amount_due, infos]);
  }
  await diffuserMaj(c, x.id, {
    titre: 'Un livreur a accepté !',
    message: `Payez maintenant ${fcfa(p.amount_due || x.prix)} avec ${NOMS[x.paiement]} pour qu'il vienne chercher le colis (10 minutes).`,
    suffixe: '&payer=1',
    urgent: true,
  });
  return p;
}

export async function confirmer(c, nanguId, montant) {
  const x = await courseParNangu(c, nanguId);
  if (!x || x.paiement_statut === 'paye') return false;
  const r = await c.db.query(
    `UPDATE courses SET paiement_statut = 'paye', paye_le = ${MAINTENANT}, montant_du = COALESCE($2, montant_du),
       statut = CASE WHEN statut IN ('attente_paiement', 'annulee') THEN 'en_attente' ELSE statut END,
       annulee_le = CASE WHEN statut IN ('attente_paiement', 'annulee') THEN NULL ELSE annulee_le END
     WHERE id = $1 AND statut IN ('attente_paiement', 'annulee', 'en_attente', 'acceptee', 'recuperee') RETURNING id`,
    [x.id, montant || null]
  );
  if (!r.rows.length) return false;
  // Pas d'alerte au client : la page de paiement Nangu envoie elle-même « Paiement reçu » et le ramène
  const course = await diffuserMaj(c, x.id, { notifierClient: false });
  if (course.statut === 'acceptee' && course.livreur_id) {
    alerterLivreur(c, course.livreur_id, 'Paiement reçu ✓', `Le client a payé. Vous pouvez récupérer le colis : ${course.depart_repere}`);
  } else if (course.statut === 'en_attente') {
    c.attendre(notifierNouvelleCourse(c, course).catch((e) => console.error('Notification :', e.message)));
  }
  return true;
}

/** Paiement expiré ou annulé sans avoir été payé : course annulée, livreur libéré, rien à rembourser. */
export async function terminer(c, nanguId, etat) {
  const x = await courseParNangu(c, nanguId);
  if (!x || x.paiement_statut === 'paye' || !['attente_paiement', 'en_attente', 'acceptee'].includes(x.statut)) return false;
  await c.db.query(
    `UPDATE courses SET paiement_statut = $2, statut = 'annulee', annulee_le = ${MAINTENANT}
     WHERE id = $1 AND paiement_statut <> 'paye' AND statut IN ('attente_paiement', 'en_attente', 'acceptee')`,
    [x.id, etat === 'expired' ? 'expire' : 'annule']
  );
  await diffuserMaj(c, x.id, { message: etat === 'expired' ? 'Le délai de paiement est dépassé : la commande est annulée. Vous n\'avez rien payé.' : 'Paiement annulé : la commande est annulée.' });
  if (x.statut === 'acceptee') alerterLivreur(c, x.livreur_id, 'Course annulée', 'Le client n\'a pas payé à temps. Vous êtes libre pour une autre course.');
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
       AND coalesce(acceptee_le, cree_le) >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours') LIMIT 50`
  );
  for (const { nangu_id: id } of r.rows) {
    try { await appliquer(c, await nangu.lirePaiement(c.env, id)); } catch (e) { console.error('Relève Nangu :', e.message); }
  }
  return r.rows.length;
}

/** Rapprochement par l'admin : relit l'état réel du paiement chez Nangu et l'applique. */
export async function rapprocher(c, courseId) {
  const x = (await c.db.query('SELECT id, nangu_id FROM courses WHERE id = $1', [courseId])).rows[0];
  if (!x) throw Object.assign(new Error('Course introuvable'), { status: 404 });
  if (!x.nangu_id) throw Object.assign(new Error('Aucun paiement Nangu pour cette course'), { status: 400 });
  if (!nangu.actif(c.env)) throw Object.assign(new Error('Paiement en ligne non configuré (clé Nangu absente)'), { status: 400 });
  const p = await nangu.lirePaiement(c.env, x.nangu_id);
  derniereLecture.set(x.nangu_id, Date.now());
  const change = await appliquer(c, p);
  return { statut_nangu: p.status, montant: p.amount_due ?? null, change: !!change };
}

/** Validation manuelle par l'admin (argent vu sur le compte, notification perdue…). Trace dans evenements_nangu. */
export async function validerManuellement(c, courseId, { adminId, reference = '' }) {
  const x = (await c.db.query('SELECT id, statut, paiement, paiement_statut FROM courses WHERE id = $1', [courseId])).rows[0];
  if (!x) throw Object.assign(new Error('Course introuvable'), { status: 404 });
  if (x.paiement === 'especes') throw Object.assign(new Error('Cette course se paie en espèces au livreur'), { status: 400 });
  if (x.paiement_statut === 'paye') throw Object.assign(new Error('Ce paiement est déjà validé'), { status: 400 });
  const rouvrir = ['attente_paiement', 'annulee'].includes(x.statut);
  await c.db.query(
    `UPDATE courses SET paiement_statut = 'paye', paye_le = ${MAINTENANT},
       statut = CASE WHEN statut IN ('attente_paiement', 'annulee') THEN 'en_attente' ELSE statut END,
       annulee_le = CASE WHEN statut IN ('attente_paiement', 'annulee') THEN NULL ELSE annulee_le END
     WHERE id = $1`,
    [x.id]
  );
  const ref = String(reference || '').trim().slice(0, 80);
  await c.db.query('INSERT INTO evenements_nangu (id, type) VALUES ($1, $2)',
    [`manuel-${x.id}-${Date.now()}`, `admin:${adminId}:valide:course-${x.id}${ref ? ':' + ref : ''}`]);
  const course = await diffuserMaj(c, x.id, { message: 'Paiement reçu. Nous cherchons un livreur pour vous.', paiementRecu: true });
  if (rouvrir) c.attendre(notifierNouvelleCourse(c, course).catch((e) => console.error('Notification :', e.message)));
  if (course.statut === 'acceptee') alerterLivreur(c, course.livreur_id, 'Paiement reçu ✓', 'Le client a payé. Vous pouvez récupérer le colis.');
  return course;
}

export async function traiterEvenement(c, evt) {
  const deja = await c.db.query('SELECT id FROM evenements_nangu WHERE id = $1', [evt.id]);
  if (deja.rows.length) return false;
  await c.db.query('INSERT INTO evenements_nangu (id, type) VALUES ($1, $2)', [evt.id, String(evt.type)]);
  if (['payment.succeeded', 'payment.expired', 'payment.canceled'].includes(evt.type)) await appliquer(c, evt.data && evt.data.payment);
  return true;
}
