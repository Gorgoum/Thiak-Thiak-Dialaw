// Resto OUMY DJIAMIL sur Cloudflare Workers (projet séparé de Yobalema Yène).
//  - /api/resto           : informations et menu (public)
//  - /photos/:id.jpg      : photos des plats
//  - /api/admin/…         : page admin (mot de passe)
//  - le reste             : pages du dossier public/ (servies par Cloudflare)
// Secrets (wrangler secret put) : ADMIN_MOT_DE_PASSE, JWT_SECRET
import EXEMPLE from '../donnees-exemple.js';

const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

class Erreur extends Error {
  constructor(statut, message) { super(message); this.statut = statut; }
}
const json = (d, statut = 200, entetes = {}) => new Response(JSON.stringify(d), { status: statut, headers: { 'Content-Type': 'application/json; charset=utf-8', ...entetes } });
const texte = (v, max) => String(v ?? '').trim().slice(0, max);
const entier = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const corps = async (req) => { try { return (await req.json()) || {}; } catch { return {}; } };
const ip = (req) => req.headers.get('CF-Connecting-IP') || 'local';

// ---------------------------------------------------------------- base
async function tous(db, sql, ...v) { return (await db.prepare(sql).bind(...v).all()).results; }
async function un(db, sql, ...v) { return db.prepare(sql).bind(...v).first(); }
async function exec(db, sql, ...v) { return db.prepare(sql).bind(...v).run(); }

/** Base vide (tout premier démarrage) : on charge le menu d'exemple. */
async function preparer(db) {
  if (await un(db, 'SELECT id FROM infos WHERE id = 1')) return;
  const { menu, ...infos } = EXEMPLE;
  const lots = [db.prepare('INSERT OR IGNORE INTO infos (id, donnees) VALUES (1, ?)').bind(JSON.stringify(infos))];
  await db.batch(lots);
  for (const [i, cat] of menu.entries()) {
    const c = await db.prepare('INSERT INTO categories (nom, ordre) VALUES (?, ?)').bind(cat.categorie, i).run();
    const idCat = c.meta.last_row_id;
    await db.batch(cat.plats.map((p, j) => db.prepare('INSERT INTO plats (categorie_id, nom, description, prix, jour, ordre) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(idCat, p.nom, p.description || '', p.prix, p.jour || null, j)));
  }
}

async function lireMenu(db) {
  const ligne = await un(db, 'SELECT donnees FROM infos WHERE id = 1');
  const cats = await tous(db, 'SELECT id, nom FROM categories ORDER BY ordre, id');
  const plats = await tous(db, 'SELECT id, categorie_id, nom, description, prix, jour, disponible, photo_maj, (photo IS NOT NULL) AS a_photo FROM plats ORDER BY ordre, id');
  return {
    infos: ligne ? JSON.parse(ligne.donnees) : {},
    menu: cats.map((c) => ({
      id: c.id,
      nom: c.nom,
      plats: plats.filter((p) => p.categorie_id === c.id).map((p) => ({
        id: p.id, nom: p.nom, description: p.description, prix: p.prix, jour: p.jour, disponible: !!p.disponible,
        photo: p.a_photo ? `/photos/${p.id}.jpg?v=${p.photo_maj || 0}` : null,
      })),
    })),
  };
}

// ---------------------------------------------------------------- jeton admin (HMAC-SHA256)
const b64url = (octets) => btoa(String.fromCharCode(...new Uint8Array(octets))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function cle(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signer(env) {
  const charge = b64url(new TextEncoder().encode(JSON.stringify({ admin: true, exp: Date.now() + 30 * 86400000 })));
  const sig = await crypto.subtle.sign('HMAC', await cle(env.JWT_SECRET), new TextEncoder().encode(charge));
  return `${charge}.${b64url(sig)}`;
}
async function verifier(env, jeton) {
  const [charge, sig] = String(jeton || '').split('.');
  if (!charge || !sig || !env.JWT_SECRET) return false;
  const attendu = b64url(await crypto.subtle.sign('HMAC', await cle(env.JWT_SECRET), new TextEncoder().encode(charge)));
  if (attendu.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ attendu.charCodeAt(i);
  if (diff) return false;
  try {
    const d = JSON.parse(atob(charge.replace(/-/g, '+').replace(/_/g, '/')));
    return d.admin === true && d.exp > Date.now();
  } catch { return false; }
}
/** Comparaison à temps constant (le mot de passe ne se devine pas au temps de réponse). */
async function memeTexte(a, b) {
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Monte ou descend un élément d'une liste ordonnée. */
async function deplacer(db, table, id, sens, filtre = '', ...v) {
  const liste = (await tous(db, `SELECT id FROM ${table} ${filtre} ORDER BY ordre, id`, ...v)).map((x) => x.id);
  const i = liste.indexOf(id);
  const j = i + (sens === 'haut' ? -1 : 1);
  if (i < 0 || j < 0 || j >= liste.length) return;
  [liste[i], liste[j]] = [liste[j], liste[i]];
  await db.batch(liste.map((x, k) => db.prepare(`UPDATE ${table} SET ordre = ? WHERE id = ?`).bind(k, x)));
}

function lirePlat(b) {
  const nom = texte(b.nom, 80);
  const prix = entier(b.prix);
  if (!nom) throw new Erreur(400, 'Donnez un nom au plat');
  if (!Number.isFinite(prix) || prix < 0 || prix > 1000000) throw new Erreur(400, 'Prix invalide');
  return { nom, prix, jour: JOURS.includes(b.jour) ? b.jour : null, description: texte(b.description, 300), disponible: b.disponible === false ? 0 : 1, categorie_id: entier(b.categorie_id) };
}

// ---------------------------------------------------------------- routes
async function api(req, env, url) {
  const db = env.DB;
  const m = req.method;
  const p = url.pathname;
  let r;

  if (m === 'GET' && p === '/api/resto') {
    await preparer(db);
    return json(await lireMenu(db), 200, { 'Cache-Control': 'no-cache' });
  }
  if (m === 'GET' && (r = p.match(/^\/photos\/(\d+)\.jpg$/))) {
    const l = await un(db, 'SELECT photo FROM plats WHERE id = ?', Number(r[1]));
    if (!l || !l.photo) return new Response('', { status: 404 });
    const bin = Uint8Array.from(atob(l.photo), (ch) => ch.charCodeAt(0));
    return new Response(bin, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }

  // ----- admin
  if (m === 'POST' && p === '/api/admin/connexion') {
    if (!env.ADMIN_MOT_DE_PASSE || !env.JWT_SECRET) throw new Erreur(503, 'Mot de passe admin non réglé sur le serveur.');
    const qui = ip(req);
    const depuis = Date.now() - 15 * 60000;
    const n = (await un(db, 'SELECT COUNT(*) AS n FROM essais WHERE ip = ? AND le > ?', qui, depuis)).n;
    if (n >= 8) throw new Erreur(429, 'Trop d\'essais. Réessayez dans 15 minutes.');
    if (!(await memeTexte(String((await corps(req)).mot_de_passe || ''), env.ADMIN_MOT_DE_PASSE))) {
      await db.batch([db.prepare('INSERT INTO essais (ip, le) VALUES (?, ?)').bind(qui, Date.now()), db.prepare('DELETE FROM essais WHERE le < ?').bind(depuis)]);
      throw new Erreur(401, 'Mot de passe incorrect');
    }
    return json({ token: await signer(env) });
  }
  if (!p.startsWith('/api/admin/')) return null;
  if (!(await verifier(env, String(req.headers.get('Authorization') || '').replace(/^Bearer /, '')))) throw new Erreur(401, 'Connectez-vous');
  await preparer(db);
  const b = ['POST', 'PUT'].includes(m) ? await corps(req) : {};

  if (m === 'GET' && p === '/api/admin/menu') return json(await lireMenu(db));

  if (m === 'PUT' && p === '/api/admin/infos') {
    const tel = (v) => String(v || '').replace(/\D/g, '').replace(/^221/, '').slice(0, 9);
    const lat = Number(b.position && b.position.lat);
    const lng = Number(b.position && b.position.lng);
    if (!texte(b.nom, 80)) throw new Erreur(400, 'Le nom du restaurant est obligatoire');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Erreur(400, 'Position du restaurant invalide');
    const yobalema = texte(b.yobalema, 200);
    if (yobalema && !/^https?:\/\//.test(yobalema)) throw new Erreur(400, 'Adresse Yobalema invalide (https://…)');
    const infos = {
      nom: texte(b.nom, 80), slogan: texte(b.slogan, 160), presentation: texte(b.presentation, 600),
      telephone: tel(b.telephone), whatsapp: tel(b.whatsapp), adresse: texte(b.adresse, 160), position: { lat, lng },
      horaires: (Array.isArray(b.horaires) ? b.horaires : []).map((h) => [texte(h && h[0], 40), texte(h && h[1], 40)]).filter((h) => h[0] && h[1]).slice(0, 10),
      yobalema, commandes_fermees: !!b.commandes_fermees,
    };
    await exec(db, 'UPDATE infos SET donnees = ? WHERE id = 1', JSON.stringify(infos));
    return json(infos);
  }

  // catégories
  if (m === 'POST' && p === '/api/admin/categories') {
    const nom = texte(b.nom, 60);
    if (!nom) throw new Erreur(400, 'Donnez un nom à la catégorie');
    const max = (await un(db, 'SELECT COALESCE(MAX(ordre), -1) AS m FROM categories')).m;
    const res = await exec(db, 'INSERT INTO categories (nom, ordre) VALUES (?, ?)', nom, max + 1);
    return json({ id: res.meta.last_row_id }, 201);
  }
  if ((r = p.match(/^\/api\/admin\/categories\/(\d+)(\/deplacer)?$/))) {
    const id = Number(r[1]);
    if (r[2] && m === 'POST') { await deplacer(db, 'categories', id, b.sens); return json({ ok: true }); }
    if (m === 'PUT') {
      const nom = texte(b.nom, 60);
      if (!nom) throw new Erreur(400, 'Donnez un nom à la catégorie');
      await exec(db, 'UPDATE categories SET nom = ? WHERE id = ?', nom, id);
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      const n = (await un(db, 'SELECT COUNT(*) AS n FROM plats WHERE categorie_id = ?', id)).n;
      if (n) throw new Erreur(409, `Cette catégorie contient encore ${n} plat${n > 1 ? 's' : ''}. Supprimez-les ou déplacez-les d'abord.`);
      await exec(db, 'DELETE FROM categories WHERE id = ?', id);
      return json({ ok: true });
    }
  }

  // plats
  if (m === 'POST' && p === '/api/admin/plats') {
    const x = lirePlat(b);
    if (!(await un(db, 'SELECT id FROM categories WHERE id = ?', x.categorie_id))) throw new Erreur(400, 'Catégorie introuvable');
    const max = (await un(db, 'SELECT COALESCE(MAX(ordre), -1) AS m FROM plats WHERE categorie_id = ?', x.categorie_id)).m;
    const res = await exec(db, 'INSERT INTO plats (categorie_id, nom, description, prix, jour, disponible, ordre) VALUES (?, ?, ?, ?, ?, ?, ?)',
      x.categorie_id, x.nom, x.description, x.prix, x.jour, x.disponible, max + 1);
    return json({ id: res.meta.last_row_id }, 201);
  }
  if ((r = p.match(/^\/api\/admin\/plats\/(\d+)(?:\/(deplacer|disponible|photo))?$/))) {
    const id = Number(r[1]);
    const action = r[2];
    const plat = await un(db, 'SELECT id, categorie_id FROM plats WHERE id = ?', id);
    if (!plat) throw new Erreur(404, 'Plat introuvable');
    if (!action && m === 'PUT') {
      const x = lirePlat(b);
      const cat = (await un(db, 'SELECT id FROM categories WHERE id = ?', x.categorie_id)) ? x.categorie_id : plat.categorie_id;
      await exec(db, 'UPDATE plats SET categorie_id = ?, nom = ?, description = ?, prix = ?, jour = ?, disponible = ? WHERE id = ?',
        cat, x.nom, x.description, x.prix, x.jour, x.disponible, id);
      return json({ ok: true });
    }
    if (!action && m === 'DELETE') { await exec(db, 'DELETE FROM plats WHERE id = ?', id); return json({ ok: true }); }
    if (action === 'disponible' && m === 'POST') { await exec(db, 'UPDATE plats SET disponible = ? WHERE id = ?', b.disponible ? 1 : 0, id); return json({ ok: true }); }
    if (action === 'deplacer' && m === 'POST') { await deplacer(db, 'plats', id, b.sens, 'WHERE categorie_id = ?', plat.categorie_id); return json({ ok: true }); }
    if (action === 'photo' && m === 'PUT') {
      const x = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.photo || ''));
      if (!x) throw new Erreur(400, 'Photo invalide (JPEG attendu)');
      if (x[1].length > 1.4e6) throw new Erreur(413, 'Photo trop lourde');
      const debut = atob(x[1].slice(0, 8));
      if (debut.charCodeAt(0) !== 0xff || debut.charCodeAt(1) !== 0xd8) throw new Erreur(400, 'Photo invalide (JPEG attendu)');
      await exec(db, 'UPDATE plats SET photo = ?, photo_maj = ? WHERE id = ?', x[1], Date.now(), id);
      return json({ ok: true });
    }
    if (action === 'photo' && m === 'DELETE') { await exec(db, 'UPDATE plats SET photo = NULL, photo_maj = ? WHERE id = ?', Date.now(), id); return json({ ok: true }); }
  }
  throw new Erreur(404, 'Introuvable');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/sante') return json({ ok: true });
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/photos/')) {
      try {
        const rep = await api(req, env, url);
        if (rep) return rep;
        return json({ erreur: 'Introuvable' }, 404);
      } catch (e) {
        if (e instanceof Erreur) return json({ erreur: e.message }, e.statut);
        console.error(e);
        return json({ erreur: 'Erreur du serveur, réessayez' }, 500);
      }
    }
    // la page d'accueil (« / ») est index.html
    if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', url), req));
    return env.ASSETS.fetch(req);
  },
};
