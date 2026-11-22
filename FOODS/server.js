// Resto OUMY DJIAMIL : site public (menu), API, page admin.
// Hébergé sur Render, base PostgreSQL sur Neon.
// Variables à régler sur Render :
//   DATABASE_URL        adresse de la base Neon (postgresql://…)
//   ADMIN_MOT_DE_PASSE  mot de passe de la page admin
//   JWT_SECRET          clé secrète des sessions admin (Render peut la générer)
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { query, preparer, memoire } = require('./db');

const app = express();
const PORT = process.env.PORT || 3100;
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const MOT_DE_PASSE = process.env.ADMIN_MOT_DE_PASSE || (process.env.DATABASE_URL ? '' : 'oumy2026'); // essai local seulement
const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

app.set('trust proxy', 1); // Render est devant le serveur
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});
app.use(express.json({ limit: '3mb' })); // photo envoyée en base64 (déjà réduite par le téléphone)

const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const texte = (v, max) => String(v ?? '').trim().slice(0, max);
const entier = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

// ---------------------------------------------------------------- public
async function lireMenu({ avecIndispo = true } = {}) {
  const infos = (await query('SELECT donnees FROM infos WHERE id = 1')).rows[0]?.donnees || {};
  const cats = (await query('SELECT id, nom, ordre FROM categories ORDER BY ordre, id')).rows;
  const plats = (await query(
    `SELECT id, categorie_id, nom, description, prix, jour, disponible, ordre, photo_maj, (photo IS NOT NULL) AS a_photo
     FROM plats ORDER BY ordre, id`
  )).rows;
  return {
    infos: typeof infos === 'string' ? JSON.parse(infos) : infos,
    menu: cats.map((c) => ({
      id: c.id,
      nom: c.nom,
      plats: plats.filter((p) => p.categorie_id === c.id && (avecIndispo || p.disponible)).map((p) => ({
        id: p.id, nom: p.nom, description: p.description, prix: p.prix, jour: p.jour, disponible: p.disponible,
        photo: p.a_photo ? `/photos/${p.id}.jpg?v=${new Date(p.photo_maj || 0).getTime()}` : null,
      })),
    })),
  };
}

app.get('/api/resto', a(async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await lireMenu());
}));

app.get('/photos/:id.jpg', a(async (req, res) => {
  const r = await query('SELECT photo FROM plats WHERE id = $1', [entier(req.params.id)]);
  if (!r.rows[0] || !r.rows[0].photo) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(Buffer.from(r.rows[0].photo, 'base64'));
}));

app.get('/sante', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- admin
// Anti-devinette : 8 essais ratés par adresse IP et par quart d'heure
const essais = new Map();
function tropDEssais(ip) {
  const maintenant = Date.now();
  const liste = (essais.get(ip) || []).filter((t) => maintenant - t < 15 * 60000);
  essais.set(ip, liste);
  return liste.length >= 8;
}

app.post('/api/admin/connexion', a(async (req, res) => {
  if (!MOT_DE_PASSE) return res.status(503).json({ erreur: 'Mot de passe admin non réglé sur le serveur (ADMIN_MOT_DE_PASSE).' });
  if (tropDEssais(req.ip)) return res.status(429).json({ erreur: 'Trop d\'essais. Réessayez dans 15 minutes.' });
  const donne = Buffer.from(String((req.body || {}).mot_de_passe || ''));
  const attendu = Buffer.from(MOT_DE_PASSE);
  const bon = donne.length === attendu.length && crypto.timingSafeEqual(donne, attendu);
  if (!bon) {
    essais.get(req.ip).push(Date.now());
    return res.status(401).json({ erreur: 'Mot de passe incorrect' });
  }
  res.json({ token: jwt.sign({ admin: true }, SECRET, { expiresIn: '30d' }) });
}));

function exigerAdmin(req, res, next) {
  const t = String(req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    if (jwt.verify(t, SECRET).admin) return next();
  } catch { /* jeton absent, faux ou expiré */ }
  res.status(401).json({ erreur: 'Connectez-vous' });
}
app.use('/api/admin', (req, res, next) => (req.path === '/connexion' ? next() : exigerAdmin(req, res, next)));

app.get('/api/admin/menu', a(async (req, res) => res.json(await lireMenu())));

// Informations du restaurant
app.put('/api/admin/infos', a(async (req, res) => {
  const b = req.body || {};
  const tel = (v) => String(v || '').replace(/\D/g, '').replace(/^221/, '').slice(0, 9);
  const lat = Number(b.position && b.position.lat);
  const lng = Number(b.position && b.position.lng);
  if (!texte(b.nom, 80)) return res.status(400).json({ erreur: 'Le nom du restaurant est obligatoire' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ erreur: 'Position du restaurant invalide' });
  }
  const horaires = (Array.isArray(b.horaires) ? b.horaires : [])
    .map((h) => [texte(h && h[0], 40), texte(h && h[1], 40)]).filter((h) => h[0] && h[1]).slice(0, 10);
  const yobalema = texte(b.yobalema, 200);
  if (yobalema && !/^https?:\/\//.test(yobalema)) return res.status(400).json({ erreur: 'Adresse Yobalema invalide (https://…)' });
  const infos = {
    nom: texte(b.nom, 80),
    slogan: texte(b.slogan, 160),
    presentation: texte(b.presentation, 600),
    telephone: tel(b.telephone),
    whatsapp: tel(b.whatsapp),
    adresse: texte(b.adresse, 160),
    position: { lat, lng },
    horaires,
    yobalema,
    commandes_fermees: !!b.commandes_fermees,
  };
  await query('UPDATE infos SET donnees = $1 WHERE id = 1', [JSON.stringify(infos)]);
  res.json(infos);
}));

// Catégories
app.post('/api/admin/categories', a(async (req, res) => {
  const nom = texte((req.body || {}).nom, 60);
  if (!nom) return res.status(400).json({ erreur: 'Donnez un nom à la catégorie' });
  const max = (await query('SELECT COALESCE(MAX(ordre), -1) AS m FROM categories')).rows[0].m;
  const r = await query('INSERT INTO categories (nom, ordre) VALUES ($1, $2) RETURNING id', [nom, Number(max) + 1]);
  res.status(201).json({ id: r.rows[0].id });
}));
app.put('/api/admin/categories/:id', a(async (req, res) => {
  const nom = texte((req.body || {}).nom, 60);
  if (!nom) return res.status(400).json({ erreur: 'Donnez un nom à la catégorie' });
  await query('UPDATE categories SET nom = $2 WHERE id = $1', [entier(req.params.id), nom]);
  res.json({ ok: true });
}));
app.delete('/api/admin/categories/:id', a(async (req, res) => {
  const id = entier(req.params.id);
  const n = (await query('SELECT COUNT(*)::int AS n FROM plats WHERE categorie_id = $1', [id])).rows[0].n;
  if (n) return res.status(409).json({ erreur: `Cette catégorie contient encore ${n} plat${n > 1 ? 's' : ''}. Supprimez-les ou déplacez-les d'abord.` });
  await query('DELETE FROM categories WHERE id = $1', [id]);
  res.json({ ok: true });
}));

/** Monte ou descend un élément d'une liste ordonnée (catégories, plats d'une catégorie). */
async function deplacer(table, id, sens, filtre = '', valeurs = []) {
  const liste = (await query(`SELECT id FROM ${table} ${filtre} ORDER BY ordre, id`, valeurs)).rows.map((x) => x.id);
  const i = liste.indexOf(id);
  const j = i + (sens === 'haut' ? -1 : 1);
  if (i < 0 || j < 0 || j >= liste.length) return;
  [liste[i], liste[j]] = [liste[j], liste[i]];
  for (const [k, x] of liste.entries()) await query(`UPDATE ${table} SET ordre = $2 WHERE id = $1`, [x, k]);
}
app.post('/api/admin/categories/:id/deplacer', a(async (req, res) => {
  await deplacer('categories', entier(req.params.id), (req.body || {}).sens);
  res.json({ ok: true });
}));

// Plats
function lirePlat(b) {
  const nom = texte(b.nom, 80);
  const prix = entier(b.prix);
  const jour = JOURS.includes(b.jour) ? b.jour : null;
  if (!nom) return { erreur: 'Donnez un nom au plat' };
  if (!Number.isFinite(prix) || prix < 0 || prix > 1000000) return { erreur: 'Prix invalide' };
  return { nom, prix, jour, description: texte(b.description, 300), disponible: b.disponible !== false, categorie_id: entier(b.categorie_id) };
}
app.post('/api/admin/plats', a(async (req, res) => {
  const p = lirePlat(req.body || {});
  if (p.erreur) return res.status(400).json(p);
  if (!(await query('SELECT id FROM categories WHERE id = $1', [p.categorie_id])).rows.length) return res.status(400).json({ erreur: 'Catégorie introuvable' });
  const max = (await query('SELECT COALESCE(MAX(ordre), -1) AS m FROM plats WHERE categorie_id = $1', [p.categorie_id])).rows[0].m;
  const r = await query(
    'INSERT INTO plats (categorie_id, nom, description, prix, jour, disponible, ordre) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [p.categorie_id, p.nom, p.description, p.prix, p.jour, p.disponible, Number(max) + 1]
  );
  res.status(201).json({ id: r.rows[0].id });
}));
app.put('/api/admin/plats/:id', a(async (req, res) => {
  const p = lirePlat(req.body || {});
  if (p.erreur) return res.status(400).json(p);
  const id = entier(req.params.id);
  const avant = (await query('SELECT categorie_id FROM plats WHERE id = $1', [id])).rows[0];
  if (!avant) return res.status(404).json({ erreur: 'Plat introuvable' });
  const cat = (await query('SELECT id FROM categories WHERE id = $1', [p.categorie_id])).rows.length ? p.categorie_id : avant.categorie_id;
  await query('UPDATE plats SET categorie_id = $2, nom = $3, description = $4, prix = $5, jour = $6, disponible = $7 WHERE id = $1',
    [id, cat, p.nom, p.description, p.prix, p.jour, p.disponible]);
  res.json({ ok: true });
}));
// « Épuisé » / « Disponible » d'un toucher
app.post('/api/admin/plats/:id/disponible', a(async (req, res) => {
  await query('UPDATE plats SET disponible = $2 WHERE id = $1', [entier(req.params.id), !!(req.body || {}).disponible]);
  res.json({ ok: true });
}));
app.delete('/api/admin/plats/:id', a(async (req, res) => {
  await query('DELETE FROM plats WHERE id = $1', [entier(req.params.id)]);
  res.json({ ok: true });
}));
app.post('/api/admin/plats/:id/deplacer', a(async (req, res) => {
  const id = entier(req.params.id);
  const p = (await query('SELECT categorie_id FROM plats WHERE id = $1', [id])).rows[0];
  if (p) await deplacer('plats', id, (req.body || {}).sens, 'WHERE categorie_id = $1', [p.categorie_id]);
  res.json({ ok: true });
}));
// Photo : JPEG en base64, déjà réduite par le téléphone (au plus ~1,5 Mo)
app.put('/api/admin/plats/:id/photo', a(async (req, res) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).photo || ''));
  if (!m) return res.status(400).json({ erreur: 'Photo invalide (JPEG attendu)' });
  const octets = Buffer.from(m[1], 'base64');
  if (octets.length > 1.5 * 1024 * 1024) return res.status(413).json({ erreur: 'Photo trop lourde' });
  if (octets[0] !== 0xff || octets[1] !== 0xd8) return res.status(400).json({ erreur: 'Photo invalide (JPEG attendu)' });
  await query('UPDATE plats SET photo = $2, photo_maj = NOW() WHERE id = $1', [entier(req.params.id), octets.toString('base64')]);
  res.json({ ok: true });
}));
app.delete('/api/admin/plats/:id/photo', a(async (req, res) => {
  await query('UPDATE plats SET photo = NULL, photo_maj = NOW() WHERE id = $1', [entier(req.params.id)]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- pages
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return res.status(413).json({ erreur: 'Fichier trop lourd' });
  console.error(err);
  res.status(500).json({ erreur: 'Erreur du serveur, réessayez' });
});

preparer()
  .then(() => app.listen(PORT, () => {
    console.log(`Resto OUMY DJIAMIL : http://localhost:${PORT}`);
    if (memoire()) console.log('Base en mémoire (essai) : mot de passe admin « oumy2026 ». Rien n\'est gardé à l\'arrêt.');
  }))
  .catch((e) => { console.error('Démarrage impossible :', e.message); process.exit(1); });
