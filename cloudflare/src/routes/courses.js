// Routes publiques côté client : pas de compte, le client est identifié par le code de suivi de sa course.
import { HttpErreur, json, lireCorps, texte, adresseIp, codeAleatoire } from '../outils.js';
import { MAINTENANT } from '../db.js';
import { normaliserTel, limiter } from '../securite.js';
import { devis, pointValide, distanceKm } from '../tarifs.js';
import { SELECT_COURSE, lireCourse, notifierNouvelleCourse, diffuserMaj } from '../courses-service.js';
import * as nangu from '../nangu.js';
import * as paiements from '../paiements.js';

const MAX_PAR_HEURE = 10;          // demandes par adresse IP
const MAX_EN_ATTENTE_PAR_TEL = 3;  // commandes en attente par numéro

export function enregistrer(r) {
  r.post('/api/courses/devis', async (req, c) => {
    const { depart, arrivee } = await lireCorps(req);
    if (!pointValide(depart) || !pointValide(arrivee)) throw new HttpErreur(400, 'Points invalides');
    return json(await devis(c, depart, arrivee));
  });

  r.post('/api/courses', async (req, c) => {
    const b = await lireCorps(req);
    const clientNom = texte(b.client_nom, 100);
    const clientTel = normaliserTel(b.client_tel);
    if (clientNom.length < 2) throw new HttpErreur(400, 'Indiquez votre nom');
    if (!clientTel) throw new HttpErreur(400, 'Votre numéro est invalide (ex : 77 123 45 67)');
    if (!pointValide(b.depart) || !pointValide(b.arrivee)) throw new HttpErreur(400, 'Placez le départ et l\'arrivée sur la carte');
    if (distanceKm(b.depart, b.arrivee) < 0.03) throw new HttpErreur(400, 'Le départ et l\'arrivée sont au même endroit');
    const departRepere = texte(b.depart_repere);
    const arriveeRepere = texte(b.arrivee_repere);
    const description = texte(b.description, 500);
    if (!departRepere || !arriveeRepere) throw new HttpErreur(400, 'Indiquez un repère pour le départ et l\'arrivée');
    if (!description) throw new HttpErreur(400, 'Décrivez ce qu\'il faut livrer');

    const type = b.type === 'achat' ? 'achat' : 'colis';
    const montantAchat = type === 'achat' ? Math.max(0, Math.round(Number(b.montant_achat) || 0)) : 0;
    let destTel = null;
    if (b.destinataire_tel) {
      destTel = normaliserTel(b.destinataire_tel);
      if (!destTel) throw new HttpErreur(400, 'Numéro du destinataire invalide');
    }

    const enAttente = await c.db.query(`SELECT id FROM courses WHERE client_tel = $1 AND statut IN ('en_attente', 'attente_paiement')`, [clientTel]);
    if (enAttente.rows.length >= MAX_EN_ATTENTE_PAR_TEL) throw new HttpErreur(429, 'Vous avez déjà 3 demandes en attente. Patientez ou annulez-en une.');
    if (await limiter(c.db, 'cmd:' + adresseIp(req), MAX_PAR_HEURE, 3600 * 1000)) throw new HttpErreur(429, 'Trop de demandes. Réessayez dans une heure.');

    const paiement = ['wave', 'orange_money'].includes(b.paiement) ? b.paiement : 'especes';
    if (paiement !== 'especes' && !nangu.fournisseurs(c.env).includes(paiement)) {
      throw new HttpErreur(400, 'Ce moyen de paiement n\'est pas disponible. Choisissez les espèces.');
    }
    const enLigne = paiement !== 'especes';

    const d = await devis(c, b.depart, b.arrivee); // le prix est toujours recalculé côté serveur
    const code = codeAleatoire(16);
    const ins = await c.db.query(
      `INSERT INTO courses (client_nom, client_tel, suivi_token, type, description, montant_achat,
         depart_lat, depart_lng, depart_repere, arrivee_lat, arrivee_lng, arrivee_repere,
         destinataire_nom, destinataire_tel, distance_km, prix, paiement, paiement_statut, statut)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [clientNom, clientTel, code, type, description, montantAchat,
        Number(b.depart.lat), Number(b.depart.lng), departRepere, Number(b.arrivee.lat), Number(b.arrivee.lng), arriveeRepere,
        texte(b.destinataire_nom, 100) || null, destTel, d.distance_km, d.prix,
        paiement, enLigne ? 'en_attente' : 'a_la_livraison', enLigne ? 'attente_paiement' : 'en_attente']
    );
    const id = ins.rows[0].id;

    if (!enLigne) {
      const course = await lireCourse(c, id);
      c.attendre(notifierNouvelleCourse(c, course).catch((e) => console.error('Notification :', e.message)));
      return json({ ...course, suivi_token: code }, 201);
    }

    // Paiement en ligne : la course reste invisible des livreurs jusqu'à la confirmation
    try {
      const p = await nangu.creerPaiement(c.env, { id, suivi: code, prix: d.prix, client_tel: clientTel, depart_repere: departRepere, arrivee_repere: arriveeRepere }, paiement);
      const infos = nangu.infosPaiement(c.env, p);
      await c.db.query('UPDATE courses SET nangu_id = $2, montant_du = $3, paiement_infos = $4 WHERE id = $1', [id, p.id, p.amount_due, infos]);
      const course = await lireCourse(c, id);
      return json({ ...course, suivi_token: code, paiement_infos: infos }, 201);
    } catch (e) {
      await c.db.query(`UPDATE courses SET statut = 'annulee', paiement_statut = 'annule', annulee_le = ${MAINTENANT} WHERE id = $1`, [id]);
      console.error('Création du paiement Nangu :', e.message);
      throw new HttpErreur(502, `Paiement ${paiement === 'wave' ? 'Wave' : 'Orange Money'} indisponible pour le moment (${e.message}). Réessayez ou choisissez les espèces.`);
    }
  });

  r.get('/api/courses/suivi/:code/paiement', async (req, c) => {
    const lire = async () => (await c.db.query(
      'SELECT id, statut, paiement, paiement_statut, nangu_id, montant_du, paiement_infos FROM courses WHERE suivi_token = $1',
      [c.params.code]
    )).rows[0];
    let x = await lire();
    if (!x) throw new HttpErreur(404, 'Course introuvable');
    if (x.paiement_statut === 'en_attente' && x.nangu_id) {
      await paiements.synchroniser(c, x.nangu_id); // secours au webhook
      x = await lire();
    }
    return json({ statut: x.statut, paiement: x.paiement, paiement_statut: x.paiement_statut, montant_du: x.montant_du, infos: x.paiement_infos });
  });

  r.get('/api/courses/suivi', async (req, c) => {
    const codes = String(c.url.searchParams.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
    if (!codes.length) return json([]);
    const marques = codes.map((_, i) => '$' + (i + 1)).join(', ');
    const res = await c.db.query(
      SELECT_COURSE.replace('SELECT ', 'SELECT c.suivi_token, ') + ` WHERE c.suivi_token IN (${marques}) ORDER BY c.cree_le DESC`,
      codes
    );
    return json(res.rows);
  });

  r.post('/api/courses/suivi/:code/annuler', async (req, c) => {
    const res = await c.db.query(
      `UPDATE courses SET statut = 'annulee', annulee_le = ${MAINTENANT},
         paiement_statut = CASE WHEN paiement_statut = 'en_attente' THEN 'annule' ELSE paiement_statut END
       WHERE suivi_token = $1 AND statut IN ('en_attente', 'attente_paiement')
       RETURNING id, nangu_id, paiement_statut`,
      [c.params.code]
    );
    if (!res.rows.length) throw new HttpErreur(409, 'Cette course ne peut plus être annulée (déjà prise par un livreur)');
    const { id, nangu_id: nanguId, paiement_statut: etat } = res.rows[0];
    if (nanguId && etat === 'annule') c.attendre(nangu.annulerPaiement(c.env, nanguId).catch((e) => console.error('Annulation Nangu :', e.message)));
    return json(await diffuserMaj(c, id, { notifierClient: false }));
  });

  r.post('/api/courses/suivi/:code/noter', async (req, c) => {
    const note = Number((await lireCorps(req)).note);
    if (!Number.isInteger(note) || note < 1 || note > 5) throw new HttpErreur(400, 'Note entre 1 et 5');
    const res = await c.db.query(`UPDATE courses SET note = $2 WHERE suivi_token = $1 AND statut = 'livree' RETURNING id`, [c.params.code, note]);
    if (!res.rows.length) throw new HttpErreur(409, 'Seule une course livrée peut être notée');
    return json(await lireCourse(c, res.rows[0].id));
  });

  r.post('/api/courses/suivi/:code/push', async (req, c) => {
    const ab = (await lireCorps(req)).abonnement;
    if (!ab || !ab.endpoint || !ab.keys) throw new HttpErreur(400, 'Abonnement invalide');
    const res = await c.db.query('UPDATE courses SET abonnement_push = $2 WHERE suivi_token = $1 RETURNING id', [c.params.code, ab]);
    if (!res.rows.length) throw new HttpErreur(404, 'Course introuvable');
    return json({ ok: true });
  });
}
