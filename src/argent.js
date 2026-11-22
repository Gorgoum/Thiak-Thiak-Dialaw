// Argent entre les livreurs et la plateforme : un registre de mouvements, un solde par livreur.
//
// Convention du montant d'un mouvement :
//   positif → la plateforme doit cet argent au livreur (course payée en ligne : sa part)
//   négatif → le livreur doit cet argent à la plateforme (course en espèces : la commission)
// Solde = somme des mouvements. Un règlement remet le solde vers zéro.
const { query } = require('./db');
const { parametres, partage } = require('./tarifs');

const NOMS_MOYENS = { wave: 'Wave', orange_money: 'Orange Money', especes: 'espèces' };

/** Calcule le mouvement d'une course livrée. */
function mouvementDeCourse(c, p) {
  const x = partage(c, p);
  const fraisTxt = x.frais_plateforme ? ` + ${x.frais_plateforme.toLocaleString('fr-FR')} FCFA de frais` : '';
  return {
    ...x,
    // en ligne : la plateforme doit sa part au chauffeur ; en espèces : il doit la commission et les frais
    // en espèces, le livreur a aussi gardé la commission du restaurant (il lui a remis les plats moins 10 %)
    montant: x.en_ligne ? x.part_livreur + x.plats_avances : -(x.commission + x.frais_plateforme + x.commission_resto),
    libelle: x.en_ligne
      ? `Course n° ${c.id} payée par ${NOMS_MOYENS[c.paiement] || c.paiement} : votre part${x.plats_avances ? ` + ${x.plats_avances.toLocaleString('fr-FR')} FCFA de plats avancés au restaurant` : ''}`
      : `Course n° ${c.id} en espèces : commission${fraisTxt}${x.commission_resto ? ` + ${x.commission_resto.toLocaleString('fr-FR')} FCFA de commission restaurant` : ''} à reverser`,
  };
}

/**
 * Inscrit au registre les courses livrées qui n'y sont pas encore (toutes, ou une seule).
 * Appelé à chaque livraison, et avant chaque calcul de solde (rattrape les anciennes courses).
 */
async function inscrireCoursesLivrees(courseId = null) {
  const p = await parametres();
  // Requêtes simples, filtre final en JavaScript : même résultat sur PostgreSQL et sur la base de test
  // (pg-mem ne retrouve pas toujours par son index une course dont le statut vient de changer).
  const livrees = (await query(
    `SELECT id, statut, livreur_id, prix, paiement, paiement_statut, livree_le, frais_service, frais_achat, montant_achat, restaurant_id, commission_resto FROM courses
     WHERE livree_le IS NOT NULL ${courseId ? 'AND id = $1' : ''}`,
    courseId ? [courseId] : []
  )).rows.filter((x) => x.statut === 'livree' && x.livreur_id != null);
  if (!livrees.length) return;
  const deja = new Set((await query(`SELECT course_id FROM mouvements WHERE type = 'course' AND course_id IS NOT NULL`)).rows.map((x) => x.course_id));
  for (const c of livrees.filter((x) => !deja.has(x.id))) {
    const m = mouvementDeCourse(c, p);
    try {
      await query(
        `INSERT INTO mouvements (livreur_id, course_id, type, montant, prix, commission, paiement, libelle, cree_le,
           frais_plateforme, frais_paiement, part_livreur, gain_plateforme)
         VALUES ($1, $2, 'course', $3, $4, $5, $6, $7, coalesce($8, now()), $9, $10, $11, $12)`,
        [c.livreur_id, c.id, m.montant, c.prix, m.commission, c.paiement, m.libelle, c.livree_le,
          m.frais_plateforme, m.frais_paiement, m.part_livreur, m.gain_plateforme]
      );
    } catch (e) {
      if (e.code !== '23505') throw e; // déjà inscrite entre-temps
    }
  }
}

async function solde(livreurId) {
  await inscrireCoursesLivrees();
  const r = await query('SELECT coalesce(sum(montant), 0)::int AS solde FROM mouvements WHERE livreur_id = $1', [livreurId]);
  return Number(r.rows[0].solde);
}

/** Le livreur doit plus que le plafond : il ne peut plus accepter de course. */
async function bloque(livreurId) {
  const p = await parametres();
  const plafond = Number(p.plafond_dette) || 0;
  if (!plafond) return null;
  const s = await solde(livreurId);
  return s < -plafond ? { solde: s, plafond } : null;
}

/** Ce que voit le livreur : solde, journée, historique. */
async function argentLivreur(livreurId) {
  const s = await solde(livreurId);
  const p = await parametres();
  const jour = (await query(
    `SELECT count(*)::int AS nb,
            coalesce(sum(coalesce(part_livreur, prix - commission)), 0)::int AS part,
            coalesce(sum(CASE WHEN paiement = 'especes' THEN prix ELSE 0 END), 0)::int AS especes
     FROM mouvements WHERE livreur_id = $1 AND type = 'course' AND cree_le >= date_trunc('day', now())`,
    [livreurId]
  )).rows[0];
  const mouvements = (await query(
    'SELECT id, type, montant, libelle, reference, cree_le FROM mouvements WHERE livreur_id = $1 ORDER BY cree_le DESC, id DESC LIMIT 40',
    [livreurId]
  )).rows;
  const plafond = Number(p.plafond_dette) || 0;
  return {
    solde: s,
    plafond,
    bloque: !!plafond && s < -plafond,
    commission_pct: p.commission_pct,
    aujourdhui: { nb: jour.nb, part: jour.part, especes: jour.especes },
    mouvements,
  };
}

/** Pour l'admin : le solde de chaque livreur et la date du dernier règlement. */
async function soldes() {
  await inscrireCoursesLivrees();
  const livreurs = (await query(`SELECT id, nom, telephone, actif FROM utilisateurs WHERE role = 'livreur' ORDER BY nom`)).rows;
  const s = (await query('SELECT livreur_id, sum(montant)::int AS solde, count(*)::int AS nb FROM mouvements GROUP BY livreur_id')).rows;
  const r = (await query(`SELECT livreur_id, max(cree_le) AS dernier FROM mouvements WHERE type = 'reglement' GROUP BY livreur_id`)).rows;
  const parS = new Map(s.map((x) => [x.livreur_id, x]));
  const parR = new Map(r.map((x) => [x.livreur_id, x.dernier]));
  return livreurs.map((l) => ({
    ...l,
    solde: Number((parS.get(l.id) || {}).solde || 0),
    nb_mouvements: Number((parS.get(l.id) || {}).nb || 0),
    dernier_reglement: parR.get(l.id) || null,
  }));
}

async function mouvementsLivreur(livreurId) {
  await inscrireCoursesLivrees();
  return (await query(
    `SELECT m.id, m.type, m.montant, m.prix, m.commission, m.paiement, m.libelle, m.reference, m.cree_le, m.course_id, a.nom AS admin_nom
     FROM mouvements m LEFT JOIN utilisateurs a ON a.id = m.admin_id
     WHERE m.livreur_id = $1 ORDER BY m.cree_le DESC, m.id DESC LIMIT 200`,
    [livreurId]
  )).rows;
}

const erreur = (status, message) => Object.assign(new Error(message), { status });

/**
 * Règlement enregistré par l'admin. Le sens se déduit du solde :
 * solde positif → la plateforme a payé le livreur ; solde négatif → le livreur a reversé.
 * Un règlement partiel est permis, jamais au-delà du solde.
 */
async function enregistrerReglement(livreurId, { montant, reference, adminId }) {
  const l = (await query(`SELECT id, nom FROM utilisateurs WHERE id = $1 AND role = 'livreur'`, [livreurId])).rows[0];
  if (!l) throw erreur(404, 'Livreur introuvable');
  const s = await solde(livreurId);
  const m = Math.round(Number(montant));
  if (!s) throw erreur(400, 'Le solde de ce livreur est déjà à zéro');
  if (!Number.isFinite(m) || m <= 0) throw erreur(400, 'Indiquez un montant positif');
  if (m > Math.abs(s)) throw erreur(400, `Le montant dépasse le solde (${Math.abs(s).toLocaleString('fr-FR')} FCFA)`);
  const plateformePaie = s > 0;
  await query(
    `INSERT INTO mouvements (livreur_id, type, montant, libelle, reference, admin_id) VALUES ($1, 'reglement', $2, $3, $4, $5)`,
    [livreurId, plateformePaie ? -m : m, plateformePaie ? 'Versé au livreur' : 'Reversé par le livreur',
      String(reference || '').trim().slice(0, 80) || null, adminId]
  );
  return { solde: await solde(livreurId), sens: plateformePaie ? 'paye_au_livreur' : 'recu_du_livreur' };
}

/** Transactions d'une période : une ligne par course terminée, avec ce qu'ont gagné le chauffeur et la plateforme. */
async function transactions({ du, au }) {
  await inscrireCoursesLivrees();
  const lignes = (await query(
    `SELECT m.cree_le, m.course_id, u.nom AS livreur, m.paiement, m.prix, m.commission,
            coalesce(m.frais_plateforme, 0) AS frais_plateforme, coalesce(m.frais_paiement, 0) AS frais_paiement,
            coalesce(m.part_livreur, m.prix - m.commission) AS part_livreur,
            coalesce(m.gain_plateforme, m.commission) AS gain_plateforme,
            co.service, co.vehicule, co.type, coalesce(co.commission_resto, 0) AS commission_resto
     FROM mouvements m JOIN utilisateurs u ON u.id = m.livreur_id LEFT JOIN courses co ON co.id = m.course_id
     WHERE m.type = 'course' AND m.cree_le >= $1 AND m.cree_le < $2 ORDER BY m.cree_le DESC`,
    [du, au]
  )).rows.map((x) => ({
    ...x,
    prix: Number(x.prix), commission: Number(x.commission), frais_plateforme: Number(x.frais_plateforme),
    frais_paiement: Number(x.frais_paiement), part_livreur: Number(x.part_livreur), gain_plateforme: Number(x.gain_plateforme),
    commission_resto: Number(x.commission_resto) || 0,
  }));
  const somme = (k) => lignes.reduce((s, x) => s + x[k], 0);
  return {
    lignes,
    totaux: {
      nb: lignes.length, encaisse: somme('prix') + somme('commission_resto'), commission_resto: somme('commission_resto'), frais_paiement: somme('frais_paiement'), part_livreurs: somme('part_livreur'),
      commission: somme('commission'), frais_plateforme: somme('frais_plateforme'), gain_plateforme: somme('gain_plateforme'),
    },
  };
}

/** Export CSV (séparateur « ; » pour Excel en français) des mouvements d'une période. */
async function exportCsv({ du, au }) {
  await inscrireCoursesLivrees();
  const r = await query(
    `SELECT m.cree_le, u.nom AS livreur, m.type, m.course_id, m.paiement, m.prix, m.commission, m.montant, m.libelle, m.reference,
            m.frais_plateforme, m.frais_paiement, m.part_livreur, m.gain_plateforme
     FROM mouvements m JOIN utilisateurs u ON u.id = m.livreur_id
     WHERE m.cree_le >= $1 AND m.cree_le < $2 ORDER BY m.cree_le`,
    [du, au]
  );
  const cel = (v) => {
    const t = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
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

module.exports = {
  mouvementDeCourse, inscrireCoursesLivrees, solde, bloque, argentLivreur, soldes, mouvementsLivreur, enregistrerReglement, exportCsv, transactions,
};
