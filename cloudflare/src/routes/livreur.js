// Routes côté livreur.
import { HttpErreur, json, lireCorps } from '../outils.js';
import { MAINTENANT, DEBUT_JOUR } from '../db.js';
import { exiger } from '../securite.js';
import { distanceKm, pointValide, parametres, messageSurPlace, partage, gammesDuChauffeur, peutFaire } from '../tarifs.js';
const messageGamme = (g) => (g === 'confort' ? 'Ce trajet est en Confort (voiture climatisée) : réservé aux chauffeurs Confort.' : g === 'voiture' ? 'Ce trajet est en Éco (voiture) : réservé aux chauffeurs en voiture.' : 'Ce trajet est à moto : réservé aux chauffeurs à moto.');
import { SELECT_COURSE, notifierNouvelleCourse, diffuserMaj, lireCourse } from '../courses-service.js';
import * as paiements from '../paiements.js';
import { apprendreDeLaCourse } from '../lieux.js';
import * as argent from '../argent.js';

/** Livreur connecté ET validé par l'admin. */
async function livreur(req, c) {
  await exiger(req, c, 'livreur');
  const u = (await c.db.query('SELECT id, actif, lat, lng, vehicule FROM utilisateurs WHERE id = $1', [c.user.id])).rows[0];
  if (!u) throw new HttpErreur(401, 'Compte introuvable');
  if (!u.actif) throw new HttpErreur(403, 'Votre compte livreur attend la validation de l\'administrateur');
  return u;
}

/**
 * Le livreur est-il vraiment sur place ? Sa position est envoyée avec le bouton (sinon la dernière connue).
 * Lance une erreur 409 avec un message clair s'il est trop loin.
 */
async function exigerSurPlace(req, c, moi, id, versArrivee) {
  const x = (await c.db.query(
    'SELECT depart_lat, depart_lng, depart_repere, arrivee_lat, arrivee_lng, arrivee_repere FROM courses WHERE id = $1 AND livreur_id = $2',
    [id, c.user.id]
  )).rows[0];
  if (!x) return; // la mise à jour répondra « action impossible »
  const p = await parametres(c.db);
  const b = await lireCorps(req).catch(() => ({}));
  let position = null;
  if (pointValide({ lat: b.lat, lng: b.lng })) {
    position = { lat: Number(b.lat), lng: Number(b.lng) };
    await c.db.query(`UPDATE utilisateurs SET lat = $2, lng = $3, position_maj = ${MAINTENANT} WHERE id = $1`, [c.user.id, position.lat, position.lng]);
  } else if (moi.lat != null) {
    position = { lat: Number(moi.lat), lng: Number(moi.lng) };
  }
  const loin = messageSurPlace({
    position,
    cible: versArrivee ? { lat: x.arrivee_lat, lng: x.arrivee_lng } : { lat: x.depart_lat, lng: x.depart_lng },
    repere: versArrivee ? x.arrivee_repere : x.depart_repere,
    rayon: p.rayon_arrivee_m ?? 200,
    precision: b.precision,
    versArrivee,
  });
  if (loin) throw new HttpErreur(409, loin);
}

// =========================================================================
// Arrivées détectées par le GPS, comme Google Maps (pas de bouton à toucher)
//  - à moins de RAYON du départ A        → « arrivé » (le client est prévenu)
//  - reparti à plus de RAYON + 150 m de A → passager à bord / colis récupéré
//    (après au moins 30 s sur place, et seulement si la course est payée quand elle se paie en ligne)
//  - à moins de RAYON de l'arrivée B     → course terminée
// Une position trop imprécise (> 100 m) n'est jamais utilisée.
// =========================================================================
async function detecterArrivees(c, livreurId, pos, precision) {
  if (precision !== undefined && precision !== null && precision !== '' && Number(precision) > 100) return [];
  const p = await parametres(c.db);
  const rayon = p.rayon_arrivee_m || 200;
  const courses = (await c.db.query(
    `SELECT id, statut, service, arrive_le, paiement, paiement_statut, depart_lat, depart_lng, arrivee_lat, arrivee_lng
     FROM courses WHERE livreur_id = $1 AND statut IN ('acceptee', 'recuperee')`, [livreurId]
  )).rows;
  const faits = [];
  for (const x of courses) {
    const dA = distanceKm(pos, { lat: x.depart_lat, lng: x.depart_lng }) * 1000;
    const dB = distanceKm(pos, { lat: x.arrivee_lat, lng: x.arrivee_lng }) * 1000;
    const trajet = x.service === 'trajet';
    const payee = x.paiement === 'especes' || x.paiement_statut === 'paye';
    if (x.statut === 'acceptee' && !x.arrive_le && dA <= rayon) {
      const r = await c.db.query(`UPDATE courses SET arrive_le = ${MAINTENANT} WHERE id = $1 AND statut = 'acceptee' AND arrive_le IS NULL RETURNING id`, [x.id]);
      if (!r.rows.length) continue;
      await diffuserMaj(c, x.id, {
        titre: trajet ? 'Votre chauffeur est là' : 'Le livreur est arrivé',
        message: trajet ? 'Votre chauffeur est arrivé au point de départ.' : 'Le livreur est arrivé au point de départ pour récupérer le colis.',
        urgent: true,
      });
      faits.push({ id: x.id, etape: 'arrive' });
    } else if (x.statut === 'acceptee' && x.arrive_le && payee && dA > rayon + 150 && Date.now() - new Date(x.arrive_le).getTime() > 30000) {
      const r = await c.db.query(`UPDATE courses SET statut = 'recuperee', recuperee_le = ${MAINTENANT} WHERE id = $1 AND statut = 'acceptee' RETURNING id`, [x.id]);
      if (!r.rows.length) continue;
      await diffuserMaj(c, x.id);
      faits.push({ id: x.id, etape: 'recuperee' });
    } else if (x.statut === 'recuperee' && dB <= rayon) {
      const r = await c.db.query(`UPDATE courses SET statut = 'livree', livree_le = ${MAINTENANT} WHERE id = $1 AND statut = 'recuperee' RETURNING id`, [x.id]);
      if (!r.rows.length) continue;
      const course = await diffuserMaj(c, x.id);
      await argent.inscrireCoursesLivrees(c, x.id); // part du livreur ou commission, au registre
      c.attendre(apprendreDeLaCourse(c, course)
        .then(() => c.io.to('admins').emit('lieux:proposes'))
        .catch((err) => console.error('Apprentissage des lieux :', err.message)));
      faits.push({ id: x.id, etape: 'livree' });
    }
  }
  return faits;
}

export function enregistrer(r) {
  r.post('/api/livreur/disponibilite', async (req, c) => {
    await livreur(req, c);
    const { disponible, lat, lng } = await lireCorps(req);
    await c.db.query('UPDATE utilisateurs SET disponible = $2 WHERE id = $1', [c.user.id, !!disponible]);
    if (pointValide({ lat, lng })) {
      await c.db.query(`UPDATE utilisateurs SET lat = $2, lng = $3, position_maj = ${MAINTENANT} WHERE id = $1`, [c.user.id, Number(lat), Number(lng)]);
    }
    c.io.to('admins').emit('livreurs:changement');
    return json({ disponible: !!disponible });
  });

  r.post('/api/livreur/position', async (req, c) => {
    await livreur(req, c);
    const { lat, lng, precision } = await lireCorps(req);
    if (!pointValide({ lat, lng })) throw new HttpErreur(400, 'Position invalide');
    await c.db.query(`UPDATE utilisateurs SET lat = $2, lng = $3, position_maj = ${MAINTENANT} WHERE id = $1`, [c.user.id, Number(lat), Number(lng)]);
    // le client voit sa moto / sa voiture arriver en direct (seulement pendant la course)
    const enCours = (await c.db.query("SELECT id, suivi_token FROM courses WHERE livreur_id = $1 AND statut IN ('acceptee', 'recuperee')", [c.user.id])).rows;
    if (enCours.length) {
      for (const x of enCours) c.io.to('suivi:' + x.suivi_token).emit('livreur:position', { course_id: x.id, lat: Number(lat), lng: Number(lng) });
    }
    const transitions = enCours.length ? await detecterArrivees(c, c.user.id, { lat: Number(lat), lng: Number(lng) }, precision) : [];
    return json({ ok: true, en_course: enCours.length > 0, transitions });
  });

  // Courses en attente, sans le téléphone du client (révélé seulement après acceptation)
  r.get('/api/livreur/courses-disponibles', async (req, c) => {
    const moi = await livreur(req, c);
    const res = await c.db.query(
      `SELECT id, type, description, montant_achat, depart_lat, depart_lng, depart_repere,
              arrivee_lat, arrivee_lng, arrivee_repere, distance_km, prix, paiement, paiement_statut, cree_le, service, vehicule, frais_service, frais_achat
       FROM courses WHERE statut = 'en_attente' AND (service = 'livraison' OR vehicule IN ($1, $2)) ORDER BY cree_le DESC LIMIT 50`,
      (({ 0: a, 1: b }) => [a, b || a])(gammesDuChauffeur(moi.vehicule)) // chaque gamme à ses chauffeurs
    );
    const p = await parametres(c.db);
    const liste = res.rows.map((x) => ({
      ...x,
      part_livreur: partage(x, p).part_livreur, // ce que gagnera le chauffeur
      distance_moi_km: moi.lat != null
        ? Math.round(distanceKm(moi, { lat: x.depart_lat, lng: x.depart_lng }) * (p.facteur_route || 1) * 10) / 10
        : null,
    }));
    liste.sort((x, y) => (x.distance_moi_km ?? 999) - (y.distance_moi_km ?? 999));
    return json(liste);
  });

  r.get('/api/livreur/mes-courses', async (req, c) => {
    await livreur(req, c);
    return json((await c.db.query(SELECT_COURSE + ' WHERE c.livreur_id = $1 ORDER BY c.cree_le DESC LIMIT 30', [c.user.id])).rows);
  });

  r.get('/api/livreur/gains', async (req, c) => {
    await livreur(req, c);
    const p = await parametres(c.db);
    const g = (await c.db.query(
      `SELECT count(*) AS nb, coalesce(sum(prix - frais_service - frais_achat), 0) AS total
       FROM courses WHERE livreur_id = $1 AND statut = 'livree' AND livree_le >= ${DEBUT_JOUR}`,
      [c.user.id]
    )).rows[0];
    const total = Number(g.total);
    const commission = Math.round((total * (p.commission_pct || 0)) / 100);
    return json({ nb: Number(g.nb), total, commission, net: total - commission, commission_pct: p.commission_pct });
  });

  // Mon argent : solde, journée, historique
  r.get('/api/livreur/argent', async (req, c) => {
    await livreur(req, c);
    return json(await argent.argentLivreur(c, c.user.id));
  });

  r.post('/api/livreur/courses/:id/accepter', async (req, c) => {
    const moi = await livreur(req, c);
    const demande = (await c.db.query('SELECT service, vehicule FROM courses WHERE id = $1', [Number(c.params.id)])).rows[0];
    if (demande && demande.service === 'trajet' && !peutFaire(moi.vehicule, demande.vehicule)) {
      throw new HttpErreur(409, messageGamme(demande.vehicule));
    }
    const b = await argent.bloque(c, c.user.id);
    if (b) {
      throw new HttpErreur(403, `Vous devez ${Math.abs(b.solde).toLocaleString('fr-FR')} FCFA à la plateforme (plafond ${b.plafond.toLocaleString('fr-FR')} FCFA). Reversez-les pour accepter de nouvelles courses.`);
    }
    try {
      const res = await c.db.query(
        `UPDATE courses SET statut = 'acceptee', livreur_id = $2, acceptee_le = ${MAINTENANT}
         WHERE id = $1 AND statut = 'en_attente' RETURNING id`,
        [Number(c.params.id), c.user.id]
      );
      if (!res.rows.length) throw new HttpErreur(409, 'Trop tard, cette course a déjà été prise ou annulée');
    } catch (e) {
      if (e instanceof HttpErreur) throw e;
      if (/UNIQUE/i.test(e.message)) throw new HttpErreur(409, 'Terminez d\'abord votre course en cours');
      throw e;
    }
    const id = Number(c.params.id);
    const x = (await c.db.query('SELECT paiement, paiement_statut FROM courses WHERE id = $1', [id])).rows[0];
    if (x.paiement !== 'especes' && x.paiement_statut !== 'paye') {
      // course à payer en ligne : le client paie maintenant qu'un livreur est trouvé
      try {
        await paiements.demanderPaiement(c, id);
      } catch (e) {
        // Nangu indisponible : on rend la course aux autres livreurs plutôt que de faire attendre celui-ci
        console.error('Demande de paiement :', e.message);
        await c.db.query(`UPDATE courses SET statut = 'en_attente', livreur_id = NULL, acceptee_le = NULL WHERE id = $1 AND statut = 'acceptee'`, [id]);
        await diffuserMaj(c, id, { notifierClient: false });
        throw new HttpErreur(502, 'Le paiement du client ne peut pas être lancé pour le moment. Réessayez dans un instant.');
      }
      return json(await lireCourse(c, id));
    }
    return json(await diffuserMaj(c, id));
  });

  // « Je suis arrivé » au point de départ : le client est prévenu (passager : « votre chauffeur est là »)
  r.post('/api/livreur/courses/:id/arrive', async (req, c) => {
    const moi = await livreur(req, c);
    const id = Number(c.params.id);
    await exigerSurPlace(req, c, moi, id, false);
    const res = await c.db.query(
      `UPDATE courses SET arrive_le = ${MAINTENANT} WHERE id = $1 AND livreur_id = $2 AND statut = 'acceptee' RETURNING id, service`,
      [id, c.user.id]
    );
    if (!res.rows.length) throw new HttpErreur(409, 'Action impossible à ce stade de la course');
    const trajet = res.rows[0].service === 'trajet';
    return json(await diffuserMaj(c, id, {
      titre: trajet ? 'Votre chauffeur est là' : 'Le livreur est arrivé',
      message: trajet ? 'Votre chauffeur est arrivé au point de départ.' : 'Le livreur est arrivé au point de départ pour récupérer le colis.',
      urgent: true,
    }));
  });

  // Transitions autorisées : acceptee → recuperee → livree
  const ETAPES = { recuperee: { depuis: 'acceptee', colonne: 'recuperee_le' }, livree: { depuis: 'recuperee', colonne: 'livree_le' } };
  for (const [statut, e] of Object.entries(ETAPES)) {
    r.post(`/api/livreur/courses/:id/${statut}`, async (req, c) => {
      const moi = await livreur(req, c);
      const id = Number(c.params.id);
      if (statut === 'recuperee') {
        // course à payer en ligne : on ne prend pas le colis avant que le client ait payé
        const x = (await c.db.query('SELECT paiement, paiement_statut FROM courses WHERE id = $1 AND livreur_id = $2', [id, c.user.id])).rows[0];
        if (x && x.paiement !== 'especes' && x.paiement_statut !== 'paye') {
          throw new HttpErreur(409, 'Le client n\'a pas encore payé. Attendez le paiement avant de récupérer le colis.');
        }
      }
      await exigerSurPlace(req, c, moi, id, statut === 'livree');
      const res = await c.db.query(
        `UPDATE courses SET statut = $3, ${e.colonne} = ${MAINTENANT}
         WHERE id = $1 AND livreur_id = $2 AND statut = $4 RETURNING id`,
        [id, c.user.id, statut, e.depuis]
      );
      if (!res.rows.length) throw new HttpErreur(409, 'Action impossible à ce stade de la course');
      const course = await diffuserMaj(c, id);
      if (statut === 'livree') {
        await argent.inscrireCoursesLivrees(c, id); // part du livreur ou commission, au registre
        c.attendre(apprendreDeLaCourse(c, course)
          .then(() => c.io.to('admins').emit('lieux:proposes'))
          .catch((err) => console.error('Apprentissage des lieux :', err.message)));
      }
      return json(course);
    });
  }

  // Désistement avant récupération : la course repart aux autres livreurs
  r.post('/api/livreur/courses/:id/liberer', async (req, c) => {
    await livreur(req, c);
    const id = Number(c.params.id);
    const res = await c.db.query(
      `UPDATE courses SET statut = 'en_attente', livreur_id = NULL, acceptee_le = NULL
       WHERE id = $1 AND livreur_id = $2 AND statut = 'acceptee' RETURNING id`,
      [id, c.user.id]
    );
    if (!res.rows.length) throw new HttpErreur(409, 'Impossible de libérer cette course');
    c.io.to('user:' + c.user.id).emit('course:maj', { id });
    const course = await diffuserMaj(c, id);
    c.attendre(notifierNouvelleCourse(c, course).catch((err) => console.error('Notification :', err.message)));
    return json({ ok: true });
  });
}
