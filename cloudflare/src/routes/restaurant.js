// Restaurants partenaires (ex. : Resto OUMY DJIAMIL), version Cloudflare (même contrat que la version Node).
//  - /api/restaurant/…        : le restaurant se connecte (téléphone + PIN), voit ses commandes, signale « plats prêts »
//  - /api/admin/restaurants/… : l'admin crée et gère les comptes restaurant
import { HttpErreur, json, lireCorps, texte } from '../outils.js';
import { MAINTENANT } from '../db.js';
import { normaliserTel, signer, exiger, hacherPin, verifierPin, limiter, effacerLimite } from '../securite.js';
import { SELECT_COURSE, diffuserMaj } from '../courses-service.js';
import { envoyer } from '../push.js';

const ACTIFS = "('en_attente', 'attente_paiement', 'acceptee', 'recuperee')";

/** Ce que voit le restaurant d'une commande : les plats et le livreur, pas le téléphone ni l'adresse du client. */
const vueCommande = (c) => ({
  id: c.id, statut: c.statut, description: c.description, montant_achat: c.montant_achat,
  cree_le: c.cree_le, acceptee_le: c.acceptee_le, arrive_le: c.arrive_le, recuperee_le: c.recuperee_le, livree_le: c.livree_le, annulee_le: c.annulee_le,
  plats_prets_le: c.plats_prets_le, commission_resto: c.commission_resto || 0, client_prenom: String(c.client_nom || '').split(/\s+/)[0],
  livreur_nom: c.livreur_nom || null, livreur_tel: c.livreur_tel || null, livreur_vehicule: c.livreur_vehicule || null,
});

function lireRestaurant(b, creation) {
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const r = {
    nom: texte(b.nom, 80), adresse: texte(b.adresse, 160) || null, actif: b.actif !== false,
    code: texte(b.code, 40).toLowerCase(), telephone: normaliserTel(b.telephone), lat, lng,
    site: texte(b.site, 200) || null,
    commission_pct: Math.max(0, Math.min(50, Math.round(Number(b.commission_pct ?? 10)) || 0)),
  };
  if (r.site && !/^https:\/\/[^\s]+$/.test(r.site)) throw new HttpErreur(400, 'Adresse du site invalide (https://…)');
  if (r.nom.length < 2) throw new HttpErreur(400, 'Indiquez le nom du restaurant');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpErreur(400, 'Position du restaurant invalide');
  if (creation) {
    if (!/^[a-z0-9-]{3,40}$/.test(r.code)) throw new HttpErreur(400, 'Code : 3 à 40 lettres minuscules, chiffres ou tirets (ex : oumy-djiamil)');
    if (!r.telephone) throw new HttpErreur(400, 'Numéro invalide (ex : 77 123 45 67)');
  }
  if ((creation || b.pin) && !/^\d{4}$/.test(String(b.pin || ''))) throw new HttpErreur(400, 'Le PIN doit contenir 4 chiffres');
  return r;
}


/** Commandes d'un restaurant sur un mois (« 2026-11 ») : la liste et le bilan (ventes et commission des commandes livrées). */
function bilanCommandes(lignes) {
  const livrees = lignes.filter((c) => c.statut === 'livree');
  return {
    nb: lignes.length,
    livrees: livrees.length,
    annulees: lignes.filter((c) => c.statut === 'annulee').length,
    ventes: livrees.reduce((s, c) => s + (Number(c.montant_achat) || 0), 0),
    commission: livrees.reduce((s, c) => s + (Number(c.commission_resto) || 0), 0),
  };
}
function bornesMois(mois) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mois || ''));
  const debut = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const fin = new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth() + 1, 1));
  return [debut.toISOString(), fin.toISOString()];
}

export function enregistrer(r) {
  // liste publique des restaurants partenaires (tuile « Food » de l'accueil)
  r.get('/api/restaurants', async (req, c) => {
    const res = await c.db.query('SELECT code, nom, adresse, site, lat, lng FROM restaurants WHERE actif = 1 AND site IS NOT NULL ORDER BY nom');
    return json(res.rows);
  });

  // ---------------------------------------------------------------- espace restaurant
  r.post('/api/restaurant/connexion', async (req, c) => {
    const b = await lireCorps(req);
    const tel = normaliserTel(b.telephone);
    if (!tel) throw new HttpErreur(400, 'Numéro invalide');
    const cle = 'resto:' + tel;
    if (await limiter(c.db, cle, 5, 15 * 60000, { compter: false })) throw new HttpErreur(429, 'Trop d\'essais. Réessayez dans 15 minutes.');
    const resto = (await c.db.query('SELECT * FROM restaurants WHERE telephone = $1', [tel])).rows[0];
    if (!resto || !(await verifierPin(String(b.pin || ''), resto.pin_hash))) {
      await limiter(c.db, cle, 5, 15 * 60000);
      throw new HttpErreur(400, 'Numéro ou PIN incorrect');
    }
    if (!resto.actif) throw new HttpErreur(403, 'Ce compte restaurant est désactivé. Contactez Yobalema.');
    await effacerLimite(c.db, cle);
    return json({ token: await signer({ id: resto.id, role: 'restaurant', nom: resto.nom }, c.env.JWT_SECRET), restaurant: { id: resto.id, nom: resto.nom, code: resto.code } });
  });

  r.get('/api/restaurant/moi', async (req, c) => {
    await exiger(req, c, 'restaurant');
    const resto = (await c.db.query('SELECT id, nom, code, actif FROM restaurants WHERE id = $1', [c.user.id])).rows[0];
    if (!resto || !resto.actif) throw new HttpErreur(401, 'Compte introuvable ou désactivé');
    return json(resto);
  });

  r.get('/api/restaurant/commandes', async (req, c) => {
    await exiger(req, c, 'restaurant');
    const depuis = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await c.db.query(
      `${SELECT_COURSE} WHERE c.restaurant_id = $1 AND (c.statut IN ${ACTIFS} OR c.cree_le > $2) ORDER BY c.cree_le DESC LIMIT 50`,
      [c.user.id, depuis]
    );
    return json(res.rows.map(vueCommande));
  });

  r.post('/api/restaurant/commandes/:id/prets', async (req, c) => {
    await exiger(req, c, 'restaurant');
    const res = await c.db.query(
      `UPDATE courses SET plats_prets_le = ${MAINTENANT}
       WHERE id = $1 AND restaurant_id = $2 AND statut IN ('en_attente', 'acceptee') AND plats_prets_le IS NULL RETURNING id, livreur_id`,
      [Number(c.params.id), c.user.id]
    );
    if (!res.rows.length) throw new HttpErreur(409, 'Commande déjà prête, partie ou annulée');
    await diffuserMaj(c, res.rows[0].id, { notifierClient: false, notifierDest: false });
    c.io.to('livreurs').emit('courses:changement');
    if (res.rows[0].livreur_id) {
      c.attendre(envoyer(c, [res.rows[0].livreur_id], { titre: 'Plats prêts', corps: `${c.user.nom} : vous pouvez venir chercher la commande.` }).catch(() => {}));
    }
    return json({ ok: true });
  });

  // ---------------------------------------------------------------- gestion par l'admin
  r.get('/api/admin/restaurants', async (req, c) => {
    await exiger(req, c, 'admin');
    const res = await c.db.query('SELECT id, code, nom, telephone, lat, lng, adresse, actif, site, commission_pct, cree_le FROM restaurants ORDER BY nom');
    const nb = new Map((await c.db.query('SELECT restaurant_id, COUNT(*) AS n FROM courses WHERE restaurant_id IS NOT NULL GROUP BY restaurant_id')).rows.map((x) => [x.restaurant_id, Number(x.n)]));
    return json(res.rows.map((x) => ({ ...x, nb_commandes: nb.get(x.id) || 0 })));
  });

  r.get('/api/admin/restaurants/:id/commandes', async (req, c) => {
    await exiger(req, c, 'admin');
    const [du, au] = bornesMois(c.url.searchParams.get('mois'));
    const res = await c.db.query(`${SELECT_COURSE} WHERE c.restaurant_id = $1 AND c.cree_le >= $2 AND c.cree_le < $3 ORDER BY c.cree_le DESC`, [Number(c.params.id), du, au]);
    return json({ lignes: res.rows, bilan: bilanCommandes(res.rows) });
  });

  r.post('/api/admin/restaurants', async (req, c) => {
    await exiger(req, c, 'admin');
    const b = await lireCorps(req);
    const x = lireRestaurant(b, true);
    if ((await c.db.query('SELECT 1 FROM restaurants WHERE code = $1 OR telephone = $2', [x.code, x.telephone])).rows.length) {
      throw new HttpErreur(409, 'Ce code ou ce numéro est déjà utilisé par un restaurant');
    }
    const ins = await c.db.query(
      'INSERT INTO restaurants (code, nom, telephone, pin_hash, lat, lng, adresse, actif, site, commission_pct) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
      [x.code, x.nom, x.telephone, await hacherPin(String(b.pin)), x.lat, x.lng, x.adresse, x.actif, x.site, x.commission_pct]
    );
    return json({ id: ins.rows[0].id }, 201);
  });

  r.put('/api/admin/restaurants/:id', async (req, c) => {
    await exiger(req, c, 'admin');
    const b = await lireCorps(req);
    const x = lireRestaurant(b, false);
    const id = Number(c.params.id);
    await c.db.query('UPDATE restaurants SET nom = $2, adresse = $3, lat = $4, lng = $5, actif = $6, site = $7, commission_pct = $8 WHERE id = $1', [id, x.nom, x.adresse, x.lat, x.lng, x.actif, x.site, x.commission_pct]);
    if (b.pin) await c.db.query('UPDATE restaurants SET pin_hash = $2 WHERE id = $1', [id, await hacherPin(String(b.pin))]);
    // nouveau numéro de connexion (unique entre restaurants)
    if (b.telephone) {
      if (!x.telephone) throw new HttpErreur(400, 'Numéro invalide (ex : 77 123 45 67)');
      if ((await c.db.query('SELECT 1 FROM restaurants WHERE telephone = $1 AND id <> $2', [x.telephone, id])).rows.length) throw new HttpErreur(409, 'Ce numéro est déjà utilisé par un autre restaurant');
      await c.db.query('UPDATE restaurants SET telephone = $2 WHERE id = $1', [id, x.telephone]);
    }
    return json({ ok: true });
  });
}
