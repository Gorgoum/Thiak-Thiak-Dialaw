const { query } = require('./db');

async function parametres() {
  const r = await query('SELECT cle, valeur FROM parametres');
  const p = {};
  for (const x of r.rows) p[x.cle] = Number(x.valeur);
  return p;
}

/** Distance à vol d'oiseau en km (formule de haversine). */
function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Centre de la commune de Yène (Yène, Tode, Nditakh, Nianghal, Toubab Dialaw)
const CENTRE_YENE = { lat: 14.632, lng: -17.165 };

/** Message d'erreur si un point est hors de la zone de service, sinon null. */
function horsZone(point, p, nom) {
  const zone = p.zone_km || 15;
  const d = distanceKm(CENTRE_YENE, point);
  if (d <= zone) return null;
  return `${nom} est hors zone (${Math.round(d)} km de Yène). Thiak Thiak Dialaw livre à Yène et jusqu'à ${zone} km autour.`;
}

// Itinéraire par la route : OSRM sur OpenStreetMap (serveur public gratuit de la FOSSGIS).
// Résultats gardés en mémoire pour ne pas solliciter le service à chaque glisser du point.
const OSRM = process.env.OSRM_URL || 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
const cacheRoutes = new Map();

async function itineraireRoute(depart, arrivee) {
  const cle = [depart.lat, depart.lng, arrivee.lat, arrivee.lng].map((x) => Number(x).toFixed(5)).join(',');
  if (cacheRoutes.has(cle)) return cacheRoutes.get(cle);
  const url = `${OSRM}${depart.lng},${depart.lat};${arrivee.lng},${arrivee.lat}?overview=full&geometries=geojson`;
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'ThiakThiakDialaw/0.1' } });
  if (!r.ok) throw new Error('OSRM ' + r.status);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes.length) throw new Error('OSRM sans itinéraire');
  const route = j.routes[0];
  const res = {
    km: route.distance / 1000,
    minutes: Math.max(1, Math.round(route.duration / 60)),
    trace: route.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(6), +lng.toFixed(6)]),
  };
  if (cacheRoutes.size > 500) cacheRoutes.delete(cacheRoutes.keys().next().value);
  cacheRoutes.set(cle, res);
  return res;
}

/**
 * Prix d'une course : base + km × tarif, arrondi à la centaine supérieure, avec un minimum.
 * La distance est celle de la route (OSRM) ; si le service ne répond pas, estimation à vol d'oiseau × facteur.
 */
async function devis(depart, arrivee) {
  const p = await parametres();
  const erreur = horsZone(depart, p, 'Le départ') || horsZone(arrivee, p, 'L\'arrivée');
  if (erreur) {
    const e = new Error(erreur);
    e.statut = 400;
    throw e;
  }
  let km;
  let minutes = null;
  let trace = null;
  let source = 'route';
  try {
    ({ km, minutes, trace } = await itineraireRoute(depart, arrivee));
  } catch {
    km = distanceKm(depart, arrivee) * (p.facteur_route || 1);
    source = 'estimation';
  }
  const brut = p.prix_base + km * p.prix_km;
  const prix = Math.max(p.prix_min, Math.ceil(brut / 100) * 100);
  return { distance_km: Math.round(km * 100) / 100, prix, minutes, trace, source };
}

function pointValide(pt) {
  return (
    pt && Number.isFinite(Number(pt.lat)) && Number.isFinite(Number(pt.lng)) &&
    Math.abs(pt.lat) <= 90 && Math.abs(pt.lng) <= 180
  );
}

module.exports = { parametres, distanceKm, devis, pointValide, CENTRE_YENE };
