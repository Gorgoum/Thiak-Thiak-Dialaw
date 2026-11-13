// Routes administrateur : tableau de bord, livreurs, courses, lieux, tarifs.
import { HttpErreur, json, lireCorps } from '../outils.js';
import { DEBUT_JOUR, MAINTENANT } from '../db.js';
import { exiger, hacherPin, normaliserTel } from '../securite.js';
import { parametres, pointValide } from '../tarifs.js';
import { SELECT_COURSE, diffuserMaj, notifierNouvelleCourse, lireCourse } from '../courses-service.js';
import { rapprocher, validerManuellement } from '../paiements.js';
import { envoyer } from '../push.js';
import { CATEGORIES } from '../lieux.js';

const CLES = ['prix_base', 'prix_km', 'prix_min', 'facteur_route', 'commission_pct', 'rayon_km', 'zone_km'];

export function enregistrer(r) {
  enregistrerGestion(r);
  r.get('/api/admin/stats', async (req, c) => {
    await exigerAdmin(req, c);
    const p = await parametres(c.db);
    const s = (await c.db.query(
      `SELECT
         coalesce(sum(CASE WHEN statut = 'en_attente' THEN 1 ELSE 0 END), 0) AS en_attente,
         coalesce(sum(CASE WHEN statut IN ('acceptee', 'recuperee') THEN 1 ELSE 0 END), 0) AS en_cours,
         coalesce(sum(CASE WHEN statut = 'livree' AND livree_le >= ${DEBUT_JOUR} THEN 1 ELSE 0 END), 0) AS livrees_jour,
         coalesce(sum(CASE WHEN statut = 'livree' AND livree_le >= ${DEBUT_JOUR} THEN prix ELSE 0 END), 0) AS ca_jour,
         round(avg(note), 1) AS note_moyenne
       FROM courses`
    )).rows[0];
    const l = (await c.db.query(
      `SELECT coalesce(sum(CASE WHEN actif = 1 AND disponible = 1 THEN 1 ELSE 0 END), 0) AS disponibles,
              coalesce(sum(CASE WHEN actif = 0 THEN 1 ELSE 0 END), 0) AS a_valider,
              count(*) AS total
       FROM utilisateurs WHERE role = 'livreur'`
    )).rows[0];
    const ca = Number(s.ca_jour);
    return json({
      en_attente: Number(s.en_attente), en_cours: Number(s.en_cours), livrees_jour: Number(s.livrees_jour),
      ca_jour: ca, note_moyenne: s.note_moyenne, commission_jour: Math.round((ca * (p.commission_pct || 0)) / 100),
      livreurs: { disponibles: Number(l.disponibles), a_valider: Number(l.a_valider), total: Number(l.total) },
    });
  });

  r.get('/api/admin/livreurs', async (req, c) => {
    await exigerAdmin(req, c);
    const res = await c.db.query(
      `SELECT u.id, u.nom, u.telephone, u.actif, u.disponible, u.position_maj, u.cree_le,
              coalesce(s.nb_livrees, 0) AS nb_livrees, s.note_moyenne
       FROM utilisateurs u
       LEFT JOIN (
         SELECT livreur_id, sum(CASE WHEN statut = 'livree' THEN 1 ELSE 0 END) AS nb_livrees, round(avg(note), 1) AS note_moyenne
         FROM courses WHERE livreur_id IS NOT NULL GROUP BY livreur_id
       ) s ON s.livreur_id = u.id
       WHERE u.role = 'livreur' ORDER BY u.actif, u.nom`
    );
    return json(res.rows);
  });

  r.post('/api/admin/livreurs/:id/activer', async (req, c) => {
    await exigerAdmin(req, c);
    const actif = !!(await lireCorps(req)).actif;
    const res = await c.db.query(
      `UPDATE utilisateurs SET actif = $2, disponible = CASE WHEN $2 = 1 THEN disponible ELSE 0 END
       WHERE id = $1 AND role = 'livreur' RETURNING id`,
      [Number(c.params.id), actif]
    );
    if (!res.rows.length) throw new HttpErreur(404, 'Livreur introuvable');
    return json({ ok: true });
  });

  r.get('/api/admin/courses', async (req, c) => {
    await exigerAdmin(req, c);
    const statut = c.url.searchParams.get('statut');
    const res = statut
      ? await c.db.query(SELECT_COURSE + ' WHERE c.statut = $1 ORDER BY c.cree_le DESC LIMIT 100', [statut])
      : await c.db.query(SELECT_COURSE + ' ORDER BY c.cree_le DESC LIMIT 100');
    return json(res.rows);
  });

  r.post('/api/admin/lieux', async (req, c) => {
    await exigerAdmin(req, c);
    const { nom, categorie, lat, lng } = await lireCorps(req);
    const n = String(nom || '').trim().slice(0, 120);
    if (n.length < 2) throw new HttpErreur(400, 'Indiquez le nom du lieu');
    if (!pointValide({ lat, lng })) throw new HttpErreur(400, 'Placez le lieu sur la carte');
    const res = await c.db.query(
      `INSERT INTO lieux (nom, categorie, lat, lng, source) VALUES ($1, $2, $3, $4, 'admin') RETURNING id, nom, categorie, lat, lng, source`,
      [n, CATEGORIES.includes(categorie) ? categorie : 'autre', Number(lat), Number(lng)]
    );
    return json(res.rows[0], 201);
  });

  r.get('/api/admin/lieux-proposes', async (req, c) => {
    await exigerAdmin(req, c);
    return json((await c.db.query(
      'SELECT id, nom, categorie, lat, lng, vu_fois, cree_le FROM lieux WHERE valide = 0 ORDER BY vu_fois DESC, cree_le DESC LIMIT 100'
    )).rows);
  });

  r.post('/api/admin/lieux/:id/valider', async (req, c) => {
    await exigerAdmin(req, c);
    const { nom, categorie } = await lireCorps(req);
    const n = String(nom || '').trim().slice(0, 120);
    const res = await c.db.query(
      `UPDATE lieux SET valide = 1, nom = CASE WHEN $2 = '' THEN nom ELSE $2 END, categorie = $3
       WHERE id = $1 RETURNING id, nom, categorie, lat, lng, source`,
      [Number(c.params.id), n, CATEGORIES.includes(categorie) ? categorie : 'autre']
    );
    if (!res.rows.length) throw new HttpErreur(404, 'Lieu introuvable');
    return json(res.rows[0]);
  });

  r.delete('/api/admin/lieux/:id', async (req, c) => {
    await exigerAdmin(req, c);
    const res = await c.db.query('DELETE FROM lieux WHERE id = $1 RETURNING id', [Number(c.params.id)]);
    if (!res.rows.length) throw new HttpErreur(404, 'Lieu introuvable');
    return json({ ok: true });
  });

  r.get('/api/admin/parametres', async (req, c) => {
    await exigerAdmin(req, c);
    return json(await parametres(c.db));
  });

  r.put('/api/admin/parametres', async (req, c) => {
    await exigerAdmin(req, c);
    const b = await lireCorps(req);
    for (const cle of CLES) {
      if (b[cle] === undefined) continue;
      const v = Number(b[cle]);
      if (!Number.isFinite(v) || v < 0) throw new HttpErreur(400, `Valeur invalide pour ${cle}`);
      await c.db.query('INSERT INTO parametres (cle, valeur) VALUES ($1, $2) ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur', [cle, String(v)]);
    }
    return json(await parametres(c.db));
  });
}

// =========================================================================
// Comptes : livreurs et administrateurs (ajouter, modifier, supprimer)
// =========================================================================
/** Exige un admin qui existe encore en base (un admin retiré perd l'accès tout de suite). */
async function exigerAdmin(req, c) {
  const u = await exiger(req, c, 'admin');
  const r = await c.db.query(`SELECT 1 FROM utilisateurs WHERE id = $1 AND role = 'admin'`, [u.id]);
  if (!r.rows.length) throw new HttpErreur(401, 'Compte administrateur introuvable, reconnectez-vous');
  return u;
}

async function lireCompte(c, b, { id = 0, pinObligatoire = true } = {}) {
  const nom = String(b.nom || '').trim().slice(0, 100);
  const tel = normaliserTel(b.telephone);
  const pin = String(b.pin || '').trim();
  if (nom.length < 2) throw new HttpErreur(400, 'Indiquez le nom');
  if (!tel) throw new HttpErreur(400, 'Numéro invalide (ex : 77 123 45 67)');
  if ((pinObligatoire || pin) && !/^\d{4}$/.test(pin)) throw new HttpErreur(400, 'Le code PIN doit contenir 4 chiffres');
  const pris = await c.db.query('SELECT id FROM utilisateurs WHERE telephone = $1 AND id <> $2', [tel, Number(id) || 0]);
  if (pris.rows.length) throw new HttpErreur(400, 'Ce numéro est déjà utilisé par un autre compte');
  return { nom, tel, pin };
}

async function creerCompte(req, c, role) {
  const v = await lireCompte(c, await lireCorps(req));
  const r = await c.db.query(
    `INSERT INTO utilisateurs (nom, telephone, pin_hash, role, actif) VALUES ($1, $2, $3, $4, 1)
     RETURNING id, nom, telephone, role, actif`,
    [v.nom, v.tel, await hacherPin(v.pin), role]
  );
  c.io.to('admins').emit('livreurs:changement');
  return json(r.rows[0], 201);
}

async function modifierCompte(req, c, role) {
  const id = Number(c.params.id);
  const v = await lireCompte(c, await lireCorps(req), { id, pinObligatoire: false });
  const r = v.pin
    ? await c.db.query(`UPDATE utilisateurs SET nom = $2, telephone = $3, pin_hash = $4 WHERE id = $1 AND role = '${role}' RETURNING id, nom, telephone`,
      [id, v.nom, v.tel, await hacherPin(v.pin)])
    : await c.db.query(`UPDATE utilisateurs SET nom = $2, telephone = $3 WHERE id = $1 AND role = '${role}' RETURNING id, nom, telephone`,
      [id, v.nom, v.tel]);
  if (!r.rows.length) throw new HttpErreur(404, 'Compte introuvable');
  c.io.to('admins').emit('livreurs:changement');
  return json(r.rows[0]);
}

const FINIES = ['livree', 'annulee'];
async function lireStatut(c) {
  const r = await c.db.query('SELECT id, statut, livreur_id, paiement_statut FROM courses WHERE id = $1', [Number(c.params.id)]);
  if (!r.rows.length) throw new HttpErreur(404, 'Course introuvable');
  return r.rows[0];
}

export function enregistrerGestion(r) {
  r.post('/api/admin/livreurs', async (req, c) => { await exigerAdmin(req, c); return creerCompte(req, c, 'livreur'); });
  r.put('/api/admin/livreurs/:id', async (req, c) => { await exigerAdmin(req, c); return modifierCompte(req, c, 'livreur'); });
  r.delete('/api/admin/livreurs/:id', async (req, c) => {
    await exigerAdmin(req, c);
    const id = Number(c.params.id);
    const enCours = await c.db.query(`SELECT 1 FROM courses WHERE livreur_id = $1 AND statut IN ('acceptee', 'recuperee')`, [id]);
    if (enCours.rows.length) throw new HttpErreur(409, 'Ce livreur a une course en cours : remettez-la en attente avant de le supprimer');
    await c.db.query('UPDATE courses SET livreur_id = NULL WHERE livreur_id = $1', [id]);
    const res = await c.db.query(`DELETE FROM utilisateurs WHERE id = $1 AND role = 'livreur' RETURNING id`, [id]);
    if (!res.rows.length) throw new HttpErreur(404, 'Livreur introuvable');
    c.io.to('admins').emit('livreurs:changement');
    return json({ ok: true });
  });

  r.get('/api/admin/admins', async (req, c) => {
    const u = await exigerAdmin(req, c);
    const res = await c.db.query(`SELECT id, nom, telephone, cree_le FROM utilisateurs WHERE role = 'admin' ORDER BY nom`);
    return json(res.rows.map((x) => ({ ...x, moi: x.id === u.id })));
  });
  r.post('/api/admin/admins', async (req, c) => { await exigerAdmin(req, c); return creerCompte(req, c, 'admin'); });
  r.put('/api/admin/admins/:id', async (req, c) => { await exigerAdmin(req, c); return modifierCompte(req, c, 'admin'); });
  r.delete('/api/admin/admins/:id', async (req, c) => {
    const u = await exigerAdmin(req, c);
    const id = Number(c.params.id);
    if (id === u.id) throw new HttpErreur(400, 'Vous ne pouvez pas supprimer votre propre compte');
    const n = Number((await c.db.query(`SELECT count(*) AS n FROM utilisateurs WHERE role = 'admin'`)).rows[0].n);
    if (n <= 1) throw new HttpErreur(400, 'Il faut garder au moins un administrateur');
    const res = await c.db.query(`DELETE FROM utilisateurs WHERE id = $1 AND role = 'admin' RETURNING id`, [id]);
    if (!res.rows.length) throw new HttpErreur(404, 'Administrateur introuvable');
    return json({ ok: true });
  });

  r.put('/api/admin/lieux/:id', async (req, c) => {
    await exigerAdmin(req, c);
    const { nom, categorie } = await lireCorps(req);
    const n = String(nom || '').trim().slice(0, 120);
    if (n.length < 2) throw new HttpErreur(400, 'Indiquez le nom du lieu');
    const res = await c.db.query(
      'UPDATE lieux SET nom = $2, categorie = $3 WHERE id = $1 RETURNING id, nom, categorie, lat, lng, source',
      [Number(c.params.id), n, CATEGORIES.includes(categorie) ? categorie : 'autre']
    );
    if (!res.rows.length) throw new HttpErreur(404, 'Lieu introuvable');
    return json(res.rows[0]);
  });

  // ---------- Courses ----------
  r.put('/api/admin/courses/:id', async (req, c) => {
    await exigerAdmin(req, c);
    const course = await lireStatut(c);
    const b = await lireCorps(req);
    const texte = (v, max) => String(v || '').trim().slice(0, max);
    const prix = Math.round(Number(b.prix));
    if (!Number.isFinite(prix) || prix < 0) throw new HttpErreur(400, 'Prix invalide');
    if (texte(b.description, 500).length < 2) throw new HttpErreur(400, 'Indiquez ce qu\'il faut livrer');
    if (!texte(b.depart_repere, 300) || !texte(b.arrivee_repere, 300)) throw new HttpErreur(400, 'Indiquez le départ et l\'arrivée');
    const tel = normaliserTel(b.client_tel);
    if (!tel) throw new HttpErreur(400, 'Numéro du client invalide');
    const destTel = b.destinataire_tel ? normaliserTel(b.destinataire_tel) : null;
    if (b.destinataire_tel && !destTel) throw new HttpErreur(400, 'Numéro du destinataire invalide');
    await c.db.query(
      `UPDATE courses SET description = $2, prix = $3, depart_repere = $4, arrivee_repere = $5,
         client_nom = $6, client_tel = $7, destinataire_nom = $8, destinataire_tel = $9 WHERE id = $1`,
      [course.id, texte(b.description, 500), prix, texte(b.depart_repere, 300), texte(b.arrivee_repere, 300),
        texte(b.client_nom, 100) || 'Client', tel, texte(b.destinataire_nom, 100) || null, destTel]
    );
    return json(await diffuserMaj(c, course.id, { notifierClient: false }));
  });

  r.post('/api/admin/courses/:id/annuler', async (req, c) => {
    await exigerAdmin(req, c);
    const course = await lireStatut(c);
    if (FINIES.includes(course.statut)) throw new HttpErreur(400, 'Cette course est déjà terminée');
    await c.db.query(`UPDATE courses SET statut = 'annulee', annulee_le = ${MAINTENANT} WHERE id = $1`, [course.id]);
    const maj = await diffuserMaj(c, course.id, { message: 'Votre livraison a été annulée par Thiak Thiak Dialaw. Appelez-nous pour plus d\'informations.' });
    return json({ ...maj, a_rembourser: course.paiement_statut === 'paye' });
  });

  r.post('/api/admin/courses/:id/liberer', async (req, c) => {
    await exigerAdmin(req, c);
    const course = await lireStatut(c);
    if (!['acceptee', 'recuperee'].includes(course.statut)) throw new HttpErreur(400, 'Seule une course en cours peut être remise en attente');
    await c.db.query(`UPDATE courses SET statut = 'en_attente', livreur_id = NULL, acceptee_le = NULL, recuperee_le = NULL WHERE id = $1`, [course.id]);
    const maj = await diffuserMaj(c, course.id, { message: 'Nous cherchons un autre livreur pour votre livraison.' });
    c.io.to('user:' + course.livreur_id).emit('course:maj', maj);
    await notifierNouvelleCourse(c, maj);
    return json(maj);
  });

  r.post('/api/admin/courses/:id/attribuer', async (req, c) => {
    await exigerAdmin(req, c);
    const course = await lireStatut(c);
    const livreurId = Number((await lireCorps(req)).livreur_id);
    if (!['en_attente', 'acceptee'].includes(course.statut)) throw new HttpErreur(400, 'Cette course ne peut plus changer de livreur');
    const l = (await c.db.query(`SELECT id, actif FROM utilisateurs WHERE id = $1 AND role = 'livreur'`, [livreurId])).rows[0];
    if (!l || !l.actif) throw new HttpErreur(400, 'Choisissez un livreur validé');
    const occupe = await c.db.query(`SELECT 1 FROM courses WHERE livreur_id = $1 AND statut IN ('acceptee', 'recuperee') AND id <> $2`, [livreurId, course.id]);
    if (occupe.rows.length) throw new HttpErreur(409, 'Ce livreur a déjà une course en cours');
    await c.db.query(`UPDATE courses SET statut = 'acceptee', livreur_id = $2, acceptee_le = ${MAINTENANT} WHERE id = $1`, [course.id, livreurId]);
    const maj = await diffuserMaj(c, course.id);
    if (course.livreur_id && course.livreur_id !== livreurId) c.io.to('user:' + course.livreur_id).emit('course:maj', maj);
    await envoyer(c, [livreurId], {
      titre: 'Course attribuée par l\'administrateur', corps: `${maj.depart_repere} → ${maj.arrivee_repere}`,
      url: '/livreur.html', tag: 'course-' + maj.id, urgent: true,
    });
    return json(maj);
  });

  r.post('/api/admin/courses/:id/terminer', async (req, c) => {
    await exigerAdmin(req, c);
    const course = await lireStatut(c);
    if (!['acceptee', 'recuperee'].includes(course.statut)) throw new HttpErreur(400, 'Seule une course en cours peut être marquée livrée');
    await c.db.query(`UPDATE courses SET statut = 'livree', livree_le = ${MAINTENANT}, recuperee_le = coalesce(recuperee_le, ${MAINTENANT}) WHERE id = $1`, [course.id]);
    return json(await diffuserMaj(c, course.id));
  });

  // ---------- Paiement en ligne : vérifier chez Nangu, ou valider à la main ----------
  const erreurPaiement = (e) => new HttpErreur(e.status || 502, e.status ? e.message : 'Nangu ne répond pas : ' + e.message);
  r.post('/api/admin/courses/:id/rapprocher', async (req, c) => {
    await exigerAdmin(req, c);
    try {
      const res = await rapprocher(c, Number(c.params.id));
      return json({ ...res, course: await lireCourse(c, Number(c.params.id)) });
    } catch (e) { throw e instanceof HttpErreur ? e : erreurPaiement(e); }
  });
  r.post('/api/admin/courses/:id/valider-paiement', async (req, c) => {
    const u = await exigerAdmin(req, c);
    const { reference } = await lireCorps(req);
    try {
      return json(await validerManuellement(c, Number(c.params.id), { adminId: u.id, reference }));
    } catch (e) { throw e instanceof HttpErreur ? e : erreurPaiement(e); }
  });

  r.delete('/api/admin/courses/:id', async (req, c) => {
    await exigerAdmin(req, c);
    const course = await lireStatut(c);
    if (['acceptee', 'recuperee'].includes(course.statut)) throw new HttpErreur(409, 'Course en cours : annulez-la ou remettez-la en attente avant de la supprimer');
    await c.db.query('DELETE FROM courses WHERE id = $1', [course.id]);
    c.io.to(['livreurs', 'admins']).emit('courses:changement');
    return json({ ok: true });
  });
}
