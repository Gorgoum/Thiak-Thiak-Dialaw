// Comptes : seuls les livreurs s'inscrivent (l'admin est créé au déploiement, les clients n'ont pas de compte).
import { HttpErreur, json, lireCorps } from '../outils.js';
import { normaliserTel, signer, exiger, hacherPin, verifierPin, limiter, effacerLimite } from '../securite.js';

const vuePublique = (u) => ({ id: u.id, nom: u.nom, telephone: u.telephone, role: u.role, actif: u.actif, disponible: u.disponible });
const MAX_ECHECS = 5;
const BLOCAGE_MS = 15 * 60 * 1000;

export function enregistrer(r) {
  r.post('/api/auth/inscription', async (req, c) => {
    const { nom, telephone, pin } = await lireCorps(req);
    const tel = normaliserTel(telephone);
    if (!nom || String(nom).trim().length < 2) throw new HttpErreur(400, 'Indiquez votre nom');
    if (!tel) throw new HttpErreur(400, 'Numéro invalide (ex : 77 123 45 67)');
    if (!/^\d{4}$/.test(String(pin || ''))) throw new HttpErreur(400, 'Le PIN doit contenir 4 chiffres');
    const existe = await c.db.query('SELECT 1 AS x FROM utilisateurs WHERE telephone = $1', [tel]);
    if (existe.rows.length) throw new HttpErreur(409, 'Ce numéro a déjà un compte, connectez-vous');
    const u = (await c.db.query(
      `INSERT INTO utilisateurs (nom, telephone, pin_hash, role, actif) VALUES ($1, $2, $3, 'livreur', 0) RETURNING *`,
      [String(nom).trim().slice(0, 100), tel, await hacherPin(pin)]
    )).rows[0];
    c.io.to('admins').emit('livreurs:changement');
    return json({ token: await signer(u, c.env.JWT_SECRET), utilisateur: vuePublique(u) }, 201);
  });

  r.post('/api/auth/connexion', async (req, c) => {
    const { telephone, pin } = await lireCorps(req);
    const tel = normaliserTel(telephone);
    if (!tel) throw new HttpErreur(400, 'Numéro invalide');
    const cle = 'pin:' + tel;
    if (await limiter(c.db, cle, MAX_ECHECS, BLOCAGE_MS, { compter: false })) throw new HttpErreur(429, 'Trop d\'essais. Réessayez dans 15 minutes.');
    const u = (await c.db.query('SELECT * FROM utilisateurs WHERE telephone = $1', [tel])).rows[0];
    if (!u || !(await verifierPin(String(pin || ''), u.pin_hash))) {
      await limiter(c.db, cle, MAX_ECHECS, BLOCAGE_MS); // compte l'échec
      throw new HttpErreur(400, 'Numéro ou PIN incorrect');
    }
    await effacerLimite(c.db, cle);
    return json({ token: await signer(u, c.env.JWT_SECRET), utilisateur: vuePublique(u) });
  });

  r.get('/api/auth/moi', async (req, c) => {
    await exiger(req, c);
    const u = (await c.db.query('SELECT * FROM utilisateurs WHERE id = $1', [c.user.id])).rows[0];
    if (!u) throw new HttpErreur(401, 'Compte introuvable');
    return json(vuePublique(u));
  });

  r.post('/api/auth/push', async (req, c) => {
    await exiger(req, c);
    const ab = (await lireCorps(req)).abonnement;
    if (!ab || !ab.endpoint || !ab.keys) throw new HttpErreur(400, 'Abonnement invalide');
    await c.db.query(
      `INSERT INTO abonnements_push (utilisateur_id, endpoint, abonnement) VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET utilisateur_id = excluded.utilisateur_id, abonnement = excluded.abonnement`,
      [c.user.id, ab.endpoint, ab]
    );
    return json({ ok: true });
  });
}
