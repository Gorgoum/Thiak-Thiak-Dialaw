// Thiak Thiak Dialaw sur Cloudflare Workers.
//  - /api/…           : API (même contrat que la version Node)
//  - /ws              : temps réel (WebSocket → Durable Object « Diffusion »)
//  - /webhooks/nangu  : confirmation des paiements Wave / Orange Money
//  - le reste         : pages et fichiers statiques (dossier public/, servi par Cloudflare)
import { Routeur, HttpErreur, json } from './outils.js';
import { creerDb } from './db.js';
import { verifier } from './securite.js';
import { creerIo } from './temps-reel.js';
import * as nangu from './nangu.js';
import { traiterEvenement, releverPaiementsEnAttente } from './paiements.js';
import * as auth from './routes/auth.js';
import * as courses from './routes/courses.js';
import * as livreur from './routes/livreur.js';
import * as admin from './routes/admin.js';
import * as divers from './routes/divers.js';

export { Diffusion } from './temps-reel.js';

const routeur = new Routeur();
[auth, courses, livreur, admin, divers].forEach((m) => m.enregistrer(routeur));

/** Connexion temps réel : on calcule les salles du visiteur, puis le Durable Object garde la connexion. */
async function connecterTempsReel(req, c) {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket attendu', { status: 426 });
  const p = c.url.searchParams;
  const salles = [];
  if (p.get('token')) {
    try {
      const u = await verifier(p.get('token'), c.env.JWT_SECRET);
      salles.push('user:' + u.id);
      if (u.role === 'livreur') salles.push('livreurs');
      if (u.role === 'admin') salles.push('admins');
    } catch { return new Response('non autorisé', { status: 401 }); }
  }
  // codes de suivi des courses du client (secrets : les connaître donne accès au suivi)
  for (const code of String(p.get('suivi') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30)) {
    if (code.length <= 64) salles.push('suivi:' + code);
  }
  if (!salles.length && !p.has('suivi')) return new Response('non autorisé', { status: 401 });
  const cible = new URL('https://diffusion/connecter');
  cible.searchParams.set('salles', JSON.stringify(salles));
  return c.io.stub().fetch(new Request(cible, req));
}

async function webhookNangu(req, c) {
  const brut = await req.text();
  if (!(await nangu.verifierSignature(c.env, brut, req.headers.get('X-Signature')))) return json({ erreur: 'Signature invalide' }, 400);
  let evt;
  try { evt = JSON.parse(brut); } catch { return json({ erreur: 'Corps illisible' }, 400); }
  try {
    await traiterEvenement(c, evt);
    return json({ ok: true });
  } catch (e) {
    console.error('Webhook Nangu :', e.message);
    return json({ erreur: 'Erreur de traitement' }, 500); // Nangu renverra l'événement
  }
}

export default {
  // Toutes les minutes : confirme les paiements en attente auprès de Nangu
  async scheduled(evenement, env, ctx) {
    const attendre = (p) => ctx.waitUntil(p);
    const c = { env, url: new URL('https://planifie/'), attendre, db: creerDb(env.DB), io: creerIo(env, attendre) };
    ctx.waitUntil(releverPaiementsEnAttente(c));
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const attendre = (p) => ctx.waitUntil(p);
    const c = { env, url, attendre, db: creerDb(env.DB), io: creerIo(env, attendre) };
    try {
      if (url.pathname === '/ws') return await connecterTempsReel(req, c);
      if (url.pathname === '/webhooks/nangu' && req.method === 'POST') return await webhookNangu(req, c);
      if (url.pathname.startsWith('/api/')) {
        const rep = await routeur.traiter(req, c);
        return rep || json({ erreur: 'Route inconnue' }, 404);
      }
      // pages, scripts, icônes, carte ; « / » et « /dossier/ » servent leur index.html
      if (url.pathname.endsWith('/')) {
        const index = new URL(url.pathname + 'index.html' + url.search, url);
        return env.ASSETS.fetch(new Request(index, req));
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpErreur) return json({ erreur: e.message }, e.statut);
      console.error(e && e.stack ? e.stack : e);
      return json({ erreur: 'Erreur serveur, réessayez' }, 500);
    }
  },
};
