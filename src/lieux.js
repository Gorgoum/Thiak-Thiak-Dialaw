const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const { distanceKm } = require('./tarifs');

const CATEGORIES = ['village', 'quartier', 'rue', 'culte', 'ecole', 'sante', 'marche', 'commerce', 'autre'];

const simplifier = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Charge un fichier de lieux (data/*.json) dans la table, sans doublon. */
async function importerFichier(pool, fichier, source, existants) {
  if (!fs.existsSync(fichier)) return 0;
  const lieux = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  let n = 0;
  for (const l of lieux) {
    const deja = await pool.query('SELECT id FROM lieux WHERE osm_id = $1', [l.osm_id]);
    if (deja.rows.length) continue;
    // même nom à moins de 300 m d'un lieu déjà connu : doublon entre sources
    const cle = simplifier(l.nom);
    if (existants.some((e) => e.cle === cle && distanceKm(e, l) < 0.3)) continue;
    await pool.query(
      'INSERT INTO lieux (nom, categorie, lat, lng, source, osm_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [l.nom, CATEGORIES.includes(l.categorie) ? l.categorie : 'autre', l.lat, l.lng, source, l.osm_id]
    );
    existants.push({ cle, lat: l.lat, lng: l.lng });
    n++;
  }
  return n;
}

/** Charge OpenStreetMap puis Overture Maps (les doublons d'Overture sont ignorés). */
async function importerLieuxOsm(pool) {
  const r = await pool.query('SELECT nom, lat, lng FROM lieux');
  const existants = r.rows.map((l) => ({ cle: simplifier(l.nom), lat: l.lat, lng: l.lng }));
  const dossier = path.join(__dirname, '..', 'data');
  const osm = await importerFichier(pool, path.join(dossier, 'lieux-osm.json'), 'osm', existants);
  const overture = await importerFichier(pool, path.join(dossier, 'lieux-overture.json'), 'overture', existants);
  return osm + overture;
}

// Repères trop vagues pour devenir un lieu cherchable
const VAGUES = /^(chez moi|maison|ma maison|domicile|ici|la|là|devant|derriere|derrière|a cote|à côté|\W*)$/i;
// Repères écrits automatiquement par l'application (« Ma position · près de … », « Point placé sur la carte »)
const AUTOMATIQUES = /^(ma position|point placé|près de |à )/i;

/**
 * Après une livraison réussie : propose le repère du départ et de l'arrivée comme nouveaux lieux.
 * Ils restent invisibles tant que l'admin ne les a pas validés. Un repère déjà proposé au même endroit
 * voit simplement son compteur augmenter (plus il revient, plus il est fiable).
 */
async function apprendreDeLaCourse(course) {
  const points = [
    { nom: course.depart_repere, lat: course.depart_lat, lng: course.depart_lng },
    { nom: course.arrivee_repere, lat: course.arrivee_lat, lng: course.arrivee_lng },
  ];
  for (const p of points) {
    const nom = String(p.nom || '').trim().slice(0, 120);
    if (nom.length < 4 || VAGUES.test(nom) || AUTOMATIQUES.test(nom)) continue;
    const cle = simplifier(nom);
    const proches = (await query(
      'SELECT id, nom, lat, lng FROM lieux WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4',
      [p.lat - 0.002, p.lat + 0.002, p.lng - 0.002, p.lng + 0.002]
    )).rows;
    const meme = proches.find((l) => simplifier(l.nom) === cle && distanceKm(l, p) < 0.1);
    if (meme) {
      await query('UPDATE lieux SET vu_fois = vu_fois + 1 WHERE id = $1', [meme.id]);
    } else {
      await query(
        `INSERT INTO lieux (nom, categorie, lat, lng, source, valide) VALUES ($1, 'autre', $2, $3, 'livraison', false)`,
        [nom, p.lat, p.lng]
      );
    }
  }
}

module.exports = { CATEGORIES, importerLieuxOsm, apprendreDeLaCourse };
