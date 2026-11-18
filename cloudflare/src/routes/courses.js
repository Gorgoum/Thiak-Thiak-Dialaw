// Routes publiques côté client : pas de compte, le client est identifié par le code de suivi de sa course.
import { HttpErreur, json, lireCorps, texte, adresseIp, codeAleatoire } from '../outils.js';
import { MAINTENANT } from '../db.js';
import { normaliserTel, limiter } from '../securite.js';
import { devis, pointValide, distanceKm, fraisAchat, parametres, chauffeursProches } from '../tarifs.js';
import { SELECT_COURSE, lireCourse, notifierNouvelleCourse, diffuserMaj } from '../courses-service.js';
import * as nangu from '../nangu.js';
import * as paiements from '../paiements.js';
import { envoyer } from '../push.js';

const MAX_PAR_HEURE = 10;          // demandes par adresse IP
const MAX_EN_ATTENTE_PAR_TEL = 3;  // commandes en attente par numéro

export function enregistrer(r) {
  r.post('/api/courses/devis', async (req, c) => {
    const { depart, arrivee } = await lireCorps(req);
    if (!pointValide(depart) || !pointValide(arrivee)) throw new HttpErreur(400, 'Points invalides');
    const d = await devis(c, depart, arrivee);
    // chauffeurs libres autour du départ (sans course en cours) : temps d'arrivée affiché sur chaque choix
    const libres = (await c.db.query(
      `SELECT lat, lng, vehicule, position_maj FROM utilisateurs u WHERE role = 'livreur' AND actif = 1 AND disponible = 1
       AND NOT EXISTS (SELECT 1 FROM courses co WHERE co.livreur_id = u.id AND co.statut IN ('acceptee', 'recuperee'))`
    )).rows;
    return json({ ...d, chauffeurs: chauffeursProches(depart, libres, await parametres(c.db)) });
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
    // service : livraison d'un colis, ou trajet d'une personne (moto ou voiture)
    const service = b.service === 'trajet' ? 'trajet' : 'livraison';
    const vehicule = service === 'trajet' && b.vehicule === 'voiture' ? 'voiture' : 'moto';
    const note = texte(b.description, 200);
    const description = service === 'trajet' ? `Trajet en ${vehicule}${note ? ' · ' + note : ''}` : texte(b.description, 500);
    if (!departRepere || !arriveeRepere) throw new HttpErreur(400, 'Indiquez un repère pour le départ et l\'arrivée');
    if (!description) throw new HttpErreur(400, 'Décrivez ce qu\'il faut livrer');

    const type = service === 'livraison' && b.type === 'achat' ? 'achat' : 'colis';
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
    const fAchat = type === 'achat' ? fraisAchat(montantAchat, await parametres(c.db)) : 0;
    const code = codeAleatoire(16);
    const ins = await c.db.query(
      `INSERT INTO courses (client_nom, client_tel, suivi_token, type, description, montant_achat,
         depart_lat, depart_lng, depart_repere, arrivee_lat, arrivee_lng, arrivee_repere,
         destinataire_nom, destinataire_tel, distance_km, prix, paiement, paiement_statut, statut, service, vehicule, frais_service, frais_achat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
      [clientNom, clientTel, code, type, description, montantAchat,
        Number(b.depart.lat), Number(b.depart.lng), departRepere, Number(b.arrivee.lat), Number(b.arrivee.lng), arriveeRepere,
        texte(b.destinataire_nom, 100) || null, destTel, d.distance_km, (service === 'trajet' && vehicule === 'voiture' ? d.prix_voiture : d.prix) + fAchat,
        // paiement en ligne : rien à payer tant qu'aucun livreur n'a accepté (le paiement est créé à l'acceptation)
        paiement, enLigne ? 'en_attente' : 'a_la_livraison', 'en_attente', service, vehicule, d.frais_service || 0, fAchat]
    );
    const id = ins.rows[0].id;
    const course = await lireCourse(c, id);
    c.attendre(notifierNouvelleCourse(c, course).catch((e) => console.error('Notification :', e.message)));
    return json({ ...course, suivi_token: code }, 201);
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

  // Annulation par le client : possible tant qu'il n'a rien payé (y compris quand un livreur attend son paiement).
  // Une course déjà payée ne s'annule plus ici : c'est l'admin qui rembourse.
  r.post('/api/courses/suivi/:code/annuler', async (req, c) => {
    const avant = (await c.db.query('SELECT id, statut, paiement, paiement_statut, livreur_id FROM courses WHERE suivi_token = $1', [c.params.code])).rows[0];
    if (!avant) throw new HttpErreur(404, 'Course introuvable');
    if (avant.paiement_statut === 'paye' && !['livree', 'annulee'].includes(avant.statut)) {
      throw new HttpErreur(409, 'Cette commande est déjà payée : pour l\'annuler et être remboursé, appelez Yobalema Yène.');
    }
    const res = await c.db.query(
      `UPDATE courses SET statut = 'annulee', annulee_le = ${MAINTENANT},
         paiement_statut = CASE WHEN paiement_statut = 'en_attente' THEN 'annule' ELSE paiement_statut END
       WHERE suivi_token = $1 AND paiement_statut <> 'paye'
         AND (statut IN ('en_attente', 'attente_paiement') OR (statut = 'acceptee' AND paiement <> 'especes'))
       RETURNING id, nangu_id, paiement_statut`,
      [c.params.code]
    );
    if (!res.rows.length) throw new HttpErreur(409, 'Cette course ne peut plus être annulée (déjà prise par un livreur)');
    const { id, nangu_id: nanguId, paiement_statut: etat } = res.rows[0];
    if (nanguId && etat === 'annule') c.attendre(nangu.annulerPaiement(c.env, nanguId).catch((e) => console.error('Annulation Nangu :', e.message)));
    const course = await diffuserMaj(c, id, { notifierClient: false });
    // le livreur qui attendait le paiement est libéré et prévenu
    if (avant.statut === 'acceptee' && avant.livreur_id) {
      c.io.to('user:' + avant.livreur_id).emit('course:maj', course);
      c.attendre(envoyer(c, [avant.livreur_id], { titre: 'Course annulée', corps: 'Le client a annulé avant de payer. Vous êtes libre pour une autre course.', url: '/livreur.html' }).catch(() => {}));
    }
    return json(course);
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
