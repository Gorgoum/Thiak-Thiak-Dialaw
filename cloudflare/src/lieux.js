// Lieux appris des livraisons réussies (proposés à l'admin, invisibles avant validation).
import { distanceKm } from './tarifs.js';

export const CATEGORIES = ['village', 'quartier', 'rue', 'culte', 'ecole', 'sante', 'marche', 'commerce', 'autre'];
const simplifier = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const VAGUES = /^(chez moi|maison|ma maison|domicile|ici|la|là|devant|derriere|derrière|a cote|à côté|\W*)$/i;
const AUTOMATIQUES = /^(ma position|point placé|près de |à )/i;

export async function apprendreDeLaCourse(c, course) {
  const points = [
    { nom: course.depart_repere, lat: course.depart_lat, lng: course.depart_lng },
    { nom: course.arrivee_repere, lat: course.arrivee_lat, lng: course.arrivee_lng },
  ];
  for (const p of points) {
    const nom = String(p.nom || '').trim().slice(0, 120);
    if (nom.length < 4 || VAGUES.test(nom) || AUTOMATIQUES.test(nom)) continue;
    const cle = simplifier(nom);
    const proches = (await c.db.query(
      'SELECT id, nom, lat, lng FROM lieux WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4',
      [p.lat - 0.002, p.lat + 0.002, p.lng - 0.002, p.lng + 0.002]
    )).rows;
    const meme = proches.find((l) => simplifier(l.nom) === cle && distanceKm(l, p) < 0.1);
    if (meme) await c.db.query('UPDATE lieux SET vu_fois = vu_fois + 1 WHERE id = $1', [meme.id]);
    else await c.db.query(`INSERT INTO lieux (nom, categorie, lat, lng, source, valide) VALUES ($1, 'autre', $2, $3, 'livraison', 0)`, [nom, p.lat, p.lng]);
  }
}
