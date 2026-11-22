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

/**
 * Contrôle « sur place » : le chauffeur / livreur doit être près du point où l'attend le client
 * (départ A pour « Je suis arrivé » et la prise en charge, arrivée B pour la fin de course).
 * Renvoie null si c'est bon, sinon le message à afficher. rayon = 0 : pas de contrôle.
 */
export function messageSurPlace({ position, cible, repere, rayon, precision, versArrivee }) {
  if (!rayon) return null;
  if (!position) return 'Activez la localisation de votre téléphone : elle sert à vérifier que vous êtes bien sur place.';
  const marge = Math.min(Math.max(Number(precision) || 0, 0), 100); // GPS imprécis : jusqu'à 100 m de tolérance en plus
  const d = distanceKm(position, cible) * 1000;
  if (d <= rayon + marge) return null;
  const loin = d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
  const ou = versArrivee ? 'du point d\'arrivée' : 'du point de départ';
  return `Vous êtes à ${loin} ${ou}${repere ? ` (« ${repere} »)` : ''}. Rapprochez-vous à moins de ${rayon} m, puis réessayez.`;
}


/** Frais d'achat (« Acheter pour moi ») : un % des achats, avec un minimum. 0 si le % est à 0. */
export function fraisAchat(montantAchat, p) {
  const pct = Number(p.frais_achat_pct) || 0;
  if (!pct) return 0;
  return Math.max(Number(p.frais_achat_min) || 0, Math.round(((Number(montantAchat) || 0) * pct) / 100));
}

/**
 * Partage de l'argent d'une course terminée.
 *  - prix payé par le client = prix de la course + frais de service + frais d'achat
 *  - part du chauffeur = prix de la course − commission (les frais Wave ne la touchent pas)
 *  - gain de la plateforme = commission + frais de service + frais d'achat − frais Wave / Orange Money
 */
export function partage(course, p) {
  const prix = Number(course.prix) || 0;
  const fraisPlateforme = (Number(course.frais_service) || 0) + (Number(course.frais_achat) || 0);
  const base = Math.max(0, prix - fraisPlateforme);
  const commission = Math.round((base * (Number(p.commission_pct) || 0)) / 100);
  const enLigne = course.paiement !== 'especes' && course.paiement_statut === 'paye';
  const pct = course.paiement === 'orange_money' ? p.frais_om_pct : p.frais_wave_pct;
  const fraisPaiement = enLigne ? Math.round((prix * (pct ?? 1)) / 100) : 0;
  return {
    prix, base, commission, en_ligne: enLigne,
    frais_plateforme: fraisPlateforme,
    frais_paiement: fraisPaiement,
    part_livreur: base - commission,
    gain_plateforme: commission + fraisPlateforme - fraisPaiement,
  };
}


/**
 * Un chauffeur ne peut accepter qu'une course dont le départ est dans son rayon (réglage « rayon_km »),
 * sinon le client attendrait des heures. Sa position doit être connue et récente (moins de 20 min).
 * Renvoie null si c'est bon, sinon le message à afficher au chauffeur.
 */
export function refusTropLoin(chauffeur, depart, p) {
  const rayon = Number(p.rayon_km) || 10;
  const recente = chauffeur.lat != null && (!chauffeur.position_maj || Date.now() - new Date(chauffeur.position_maj).getTime() < 20 * 60000);
  if (!recente) return 'Votre position est inconnue. Passez « Disponible » et autorisez la localisation pour accepter une course.';
  const km = distanceKm({ lat: Number(chauffeur.lat), lng: Number(chauffeur.lng) }, depart) * (p.facteur_route || 1.3);
  if (km <= rayon) return null;
  return `Ce client est à environ ${Math.round(km)} km de vous (maximum ${rayon} km). La course est réservée aux chauffeurs plus proches.`;
}

/**
 * Chauffeurs libres autour du départ, par véhicule : combien, et dans combien de minutes arrive le plus proche.
 * livreurs : [{ lat, lng, vehicule, position_maj }] (disponibles, sans course en cours).
 */
export function chauffeursProches(depart, livreurs, p) {
  const res = {};
  for (const v of GAMMES) {
    const km = livreurs
      .filter((l) => peutFaire(l.vehicule, v) && l.lat != null)
      .filter((l) => !l.position_maj || Date.now() - new Date(l.position_maj).getTime() < 20 * 60000) // position récente
      .map((l) => distanceKm(depart, { lat: Number(l.lat), lng: Number(l.lng) }) * (p.facteur_route || 1.3))
      .filter((d) => d <= (p.rayon_km || 10));
    res[v] = km.length
      ? { nb: km.length, minutes: Math.max(1, Math.round((Math.min(...km) / (v === 'moto' ? 25 : 22)) * 60)) }
      : { nb: 0, minutes: null };
  }
  // un colis peut partir avec n'importe quel chauffeur : moto, Éco ou Confort
  const m = [res.moto.minutes, res.voiture.minutes, res.confort.minutes].filter((x) => x != null);
  // les chauffeurs Confort sont déjà comptés dans « voiture » (ils prennent aussi les trajets Éco)
  res.colis = { nb: res.moto.nb + res.voiture.nb, minutes: m.length ? Math.min(...m) : null };
  return res;
}


/**
 * Gammes de trajet : moto (Jakarta), voiture (« Éco » : taxi, clando), confort (voiture climatisée).
 * Un chauffeur Confort peut aussi prendre les trajets Éco ; une moto ne fait que les trajets à moto.
 */
export const GAMMES = ['moto', 'voiture', 'confort'];
export function gammesDuChauffeur(vehicule) {
  if (vehicule === 'confort') return ['confort', 'voiture'];
  return [vehicule === 'voiture' ? 'voiture' : 'moto'];
}
export const peutFaire = (vehiculeChauffeur, gammeDemandee) => gammesDuChauffeur(vehiculeChauffeur || 'moto').includes(gammeDemandee || 'moto');

export const CENTRE_YENE = { lat: 14.632, lng: -17.165 };

function horsZone(point, p, nom) {
  const zone = p.zone_km || 15;
  const d = distanceKm(CENTRE_YENE, point);
  if (d <= zone) return null;
  return `${nom} est hors zone (${Math.round(d)} km de Yène). Les courses partent de Yène et jusqu'à ${zone} km autour.`;
}

const cacheRoutes = new Map(); // propre à chaque instance du Worker, suffisant pour éviter les appels répétés

async function itineraireRoute(env, depart, arrivee) {
  const cle = [depart.lat, depart.lng, arrivee.lat, arrivee.lng].map((x) => Number(x).toFixed(5)).join(',');
  if (cacheRoutes.has(cle)) return cacheRoutes.get(cle);
  const base = env.OSRM_URL || 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
  const r = await fetch(`${base}${depart.lng},${depart.lat};${arrivee.lng},${arrivee.lat}?overview=full&geometries=geojson`, {
    signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'YobalemaYene/0.1' },
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
  // seul le départ doit être dans la zone (là où sont les chauffeurs) : l'arrivée peut être à Dakar, Thiès…
  const erreur = horsZone(depart, p, 'Le départ');
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
  // trajet en voiture : prix moto × coefficient (réglable par l'admin), arrondi à la centaine
  const prixVoiture = Math.ceil((prix * (p.coef_voiture || 2)) / 100) * 100;
  const prixConfort = Math.ceil((prix * (p.coef_confort || 2.5)) / 100) * 100; // voiture climatisée
  // frais de service : un montant fixe par commande, gardé par la plateforme (inclus dans le prix affiché)
  const fsrv = Math.max(0, Math.round(Number(p.frais_service) || 0));
  return { distance_km: Math.round(km * 100) / 100, prix: prix + fsrv, prix_moto: prix + fsrv, prix_voiture: prixVoiture + fsrv, prix_confort: prixConfort + fsrv, frais_service: fsrv, minutes, trace, source };
}

export function pointValide(pt) {
  return pt && Number.isFinite(Number(pt.lat)) && Number.isFinite(Number(pt.lng))
    && Math.abs(pt.lat) <= 90 && Math.abs(pt.lng) <= 180;
}
