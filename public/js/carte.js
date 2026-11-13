/* global L */
// Carte partagée (client + admin) : fond OpenStreetMap, noms des villages, lieux, recherche, plein écran.

const CENTRE_YENE = [14.632, -17.165]; // Yène, Tode, Nditakh, Nianghal, Toubab Dialaw
const ZOOM_DEPART = 14;
const ZOOM_LIEU = 17;
const ZOOM_LIEUX_VISIBLES = 15; // en dessous, on n'affiche que les noms de villages

// Icône Lucide par catégorie de lieu
const ICONES = {
  village: 'house', quartier: 'signpost', rue: 'milestone', culte: 'moon-star', ecole: 'school',
  sante: 'heart-pulse', marche: 'store', commerce: 'shopping-bag', autre: 'map-pin',
};
const NOMS_CATEGORIES = {
  village: 'Village', quartier: 'Quartier', rue: 'Rue', culte: 'Mosquée / lieu de culte', ecole: 'École',
  sante: 'Santé', marche: 'Marché', commerce: 'Commerce', autre: 'Autre',
};

/** Texte sans accents ni majuscules, pour une recherche tolérante (« yene guedj » trouve « Yène Guedji »). */
const simplifier = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let lieuxCache = null;
async function chargerLieux(forcer = false) {
  if (lieuxCache && !forcer) return lieuxCache;
  const liste = await api('GET', '/api/lieux');
  const villages = liste.filter((l) => l.categorie === 'village');
  // pour chaque lieu, le village le plus proche (affiché dans les suggestions : « École … · Nditakh »)
  lieuxCache = liste.map((l) => {
    let proche = null;
    if (l.categorie !== 'village') {
      let min = Infinity;
      for (const v of villages) {
        if (v.id === l.id) continue;
        const d = distanceM(l, v);
        if (d < min) { min = d; proche = v.nom; }
      }
    }
    return { ...l, village: proche, cle: simplifier(l.nom + ' ' + (proche || '')) };
  });
  return lieuxCache;
}

// Deux fonds, comme Google Maps :
//  - Plan (par défaut) : carte vectorielle OpenFreeMap, style « Liberty » (libre, gratuite, sans clé),
//    dessinée par MapLibre ; repli sur les tuiles OpenStreetMap si le téléphone ne gère pas WebGL.
//  - Satellite : imagerie Esri, gratuite mais non libre ; nette jusqu'au zoom 17 à Yène, agrandie au-delà.
const STYLE_PLAN = 'https://tiles.openfreemap.org/styles/liberty';
const ATTRIBUTION_PLAN = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const CLE_FOND = 'tt_fond';

function webglDisponible() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

function creerFondPlan() {
  if (L.maplibreGL && webglDisponible()) {
    return L.maplibreGL({ style: STYLE_PLAN, attribution: ATTRIBUTION_PLAN, maxZoom: 20 });
  }
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: ATTRIBUTION_PLAN });
}

const URL_SATELLITE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const OPTIONS_SATELLITE = {
  maxZoom: 19,
  maxNativeZoom: 17,
  // Mentions obligatoires (conditions d'Esri et licence ODbL d'OpenStreetMap), en version courte
  attribution: '© Esri · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
};

/** Trace la limite de la commune de Yène (pointillés) si le fichier existe. */
async function tracerLimite(couche) {
  try {
    const r = await fetch('/data/yene-limite.json');
    if (!r.ok) return;
    const { traits } = await r.json();
    for (const t of traits) {
      L.polyline(t, { color: '#c0392b', weight: 3, dashArray: '8 6', opacity: 0.8, interactive: false }).addTo(couche);
    }
  } catch { /* pas de limite disponible */ }
}

/** Nom d'un lieu avec son village, sauf si le village figure déjà dans le nom (« École de Yène Kao »). */
function nomAvecVillage(l) {
  if (!l.village || l.categorie === 'village') return l.nom;
  const v = simplifier(l.village).split(' ')[0];
  return simplifier(l.nom).includes(v) ? l.nom : `${l.nom}, ${l.village}`;
}

/** Crée la carte dans #idDiv avec les noms de villages et les lieux. Renvoie { carte, rafraichir }. */
function creerCarte(idDiv) {
  const carte = L.map(idDiv, { zoomControl: true, tap: true, maxZoom: 19 }).setView(CENTRE_YENE, ZOOM_DEPART);
  carte.attributionControl.setPrefix(false); // retire « Leaflet » et son drapeau (non obligatoire)

  const coucheLimite = L.layerGroup().addTo(carte);
  const coucheVillages = L.layerGroup();
  const coucheLieux = L.layerGroup();      // lieux absents du plan (Overture, admin, appris des livraisons)
  const coucheLieuxOsm = L.layerGroup();   // lieux OpenStreetMap : déjà écrits sur le plan, utiles en satellite
  tracerLimite(coucheLimite);

  // ---------- Plan / Satellite ----------
  const fonds = { plan: null, satellite: null };
  let fondActif = Stock.get(CLE_FOND) === 'satellite' ? 'satellite' : 'plan';
  function afficherFond(nom) {
    if (fonds[fondActif] && carte.hasLayer(fonds[fondActif])) carte.removeLayer(fonds[fondActif]);
    if (!fonds[nom]) fonds[nom] = nom === 'plan' ? creerFondPlan() : L.tileLayer(URL_SATELLITE, OPTIONS_SATELLITE);
    fonds[nom].addTo(carte);
    if (fonds[nom].bringToBack) fonds[nom].bringToBack();
    fondActif = nom;
    Stock.set(CLE_FOND, nom);
    const sat = nom === 'satellite';
    carte.getContainer().classList.toggle('mode-satellite', sat);
    // le plan écrit déjà les noms des villages : nos étiquettes ne servent qu'en satellite
    if (sat) coucheVillages.addTo(carte); else coucheVillages.remove();
    if (boutonFond) boutonFond.majVignette();
    majCouches();
  }

  // Bouton façon Google Maps : vignette en bas à gauche qui montre l'autre fond
  const BoutonFond = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const b = L.DomUtil.create('button', 'bouton-fond');
      b.type = 'button';
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', () => afficherFond(fondActif === 'plan' ? 'satellite' : 'plan'));
      this._b = b;
      return b;
    },
    majVignette() {
      const versSat = fondActif === 'plan';
      this._b.className = 'bouton-fond ' + (versSat ? 'vers-satellite' : 'vers-plan');
      this._b.innerHTML = `<span>${versSat ? 'Satellite' : 'Plan'}</span>`;
      this._b.setAttribute('aria-label', versSat ? 'Afficher la vue satellite' : 'Afficher le plan');
    },
  });
  // Lieux visibles en zoomant ; ceux d'OpenStreetMap seulement en satellite (le plan les écrit déjà)
  function majCouches() {
    const proche = carte.getZoom() >= ZOOM_LIEUX_VISIBLES;
    if (proche) coucheLieux.addTo(carte); else coucheLieux.remove();
    if (proche && fondActif === 'satellite') coucheLieuxOsm.addTo(carte); else coucheLieuxOsm.remove();
  }
  const boutonFond = new BoutonFond().addTo(carte);
  afficherFond(fondActif);

  async function rafraichir(forcer = false) {
    const lieux = await chargerLieux(forcer);
    coucheVillages.clearLayers();
    coucheLieux.clearLayers();
    coucheLieuxOsm.clearLayers();
    for (const l of lieux) {
      const osm = l.source === 'osm';
      if (l.categorie === 'village' || l.categorie === 'quartier') {
        // villages OSM : écrits par le plan ; ceux ajoutés par l'admin (ex. Yène Kao) : toujours affichés
        L.marker([l.lat, l.lng], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: 'etiquette-village' + (l.categorie === 'quartier' ? ' quartier' : ''), html: esc(l.nom), iconSize: null }),
        }).addTo(osm ? coucheVillages : coucheLieux);
      } else {
        L.marker([l.lat, l.lng], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'etiquette-lieu' + (l.categorie === 'rue' ? ' rue' : ''),
            html: `${ico(ICONES[l.categorie] || 'map-pin')}${esc(l.nom)}`,
            iconSize: null,
          }),
        }).addTo(osm ? coucheLieuxOsm : coucheLieux);
      }
    }
  }
  carte.on('zoomend', majCouches);
  rafraichir().then(majCouches).catch(() => {});
  return { carte, rafraichir };
}

/**
 * Reconnaît une position collée : « 14.6391, -17.1734 », lien Google Maps reçu sur WhatsApp
 * (…?q=14.63,-17.17 / …@14.63,-17.17,17z / …ll= / destination=), lien OpenStreetMap ou « geo: ».
 * Renvoie { lat, lng } ou null.
 */
function lireCoordonnees(texte) {
  let t = String(texte || '');
  try { t = decodeURIComponent(t); } catch { /* texte avec un % isolé : on le garde tel quel */ }
  t = t.replace(/\s+/g, ' ');
  const motifs = [
    /[?&](?:q|query|ll|destination|daddr)=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /mlat=(-?\d{1,2}\.\d+)&mlon=(-?\d{1,3}\.\d+)/,
    /#map=\d+\/(-?\d{1,2}\.\d+)\/(-?\d{1,3}\.\d+)/,
    /geo:(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /^\s*(-?\d{1,2}\.\d{3,})\s*[,; ]\s*(-?\d{1,3}\.\d{3,})\s*$/,
  ];
  for (const m of motifs) {
    const r = t.match(m);
    if (r) {
      const lat = Number(r[1]);
      const lng = Number(r[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

/**
 * Champ avec suggestions de lieux. onChoix(lieu) est appelé au choix d'une suggestion.
 * Option discret : pas de message « aucun lieu trouvé » (champ où l'on écrit aussi du texte libre).
 */
function brancherRecherche(champ, liste, onChoix, { discret = false } = {}) {
  let resultats = [];
  let actif = -1;
  const fermer = () => { liste.hidden = true; liste.innerHTML = ''; actif = -1; };
  const choisir = (i) => {
    const l = resultats[i];
    if (!l) return;
    champ.value = l.nom;
    fermer();
    champ.blur();
    onChoix(l);
  };
  const rendre = () => {
    if (discret && !resultats.length) return fermer();
    liste.innerHTML = resultats.map((l, i) => `
      <li class="${i === actif ? 'actif' : ''}" data-i="${i}">
        <span class="pic">${ico(ICONES[l.categorie] || 'map-pin')}</span>
        <span><b>${esc(l.nom)}</b><small>${esc(NOMS_CATEGORIES[l.categorie] || '')}${l.village ? ' · ' + esc(l.village) : ''}</small></span>
      </li>`).join('') || '<li class="vide">Aucun lieu trouvé. Touchez la carte pour placer le point.</li>';
    liste.hidden = false;
  };
  champ.addEventListener('input', async () => {
    const pos = lireCoordonnees(champ.value);
    if (pos) {
      resultats = [{ ...pos, nom: 'Position partagée', categorie: 'autre', village: `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`, colle: true }];
      actif = 0;
      return rendre();
    }
    if (/maps\.app\.goo\.gl|goo\.gl\/maps/.test(champ.value)) {
      resultats = [];
      liste.innerHTML = '<li class="vide">Ce lien court ne contient pas la position. Ouvrez-le, puis copiez le lien complet, ou utilisez « Demander la position ».</li>';
      liste.hidden = false;
      return;
    }
    const q = simplifier(champ.value);
    if (q.length < 2) return fermer();
    const lieux = await chargerLieux().catch(() => []);
    const mots = q.split(' ');
    resultats = lieux
      .filter((l) => mots.every((m) => l.cle.includes(m)))
      .sort((a, b) => {
        const da = simplifier(a.nom).startsWith(q) ? 0 : 1;
        const db = simplifier(b.nom).startsWith(q) ? 0 : 1;
        return da - db || (a.categorie === 'village' ? -1 : 0) - (b.categorie === 'village' ? -1 : 0) || a.nom.localeCompare(b.nom, 'fr');
      })
      .slice(0, 8);
    actif = -1;
    rendre();
  });
  champ.addEventListener('keydown', (e) => {
    if (liste.hidden) return;
    if (e.key === 'ArrowDown') { actif = Math.min(actif + 1, resultats.length - 1); rendre(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { actif = Math.max(actif - 1, 0); rendre(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); choisir(actif >= 0 ? actif : 0); }
    else if (e.key === 'Escape') fermer();
  });
  liste.addEventListener('mousedown', (e) => e.preventDefault()); // garde le focus pendant le clic
  liste.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) choisir(Number(li.dataset.i));
  });
  champ.addEventListener('blur', () => setTimeout(fermer, 150));
}

/** Boutons « villages proches » pour aller vite à un village. */
async function brancherRaccourcis(conteneur, carte, max = 8) {
  const lieux = await chargerLieux().catch(() => []);
  const centre = { lat: CENTRE_YENE[0], lng: CENTRE_YENE[1] };
  const villages = lieux
    .filter((l) => l.categorie === 'village')
    .map((l) => ({ ...l, d: distanceM(centre, l) }))
    .filter((l) => l.d < 7000)
    .sort((a, b) => a.d - b.d)
    .slice(0, max);
  conteneur.innerHTML = villages.map((v) => `<button type="button" data-lat="${v.lat}" data-lng="${v.lng}">${esc(v.nom)}</button>`).join('');
  conteneur.onclick = (e) => {
    const b = e.target.closest('button');
    if (b) carte.flyTo([Number(b.dataset.lat), Number(b.dataset.lng)], 16);
  };
}

/** Bouton plein écran : agrandit le bloc carte (recherche comprise) sur tout l'écran. */
function brancherPleinEcran(bouton, bloc, carte) {
  bouton.onclick = () => {
    const plein = bloc.classList.toggle('carte-plein');
    document.body.classList.toggle('sans-defilement', plein);
    bouton.innerHTML = plein ? ico('minimize-2') : ico('maximize-2');
    bouton.title = plein ? 'Réduire la carte' : 'Agrandir la carte';
    setTimeout(() => carte.invalidateSize(), 50);
  };
}
