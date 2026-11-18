// Argent entre les livreurs et la plateforme : un registre de mouvements, un solde par livreur.
// montant > 0 : la plateforme doit cet argent au livreur (sa part d'une course payée en ligne)
// montant < 0 : le livreur doit cet argent à la plateforme (commission d'une course en espèces)
import { MAINTENANT, DEBUT_JOUR } from './db.js';
import { parametres, partage } from './tarifs.js';
import { HttpErreur } from './outils.js';

const NOMS_MOYENS = { wave: 'Wave', orange_money: 'Orange Money', especes: 'espèces' };

export function mouvementDeCourse(course, p) {
  const x = partage(course, p);
  const fraisTxt = x.frais_plateforme ? ` + ${x.frais_plateforme.toLocaleString('fr-FR')} FCFA de frais` : '';
  return {
    ...x,
    // en ligne : la plateforme doit sa part au chauffeur ; en espèces : il doit la commission et les frais
    montant: x.en_ligne ? x.part_livreur : -(x.commission + x.frais_plateforme),
    libelle: x.en_ligne
      ? `Course n° ${course.id} payée par ${NOMS_MOYENS[course.paiement] || course.paiement} : votre part`
      : `Course n° ${course.id} en espèces : commission${fraisTxt} à reverser`,
  };
}

/** Inscrit au registre les courses livrées qui n'y sont pas encore (toutes, ou une seule). */
export async function inscrireCoursesLivrees(c, courseId = null) {
  const p = await parametres(c.db);
  const r = await c.db.query(
    `SELECT co.id, co.livreur_id, co.prix, co.paiement, co.paiement_statut, co.livree_le, co.frais_service, co.frais_achat
     FROM courses co
     WHERE co.statut = 'livree' AND co.livreur_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM mouvements m WHERE m.course_id = co.id AND m.type = 'course')
       ${courseId ? 'AND co.id = $1' : ''}`,
    courseId ? [Number(courseId)] : []
  );
  for (const course of r.rows) {
    const m = mouvementDeCourse(course, p);
    await c.db.query(
      `INSERT OR IGNORE INTO mouvements (livreur_id, course_id, type, montant, prix, commission, paiement, libelle, cree_le,
         frais_plateforme, frais_paiement, part_livreur, gain_plateforme)
       VALUES ($1, $2, 'course', $3, $4, $5, $6, $7, coalesce($8, ${MAINTENANT}), $9, $10, $11, $12)`,
      [course.livreur_id, course.id, m.montant, course.prix, m.commission, course.paiement, m.libelle, course.livree_le,
        m.frais_plateforme, m.frais_paiement, m.part_livreur, m.gain_plateforme]
    );
  }
}

export async function solde(c, livreurId) {
  await inscrireCoursesLivrees(c);
  const r = await c.db.query('SELECT coalesce(sum(montant), 0) AS solde FROM mouvements WHERE livreur_id = $1', [Number(livreurId)]);
  return Number(r.rows[0].solde);
}

export async function bloque(c, livreurId) {
  const p = await parametres(c.db);
  const plafond = Number(p.plafond_dette) || 0;
  if (!plafond) return null;
  const s = await solde(c, livreurId);
  return s < -plafond ? { solde: s, plafond } : null;
}

export async function argentLivreur(c, livreurId) {
  const s = await solde(c, livreurId);
  const p = await parametres(c.db);
  const jour = (await c.db.query(
    `SELECT count(*) AS nb, coalesce(sum(coalesce(part_livreur, prix - commission)), 0) AS part,
            coalesce(sum(CASE WHEN paiement = 'especes' THEN prix ELSE 0 END), 0) AS especes
     FROM mouvements WHERE livreur_id = $1 AND type = 'course' AND cree_le >= ${DEBUT_JOUR}`,
    [livreurId]
  )).rows[0];
  const mouvements = (await c.db.query(
    'SELECT id, type, montant, libelle, reference, cree_le FROM mouvements WHERE livreur_id = $1 ORDER BY cree_le DESC, id DESC LIMIT 40',
    [livreurId]
  )).rows;
  const plafond = Number(p.plafond_dette) || 0;
  return {
    solde: s, plafond, bloque: !!plafond && s < -plafond, commission_pct: p.commission_pct,
    aujourdhui: { nb: Number(jour.nb), part: Number(jour.part), especes: Number(jour.especes) },
    mouvements,
  };
}

export async function soldes(c) {
  await inscrireCoursesLivrees(c);
  const livreurs = (await c.db.query(`SELECT id, nom, telephone, actif FROM utilisateurs WHERE role = 'livreur' ORDER BY nom`)).rows;
  const s = (await c.db.query('SELECT livreur_id, sum(montant) AS solde, count(*) AS nb FROM mouvements GROUP BY livreur_id')).rows;
  const r = (await c.db.query(`SELECT livreur_id, max(cree_le) AS dernier FROM mouvements WHERE type = 'reglement' GROUP BY livreur_id`)).rows;
  const parS = new Map(s.map((x) => [x.livreur_id, x]));
  const parR = new Map(r.map((x) => [x.livreur_id, x.dernier]));
  return livreurs.map((l) => ({
    ...l,
    solde: Number((parS.get(l.id) || {}).solde || 0),
    nb_mouvements: Number((parS.get(l.id) || {}).nb || 0),
    dernier_reglement: parR.get(l.id) || null,
  }));
}

export async function mouvementsLivreur(c, livreurId) {
  await inscrireCoursesLivrees(c);
  return (await c.db.query(
    `SELECT m.id, m.type, m.montant, m.prix, m.commission, m.paiement, m.libelle, m.reference, m.cree_le, m.course_id, a.nom AS admin_nom
     FROM mouvements m LEFT JOIN utilisateurs a ON a.id = m.admin_id
     WHERE m.livreur_id = $1 ORDER BY m.cree_le DESC, m.id DESC LIMIT 200`,
    [Number(livreurId)]
  )).rows;
}

/** Règlement enregistré par l'admin ; le sens se déduit du solde. Partiel permis, jamais au-delà du solde. */
export async function enregistrerReglement(c, livreurId, { montant, reference, adminId }) {
  const id = Number(livreurId);
  const l = (await c.db.query(`SELECT id FROM utilisateurs WHERE id = $1 AND role = 'livreur'`, [id])).rows[0];
  if (!l) throw new HttpErreur(404, 'Livreur introuvable');
  const s = await solde(c, id);
  const m = Math.round(Number(montant));
  if (!s) throw new HttpErreur(400, 'Le solde de ce livreur est déjà à zéro');
  if (!Number.isFinite(m) || m <= 0) throw new HttpErreur(400, 'Indiquez un montant positif');
  if (m > Math.abs(s)) throw new HttpErreur(400, `Le montant dépasse le solde (${Math.abs(s).toLocaleString('fr-FR')} FCFA)`);
  const plateformePaie = s > 0;
  await c.db.query(
    `INSERT INTO mouvements (livreur_id, type, montant, libelle, reference, admin_id, cree_le) VALUES ($1, 'reglement', $2, $3, $4, $5, ${MAINTENANT})`,
    [id, plateformePaie ? -m : m, plateformePaie ? 'Versé au livreur' : 'Reversé par le livreur',
      String(reference || '').trim().slice(0, 80) || null, adminId]
  );
  return { solde: await solde(c, id), sens: plateformePaie ? 'paye_au_livreur' : 'recu_du_livreur' };
}

/** Transactions d'une période : une ligne par course terminée, avec ce qu'ont gagné le chauffeur et la plateforme. */
export async function transactions(c, { du, au }) {
  await inscrireCoursesLivrees(c);
  const lignes = (await c.db.query(
    `SELECT m.cree_le, m.course_id, u.nom AS livreur, m.paiement, m.prix, m.commission,
            coalesce(m.frais_plateforme, 0) AS frais_plateforme, coalesce(m.frais_paiement, 0) AS frais_paiement,
            coalesce(m.part_livreur, m.prix - m.commission) AS part_livreur,
            coalesce(m.gain_plateforme, m.commission) AS gain_plateforme,
            co.service, co.vehicule, co.type
     FROM mouvements m JOIN utilisateurs u ON u.id = m.livreur_id LEFT JOIN courses co ON co.id = m.course_id
     WHERE m.type = 'course' AND m.cree_le >= $1 AND m.cree_le < $2 ORDER BY m.cree_le DESC`,
    [du, au]
  )).rows.map((x) => ({
    ...x,
    prix: Number(x.prix), commission: Number(x.commission), frais_plateforme: Number(x.frais_plateforme),
    frais_paiement: Number(x.frais_paiement), part_livreur: Number(x.part_livreur), gain_plateforme: Number(x.gain_plateforme),
  }));
  const somme = (k) => lignes.reduce((s, x) => s + x[k], 0);
  return {
    lignes,
    totaux: {
      nb: lignes.length, encaisse: somme('prix'), frais_paiement: somme('frais_paiement'), part_livreurs: somme('part_livreur'),
      commission: somme('commission'), frais_plateforme: somme('frais_plateforme'), gain_plateforme: somme('gain_plateforme'),
    },
  };
}

export async function exportCsv(c, { du, au }) {
  await inscrireCoursesLivrees(c);
  const r = await c.db.query(
    `SELECT m.cree_le, u.nom AS livreur, m.type, m.course_id, m.paiement, m.prix, m.commission, m.montant, m.libelle, m.reference,
            m.frais_plateforme, m.frais_paiement, m.part_livreur, m.gain_plateforme
     FROM mouvements m JOIN utilisateurs u ON u.id = m.livreur_id
     WHERE m.cree_le >= $1 AND m.cree_le < $2 ORDER BY m.cree_le`,
    [du, au]
  );
  const cel = (v) => {
    const t = v == null ? '' : String(v);
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lignes = [['Date', 'Livreur', 'Type', 'Course', 'Paiement', 'Payé par le client', 'Frais Wave / OM', 'Part du chauffeur', 'Commission', 'Frais de service et d\'achat', 'Gain de la plateforme', 'Solde (+ dû au livreur / − dû à la plateforme)', 'Libellé', 'Référence']];
  for (const x of r.rows) {
    const course = x.type === 'course';
    lignes.push([x.cree_le, x.livreur, x.type, x.course_id, x.paiement, x.prix,
      course ? (x.frais_paiement ?? 0) : '', course ? (x.part_livreur ?? (x.prix - x.commission)) : '', x.commission,
      course ? (x.frais_plateforme ?? 0) : '', course ? (x.gain_plateforme ?? x.commission) : '', x.montant, x.libelle, x.reference]);
  }
  return '﻿' + lignes.map((l) => l.map(cel).join(';')).join('\r\n');
}
