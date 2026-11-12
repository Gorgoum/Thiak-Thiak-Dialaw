/* global L */
// Guidage étape par étape dans l'application livreur (gratuit, sans clé) :
// itinéraire OSRM sur les routes OpenStreetMap (serveur public de la FOSSGIS), instructions en français,
// voix du téléphone (speechSynthesis), recalcul si le livreur sort du trajet, écran maintenu allumé.

const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
const SEUIL_ETAPE_M = 25;       // manœuvre considérée comme passée
const SEUIL_ARRIVEE_M = 30;     // destination atteinte
const SEUIL_HORS_ROUTE_M = 60;  // au-delà, on recalcule le trajet
const ANNONCES_M = [200, 40];   // annonces vocales avant chaque manœuvre

const DIRECTIONS = {
  left: ['à gauche', 'corner-up-left'],
  right: ['à droite', 'corner-up-right'],
  'slight left': ['légèrement à gauche', 'arrow-up-left'],
  'slight right': ['légèrement à droite', 'arrow-up-right'],
  'sharp left': ['franchement à gauche', 'corner-up-left'],
  'sharp right': ['franchement à droite', 'corner-up-right'],
  straight: ['tout droit', 'arrow-up'],
  uturn: ['demi-tour', 'undo-2'],
};

const fmtDistance = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`);
const fmtDistanceVoix = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} mètres` : `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kilomètres`);
const ordinal = (n) => (n === 1 ? '1re' : `${n}e`);

/** Traduit une manœuvre OSRM en { texte, icone } français. */
function instruction(etape, nomCible) {
  const { type, modifier, exit } = etape.maneuver;
  const [dir, iconeDir] = DIRECTIONS[modifier] || ['', 'arrow-up'];
  const sur = etape.name ? ` sur ${etape.name}` : '';
  switch (type) {
    case 'depart': return { texte: `Partez${sur}`, icone: 'navigation' };
    case 'arrive': return { texte: `Vous êtes arrivé : ${nomCible}`, icone: 'flag' };
    case 'roundabout': case 'rotary': case 'roundabout turn': case 'exit roundabout': case 'exit rotary':
      return { texte: exit ? `Au rond-point, prenez la ${ordinal(exit)} sortie${sur}` : `Au rond-point, continuez${sur}`, icone: 'rotate-cw' };
    case 'new name': case 'continue': case 'notification':
      return modifier === 'uturn' ? { texte: 'Faites demi-tour', icone: 'undo-2' }
        : { texte: `Continuez ${dir || 'tout droit'}${sur}`, icone: iconeDir };
    case 'fork': return { texte: `À l'embranchement, restez ${dir}${sur}`, icone: iconeDir };
    case 'end of road': return { texte: `Au bout de la route, tournez ${dir}${sur}`, icone: iconeDir };
    default:
      if (modifier === 'uturn') return { texte: 'Faites demi-tour', icone: 'undo-2' };
      if (modifier === 'straight') return { texte: `Continuez tout droit${sur}`, icone: 'arrow-up' };
      return { texte: `Tournez ${dir}${sur}`, icone: iconeDir };
  }
}

/** Distance (m) d'un point à un segment [a, b], en approximation plane (suffisante à l'échelle d'une ville). */
function distanceSegmentM(p, a, b) {
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 110540;
  const ax = (a[1] - p.lng) * kx; const ay = (a[0] - p.lat) * ky;
  const bx = (b[1] - p.lng) * kx; const by = (b[0] - p.lat) * ky;
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

async function calculerItineraire(o, d) {
  const url = `${OSRM}${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson&steps=true`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Le calcul d\'itinéraire est indisponible pour le moment');
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes.length) throw new Error('Aucun itinéraire trouvé par la route');
  const route = j.routes[0];
  return {
    coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance: route.distance,
    duree: route.duration,
    etapes: route.legs[0].steps.map((s) => ({ ...s, loc: [s.maneuver.location[1], s.maneuver.location[0]] })),
  };
}

const Guidage = {
  actif: false,
  carte: null,
  cible: null,        // { lat, lng, nom }
  route: null,
  idx: 1,             // index de la prochaine manœuvre
  annonces: new Set(),
  horsRoute: 0,
  dernierCalcul: 0,
  suivre: true,
  voix: true,
  traces: null,
  verrouEcran: null,
  surFin: null,

  async demarrer(carte, cible, position, { surFin } = {}) {
    this.arreter(false);
    this.carte = carte;
    this.cible = cible;
    this.surFin = surFin;
    this.actif = true;
    this.suivre = true;
    this.voix = Stock.get('tt_voix') !== 'non';
    document.body.classList.add('guidage');
    $nav('nav-bandeau').hidden = false;
    $nav('nav-bas').hidden = false;
    this.afficher(ico('loader-circle', 'tourne'), 'Calcul de l\'itinéraire…', '');
    this.majBoutonVoix();
    carte.on('dragstart', this._lacher = () => { this.suivre = false; $nav('nav-recentrer').hidden = false; });
    try { this.verrouEcran = await navigator.wakeLock.request('screen'); } catch { /* non supporté */ }
    await this.calculer(position);
  },

  async calculer(position) {
    this.dernierCalcul = Date.now();
    try {
      this.route = await calculerItineraire(position, this.cible);
    } catch (e) {
      this.afficher(ico('triangle-alert'), e.message, 'Utilisez « Ouvrir dans une appli GPS »');
      return;
    }
    if (!this.actif) return;
    this.idx = 1;
    this.annonces.clear();
    this.horsRoute = 0;
    if (this.traces) this.traces.forEach((t) => t.remove());
    this.traces = [
      L.polyline(this.route.coords, { color: '#ffffff', weight: 10, opacity: 0.9, interactive: false }).addTo(this.carte),
      L.polyline(this.route.coords, { color: '#2e90fa', weight: 6, opacity: 1, interactive: false }).addTo(this.carte),
    ];
    this.majPosition(position, true);
  },

  /** Appelé à chaque nouvelle position GPS du livreur. */
  majPosition(pos, premiere = false) {
    if (!this.actif || !this.route || !pos) return;
    const etapes = this.route.etapes;
    const dCible = distanceM(pos, this.cible);
    if (dCible < SEUIL_ARRIVEE_M) return this.arrive();

    // Manœuvres passées
    while (this.idx < etapes.length - 1 && distanceM(pos, { lat: etapes[this.idx].loc[0], lng: etapes[this.idx].loc[1] }) < SEUIL_ETAPE_M) {
      this.idx++;
    }
    // Hors du trajet ? (deux mesures de suite pour éviter les sauts du GPS)
    let min = Infinity;
    const c = this.route.coords;
    for (let i = 0; i < c.length - 1; i++) min = Math.min(min, distanceSegmentM(pos, c[i], c[i + 1]));
    this.horsRoute = min > SEUIL_HORS_ROUTE_M ? this.horsRoute + 1 : 0;
    if (this.horsRoute >= 2 && Date.now() - this.dernierCalcul > 10000) {
      this.parler('Nouvel itinéraire');
      this.afficher(ico('loader-circle', 'tourne'), 'Vous avez quitté le trajet, recalcul…', '');
      this.calculer(pos);
      return;
    }

    const prochaine = etapes[this.idx];
    const dEtape = distanceM(pos, { lat: prochaine.loc[0], lng: prochaine.loc[1] });
    const { texte, icone } = instruction(prochaine, this.cible.nom);
    this.afficher(ico(icone), texte, fmtDistance(dEtape));

    // Annonces vocales (une fois par seuil et par manœuvre)
    for (const seuil of ANNONCES_M) {
      const cle = `${this.idx}-${seuil}`;
      if (dEtape <= seuil && !this.annonces.has(cle)) {
        this.annonces.add(cle);
        this.parler(seuil > 50 ? `Dans ${fmtDistanceVoix(dEtape)}, ${texte.charAt(0).toLowerCase()}${texte.slice(1)}` : texte);
        break;
      }
    }
    if (premiere) this.parler(`${texte}. Arrivée dans ${fmtDistanceVoix(this.reste(pos, dEtape))}`);

    // Reste du trajet
    const reste = this.reste(pos, dEtape);
    const vitesse = this.route.distance / Math.max(this.route.duree, 1); // m/s
    const minutes = Math.max(1, Math.round(reste / vitesse / 60));
    const heure = new Date(Date.now() + minutes * 60000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    $nav('nav-reste').textContent = `${minutes} min · ${fmtDistance(reste)}`;
    $nav('nav-eta').textContent = `Arrivée vers ${heure}`;

    if (this.suivre) this.carte.setView([pos.lat, pos.lng], Math.max(this.carte.getZoom(), 17), { animate: true });
  },

  reste(pos, dEtape) {
    let r = dEtape;
    for (let k = this.idx; k < this.route.etapes.length; k++) r += this.route.etapes[k].distance;
    return r;
  },

  arrive() {
    const nom = this.cible.nom;
    this.afficher(ico('flag'), `Vous êtes arrivé : ${nom}`, '');
    this.parler(`Vous êtes arrivé. ${nom}`);
    const surFin = this.surFin;
    setTimeout(() => { this.arreter(); if (surFin) surFin(); }, 2500);
  },

  arreter(nettoyer = true) {
    if (this.traces) this.traces.forEach((t) => t.remove());
    this.traces = null;
    if (this.carte && this._lacher) this.carte.off('dragstart', this._lacher);
    if (this.verrouEcran) { this.verrouEcran.release().catch(() => {}); this.verrouEcran = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.actif = false;
    this.route = null;
    if (nettoyer) {
      document.body.classList.remove('guidage');
      $nav('nav-bandeau').hidden = true;
      $nav('nav-bas').hidden = true;
      $nav('nav-recentrer').hidden = true;
    }
  },

  recentrer() {
    this.suivre = true;
    $nav('nav-recentrer').hidden = true;
    if (maPosition) this.carte.setView([maPosition.lat, maPosition.lng], 17);
  },

  basculerVoix() {
    this.voix = !this.voix;
    Stock.set('tt_voix', this.voix ? 'oui' : 'non');
    if (!this.voix && 'speechSynthesis' in window) speechSynthesis.cancel();
    this.majBoutonVoix();
  },

  majBoutonVoix() {
    $nav('nav-voix').innerHTML = ico(this.voix ? 'volume-2' : 'volume-x');
    $nav('nav-voix').title = this.voix ? 'Couper la voix' : 'Activer la voix';
  },

  afficher(icone, texte, distance) {
    $nav('nav-icone').innerHTML = icone;
    $nav('nav-instr').textContent = texte;
    $nav('nav-dist').textContent = distance;
  },

  parler(texte) {
    if (!this.voix || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(texte);
    u.lang = 'fr-FR';
    u.rate = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  },
};

function $nav(id) { return document.getElementById(id); }
