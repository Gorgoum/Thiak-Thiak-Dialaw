// Prix d'une course (distance par la route avec OSRM), zone de service.
import { HttpErreur } from './outils.js';

export async function parametres(db) {
  const r = await db.query('SELECT cle, valeur FROM parametres');
  const p = {};
  for (const x of r.rows) p[x.cle] = Number(x.valeur);
  return p;
}

export function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const distanceM = (a, b) => distanceKm(a, b) * 1000;

export const CENTRE_YENE = { lat: 14.632, lng: -17.165 };

function horsZone(point, p, nom) {
  const zone = p.zone_km || 15;
  const d = distanceKm(CENTRE_YENE, point);
  if (d <= zone) return null;
  return `${nom} est hors zone (${Math.round(d)} km de Yène). Thiak Thiak Dialaw livre à Yène et jusqu'à ${zone} km autour.`;
}

const cacheRoutes = new Map(); // propre à chaque instance du Worker, suffisant pour éviter les appels répétés

async function itineraireRoute(env, depart, arrivee) {
  const cle = [depart.lat, depart.lng, arrivee.lat, arrivee.lng].map((x) => Number(x).toFixed(5)).join(',');
  if (cacheRoutes.has(cle)) return cacheRoutes.get(cle);
  const base = env.OSRM_URL || 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
  const r = await fetch(`${base}${depart.lng},${depart.lat};${arrivee.lng},${arrivee.lat}?overview=full&geometries=geojson`, {
    signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'ThiakThiakDialaw/0.1' },
  });
  if (!r.ok) throw new Error('OSRM ' + r.status);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes.length) throw new Error('OSRM sans itinéraire');
  const route = j.routes[0];
  const res = {
    km: route.distance / 1000,
    minutes: Math.max(1, Math.round(route.duration / 60)),
    trace: route.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(6), +lng.toFixed(6)]),
  };
  if (cacheRoutes.size > 300) cacheRoutes.delete(cacheRoutes.keys().next().value);
  cacheRoutes.set(cle, res);
  return res;
}

export async function devis(c, depart, arrivee) {
  const p = await parametres(c.db);
  const erreur = horsZone(depart, p, 'Le départ') || horsZone(arrivee, p, 'L\'arrivée');
  if (erreur) throw new HttpErreur(400, erreur);
  let km;
  let minutes = null;
  let trace = null;
  let source = 'route';
  try {
    ({ km, minutes, trace } = await itineraireRoute(c.env, depart, arrivee));
  } catch {
    km = distanceKm(depart, arrivee) * (p.facteur_route || 1);
    source = 'estimation';
  }
  const brut = p.prix_base + km * p.prix_km;
  const prix = Math.max(p.prix_min, Math.ceil(brut / 100) * 100);
  return { distance_km: Math.round(km * 100) / 100, prix, minutes, trace, source };
}

export function pointValide(pt) {
  return pt && Number.isFinite(Number(pt.lat)) && Number.isFinite(Number(pt.lng))
    && Math.abs(pt.lat) <= 90 && Math.abs(pt.lng) <= 180;
}
