// Routes administrateur : tableau de bord, livreurs, courses, lieux, tarifs.
import { HttpErreur, json, lireCorps } from '../outils.js';
import { DEBUT_JOUR } from '../db.js';
import { exiger } from '../securite.js';
import { parametres, pointValide } from '../tarifs.js';
import { SELECT_COURSE } from '../courses-service.js';
import { CATEGORIES } from '../lieux.js';

const CLES = ['prix_base', 'prix_km', 'prix_min', 'facteur_route', 'commission_pct', 'rayon_km', 'zone_km'];

export function enregistrer(r) {
  r.get('/api/admin/stats', async (req, c) => {
    await exiger(req, c, 'admin');
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
    await exiger(req, c, 'admin');
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
    await exiger(req, c, 'admin');
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
    await exiger(req, c, 'admin');
    const statut = c.url.searchParams.get('statut');
    const res = statut
      ? await c.db.query(SELECT_COURSE + ' WHERE c.statut = $1 ORDER BY c.cree_le DESC LIMIT 100', [statut])
      : await c.db.query(SELECT_COURSE + ' ORDER BY c.cree_le DESC LIMIT 100');
    return json(res.rows);
  });

  r.post('/api/admin/lieux', async (req, c) => {
    await exiger(req, c, 'admin');
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
    await exiger(req, c, 'admin');
    return json((await c.db.query(
      'SELECT id, nom, categorie, lat, lng, vu_fois, cree_le FROM lieux WHERE valide = 0 ORDER BY vu_fois DESC, cree_le DESC LIMIT 100'
    )).rows);
  });

  r.post('/api/admin/lieux/:id/valider', async (req, c) => {
    await exiger(req, c, 'admin');
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
    await exiger(req, c, 'admin');
    const res = await c.db.query('DELETE FROM lieux WHERE id = $1 RETURNING id', [Number(c.params.id)]);
    if (!res.rows.length) throw new HttpErreur(404, 'Lieu introuvable');
    return json({ ok: true });
  });

  r.get('/api/admin/parametres', async (req, c) => {
    await exiger(req, c, 'admin');
    return json(await parametres(c.db));
  });

  r.put('/api/admin/parametres', async (req, c) => {
    await exiger(req, c, 'admin');
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
