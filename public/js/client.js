/* global L, io */
// Page client : pas de compte. Les codes de suivi des courses sont gardés sur ce téléphone.

const CLE_SUIVIS = 'tt_suivis';
const CLE_COORD = 'tt_coordonnees';
const CLE_ADRESSES = 'tt_adresses';
const NOMS = { depart: 'départ', arrivee: 'arrivée' };
const LETTRE = { depart: 'A', arrivee: 'B' };

const form = document.getElementById('f-course');
const $ = (id) => document.getElementById(id);

let carte;
let socket;
let mode = 'depart';
let dernierDevis = null;
const points = { depart: null, arrivee: null };
const parGPS = { depart: false, arrivee: false }; // point placé avec « Je suis ici » / « Chez moi, ici »
const imprecis = { depart: null, arrivee: null }; // nom du village / quartier choisi tel quel (position trop vague)
let attente = null; // position demandée par WhatsApp : { type, code, minuterie }

// =========================================================================
// Codes de suivi (gardés sur ce téléphone)
// =========================================================================
const lireJSON = (cle, defaut) => { try { return JSON.parse(Stock.get(cle)) || defaut; } catch { return defaut; } };
const lireCodes = () => lireJSON(CLE_SUIVIS, []);
const ecrireCodes = (codes) => Stock.set(CLE_SUIVIS, JSON.stringify(codes.slice(0, 30)));
function ajouterCode(code) {
  ecrireCodes([code, ...lireCodes().filter((c) => c !== code)]);
  if (socket) socket.emit('suivre', code);
}
const lienSuivi = (code) => `${location.origin}/?suivi=${encodeURIComponent(code)}`;

// Lien partagé « /?suivi=CODE » : la course s'ajoute à ce téléphone
const params = new URLSearchParams(location.search);
const suiviPartage = params.get('suivi');
// Retour depuis la page de paiement Nangu : on vérifie le paiement auprès du serveur
const retourPaiement = suiviPartage && params.get('paiement') === 'retour';
// Alerte « Un livreur a accepté, payez maintenant » : on ouvre directement l'écran de paiement
const ouvrirPaiement = suiviPartage && params.get('payer') === '1';
// Destinataire d'un colis : il suit la livraison sans pouvoir annuler ni payer, et a ses propres notifications
const CLE_DEST = 'tt_codes_destinataire';
const codesDest = () => lireJSON(CLE_DEST, []);
if (suiviPartage && params.get('pour') === 'destinataire' && !codesDest().includes(suiviPartage)) {
  Stock.set(CLE_DEST, JSON.stringify([suiviPartage, ...codesDest()].slice(0, 30)));
}
const lienDestinataire = (code) => `${lienSuivi(code)}&pour=destinataire`;
if (suiviPartage) {
  ajouterCode(suiviPartage);
  history.replaceState(null, '', '/');
}

// Notifications du client : rattachées à chacune de ses courses
// eslint-disable-next-line no-global-assign
activerNotifications = async () => {
  const ab = await obtenirAbonnement();
  const dest = codesDest();
  await Promise.all(lireCodes().map((c) => api('POST', `/api/courses/suivi/${encodeURIComponent(c)}/push`, { abonnement: ab, role: dest.includes(c) ? 'destinataire' : 'client' }).catch(() => {})));
};

// =========================================================================
// Itinéraire : départ A et arrivée B
// =========================================================================
function choisirMode(m) {
  mode = m;
  document.querySelectorAll('.ligne-lieu').forEach((e) => e.classList.toggle('actif', e.dataset.type === m));
  majAide();
}

function majAide() {
  const aide = $('aide-carte');
  if (memeEndroit()) {
    aide.innerHTML = `${ico('triangle-alert', 'ic-sm')} Départ et arrivée au même endroit : touchez la carte pour déplacer ${LETTRE[mode]}`;
    return;
  }
  if (points.depart && points.arrivee) {
    aide.innerHTML = `${ico('check', 'ic-sm')} Itinéraire prêt · déplacez les points pour ajuster`;
    return;
  }
  aide.innerHTML = `<span class="puce ${mode === 'depart' ? 'puce-a' : 'puce-b'}">${LETTRE[mode]}</span>
    Touchez la carte pour placer ${mode === 'depart' ? 'le départ' : 'l\'arrivée'}`;
}

function majEtat(type, texte, classe = '') {
  const el = $('etat-' + type);
  if (!el) return; // l'écran unique n'affiche pas d'état sous les champs
  el.className = 'etape-etat ' + classe;
  el.innerHTML = texte;
}

function placer(type, latlng) {
  parGPS[type] = false; // remis à true par le bouton de position, juste après
  imprecis[type] = null; // remis par la recherche si l'on a choisi un village entier
  if (points[type]) {
    points[type].setLatLng(latlng);
  } else {
    points[type] = L.marker(latlng, {
      draggable: true,
      autoPan: true,
      title: type === 'depart' ? 'Départ' : 'Arrivée',
      icon: L.divIcon({
        className: '',
        html: `<div class="pin pin-${type}"><span>${LETTRE[type]}</span></div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 41],
      }),
    }).addTo(carte);
    points[type].on('drag', () => majCoord(type));
    points[type].on('dragend', () => {
      imprecis[type] = null; // point posé à la main : position exacte
      majEtat(type, `${ico('check', 'ic-sm')} Position ajustée`, 'place');
      verifierMemeEndroit(type);
      proposerRepere(type);
      majCoord(type);
      majAide();
      majDevis();
    });
  }
  majEtat(type, `${ico('check', 'ic-sm')} Placé`, 'place');
  majCoord(type);
  verifierMemeEndroit(type, { remplacer: true });
  proposerRepere(type);
  majAide();
  majChoixGPS();
  majDevis(true); // les deux points placés : trajet tracé et zoom sur l'itinéraire
}

const DISTANCE_MIN_M = 30;
const memeEndroit = () => points.depart && points.arrivee
  && distanceM(coord(points.depart), coord(points.arrivee)) < DISTANCE_MIN_M;

/** A et B au même endroit : on écarte visuellement A et on explique (sinon A disparaît sous B). */
/** Coordonnées précises du point, affichées sous le repère (mises à jour en direct). */
function majCoord(type) {
  const el = $('coord-' + type);
  if (!el) return;
  if (!points[type]) { el.hidden = true; return; }
  const { lat, lng } = points[type].getLatLng();
  el.hidden = false;
  el.innerHTML = `${ico('map-pin', 'ic-sm')} ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function retirerPoint(type) {
  if (points[type]) { points[type].remove(); points[type] = null; }
  parGPS[type] = false;
  majCoord(type);
  majEtat(type, 'À placer sur la carte'); // le repère écrit est conservé
  majChoixGPS();
}

/** Appelé à chaque placement : met à jour l'alerte « lieu trop vague ». */
function majChoixGPS() { majPrecision(); }

// =========================================================================
// Position exacte : alerte si le lieu est un village entier, demande par WhatsApp
// =========================================================================
function majPrecision() {
  const zone = $('precision');
  if (!zone) return;
  if (attente) return; // le panneau « en attente de la position » reste affiché
  const type = ['depart', 'arrivee'].find((t) => imprecis[t] && points[t]);
  if (!type) { zone.hidden = true; zone.innerHTML = ''; return; }
  const qui = type === 'depart' ? 'où vous trouver' : (estTrajet() ? 'où vous déposer' : 'où livrer');
  zone.className = 'precision alerte';
  zone.innerHTML = `
    <div class="titre">${ico('triangle-alert', 'ic-sm')} « ${esc(imprecis[type])} » est ${/quartier/i.test(imprecis[type + 'Cat'] || '') ? 'un quartier' : 'un village'} entier</div>
    <p>Le ${estTrajet() ? 'chauffeur' : 'livreur'} ne saura pas ${qui}. Montrez l'endroit exact :</p>
    <div class="actions">
      <button type="button" data-sur-carte="${type}">${ico('pointer', 'ic-sm')} Toucher la carte</button>
      <button type="button" class="whatsapp" data-demander="${type}">${ico('message-circle', 'ic-sm')} Demander par WhatsApp</button>
    </div>`;
  zone.hidden = false;
}

function arreterAttente() {
  if (attente) clearInterval(attente.minuterie);
  attente = null;
  majPrecision();
}

function positionRecue(d) {
  if (!attente || attente.code !== d.code || d.lat == null) return;
  const type = attente.type;
  arreterAttente();
  const champ = form[type + '_repere'];
  if (imprecis[type] || !champ.value.trim()) { champ.value = ''; delete champ.dataset.auto; delete champ.dataset.ancre; }
  placerAvecRepere(type, d.lat, d.lng, null);
  proposerRepere(type, type === 'depart' ? 'Position envoyée' : 'Position du destinataire');
  apresPoint(type);
  toast(`Position ${type === 'depart' ? 'du départ' : 'de l\'arrivée'} reçue${d.precision_m ? ` (±${d.precision_m} m)` : ''}. Le point ${LETTRE[type]} est placé.`);
}

/** Envoie un lien : la personne qui est sur place touche « Envoyer ma position », le point se place tout seul. */
async function demanderPosition(type) {
  const nom = form.client_nom.value.trim();
  let code;
  try {
    ({ code } = await api('POST', '/api/positions', { demandeur: nom || null }));
  } catch (e) { return toast(e.message, true); }
  if (attente) clearInterval(attente.minuterie);
  choisirMode(type);
  const lien = `${location.origin}/position.html?d=${encodeURIComponent(code)}`;
  const qui = estTrajet() ? 'le chauffeur' : 'le livreur';
  const message = `${nom || 'Quelqu\'un'} a besoin de votre position exacte pour une course Yobalema Yène. `
    + `Ouvrez ce lien et touchez « Envoyer ma position » pour que ${qui} trouve l'endroit : ${lien}`;
  const tel = type === 'arrivee' ? form.destinataire_tel.value.replace(/\D/g, '').slice(-9) : '';
  const telOk = /^7\d{8}$/.test(tel);
  const texte = encodeURIComponent(message);

  attente = { type, code, minuterie: null };
  socket.emit('attendre-position', code);
  attente.minuterie = setInterval(async () => {
    try { positionRecue(await api('GET', '/api/positions/' + encodeURIComponent(code))); } catch { /* nouvel essai */ }
  }, 5000);

  const zone = $('precision');
  zone.className = 'precision attente-pos';
  zone.hidden = false;
  zone.innerHTML = `
    <div class="titre">${ico('loader-circle', 'ic-sm tourne')} En attente de la position ${type === 'depart' ? 'du départ (A)' : 'de l\'arrivée (B)'}</div>
    <p>Envoyez ce lien à la personne qui est sur place. Dès qu'elle touche « Envoyer ma position », le point ${LETTRE[type]} se place tout seul.</p>
    <div class="actions">
      <a class="bouton whatsapp" href="https://wa.me/${telOk ? '221' + tel : ''}?text=${texte}" target="_blank" rel="noopener">${ico('message-circle', 'ic-sm')} WhatsApp</a>
      <a class="bouton" href="sms:${telOk ? '+221' + tel : ''}?body=${texte}">${ico('message-square', 'ic-sm')} SMS</a>
      <button type="button" data-copier>${ico('copy', 'ic-sm')} Copier</button>
      <button type="button" class="danger" data-annuler-attente>${ico('x', 'ic-sm')} Annuler</button>
    </div>`;
  zone.querySelector('[data-copier]').onclick = async () => {
    if (navigator.share) { await navigator.share({ text: message }).catch(() => {}); return; }
    try { await navigator.clipboard.writeText(message); toast('Message copié. Collez-le dans WhatsApp ou par SMS.'); }
    catch { prompt('Copiez ce message :', message); }
  };
  zone.querySelector('[data-annuler-attente]').onclick = () => arreterAttente();
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// boutons WhatsApp des lignes A / B et de l'alerte ; « Toucher la carte »
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-demander]');
  if (d) { e.preventDefault(); demanderPosition(d.dataset.demander); return; }
  const s = e.target.closest('[data-sur-carte]');
  if (s) {
    choisirMode(s.dataset.surCarte);
    $('bloc-carte').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`Touchez l'endroit exact sur la carte (ou faites glisser le point ${LETTRE[s.dataset.surCarte]}).`);
  }
});

/**
 * Départ et arrivée au même endroit.
 * - Placement volontaire (Ma position, recherche, carte, lien) : la dernière action gagne,
 *   l'autre point est retiré et on demande de le replacer ailleurs.
 * - Glisser un point sur l'autre : simple alerte, rien n'est retiré.
 */
function verifierMemeEndroit(type, { remplacer = false } = {}) {
  let proches = memeEndroit();
  const autre = type === 'depart' ? 'arrivee' : 'depart';
  if (proches && remplacer) {
    retirerPoint(autre);
    choisirMode(autre);
    toast(type === 'depart'
      ? 'Départ placé ici. L\'arrivée était au même endroit : placez-la là où le colis doit être livré.'
      : 'Arrivée placée ici. Le départ était au même endroit : placez-le là où le livreur récupère le colis.');
    proches = false;
  }
  const icone = points.depart && points.depart.getElement();
  if (icone) icone.classList.toggle('chevauche', !!proches);
  if (!proches) return;
  majEtat(type, `${ico('triangle-alert', 'ic-sm')} Même endroit que ${type === 'depart' ? 'l\'arrivée' : 'le départ'}`, 'alerte');
  toast(type === 'depart'
    ? 'Le départ est au même endroit que l\'arrivée. Le départ, c\'est là où le livreur récupère le colis : cherchez ce lieu, envoyez un lien, ou touchez la carte.'
    : 'L\'arrivée est au même endroit que le départ. Placez l\'arrivée là où le colis doit être livré.', true);
}

/**
 * Remplit le repère avec le lieu connu le plus proche (« Près de Mairie de Yène »),
 * sans jamais écraser un texte écrit par le client.
 */
async function proposerRepere(type, prefixe = '') {
  const champ = form[type + '_repere'];
  const libre = () => !champ.value || champ.value === champ.dataset.auto;
  if (!libre() || !points[type]) return;
  const pt = coord(points[type]);
  let texte = 'Point placé sur la carte';
  // Lieu choisi dans la recherche : il reste la référence tant qu'on ajuste autour (moins de 500 m)
  let ancre = null;
  try { ancre = JSON.parse(champ.dataset.ancre || 'null'); } catch { /* aucune */ }
  if (ancre && distanceM(pt, ancre) < 500) {
    const d = distanceM(pt, ancre);
    texte = d < 25 ? ancre.nom : `À ${Math.max(10, Math.round(d / 10) * 10)} m de ${ancre.nom}`;
    if (prefixe) texte = `${prefixe} · ${texte.charAt(0).toLowerCase()}${texte.slice(1)}`;
    champ.value = texte;
    champ.dataset.auto = texte;
    return;
  }
  try {
    let meilleur = null;
    let min = Infinity;
    for (const l of await chargerLieux()) {
      if (l.categorie === 'rue') continue;
      const d = distanceM(pt, l);
      if (d < min) { min = d; meilleur = l; }
    }
    if (meilleur && min < 800) {
      const ou = nomAvecVillage(meilleur);
      texte = `${min < 60 ? 'À' : 'Près de'} ${ou}`;
    }
  } catch { /* lieux indisponibles : texte par défaut */ }
  if (prefixe) texte = `${prefixe} · ${texte.charAt(0).toLowerCase()}${texte.slice(1)}`;
  if (!libre() || !points[type]) return; // le client a écrit entre-temps
  champ.value = texte;
  champ.dataset.auto = texte;
  champ.classList.remove('erreur');
}

/** Place un point, centre la carte dessus et remplit le repère (si vide, ou si forcer). */
function placerAvecRepere(type, lat, lng, repere, forcer = false) {
  placer(type, L.latLng(lat, lng));
  carte.flyTo([lat, lng], Math.max(carte.getZoom(), ZOOM_LIEU), { duration: 0.6 });
  const champ = form[type + '_repere'];
  if (repere && (forcer || !champ.value || champ.value === champ.dataset.auto)) {
    champ.value = repere;
    champ.dataset.auto = repere;
  }
  champ.classList.remove('erreur');
}

const coord = (m) => ({ lat: m.getLatLng().lat, lng: m.getLatLng().lng });

/**
 * Position du téléphone, en deux temps :
 *  1. GPS précis (8 s) ;
 *  2. si le GPS ne répond pas (souvent à l'intérieur), position approximative Wi-Fi / réseau (15 s).
 * Les erreurs expliquent exactement quoi faire.
 */
function demanderGPS(options) {
  return new Promise((ok, ko) => navigator.geolocation.getCurrentPosition(ok, ko, options));
}

async function positionGPS() {
  if (!('geolocation' in navigator)) throw new Error('Ce navigateur ne donne pas la position. Touchez la carte pour placer le point.');
  if (!window.isSecureContext) {
    throw new Error('La position n\'est disponible que sur l\'adresse sécurisée (https://…). Ouvrez le lien https de l\'application.');
  }
  // Refus déjà enregistré : inutile d'attendre, on explique comment autoriser
  try {
    const perm = await navigator.permissions.query({ name: 'geolocation' });
    if (perm.state === 'denied') {
      throw new Error('La localisation est bloquée pour ce site. Touchez le cadenas à gauche de l\'adresse → Autorisations → Position → Autoriser, puis réessayez.');
    }
  } catch (e) { if (e.message.startsWith('La localisation est bloquée')) throw e; /* API absente (iPhone) : on continue */ }

  try {
    return await demanderGPS({ enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 });
  } catch (e) {
    if (e.code === 1) {
      throw new Error('Vous avez refusé la localisation. Autorisez-la pour ce site (cadenas à gauche de l\'adresse), ou touchez la carte.');
    }
    // GPS lent ou indisponible : on tente la position approximative
    try {
      return await demanderGPS({ enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
    } catch (e2) {
      if (e2.code === 1) throw new Error('Vous avez refusé la localisation. Autorisez-la pour ce site, ou touchez la carte.');
      throw new Error('Position introuvable. Activez la localisation (GPS) du téléphone, sortez si vous êtes à l\'intérieur, ou touchez la carte.');
    }
  }
}

async function boutonChargement(bouton, tache) {
  const contenu = bouton.innerHTML;
  bouton.disabled = true;
  bouton.innerHTML = `${ico('loader-circle', 'ic-sm tourne')} Patientez…`;
  try { return await tache(); } finally { bouton.disabled = false; bouton.innerHTML = contenu; }
}

// =========================================================================
// Adresses récentes
// =========================================================================
const lireAdresses = () => lireJSON(CLE_ADRESSES, []);
function memoriserAdresse(pt, repere) {
  if (!repere) return;
  const doublon = (x) => distanceM(x, pt) < 30 || x.repere.toLowerCase() === repere.toLowerCase();
  Stock.set(CLE_ADRESSES, JSON.stringify([{ lat: pt.lat, lng: pt.lng, repere }, ...lireAdresses().filter((x) => !doublon(x))].slice(0, 6)));
}
function afficherAdresses() {
  const liste = lireAdresses();
  $('recents').hidden = !liste.length || !$('fiche').hidden;
  $('recents-liste').innerHTML = liste.slice(0, 4).map((x, i) => {
    // « Ma position · près de l'École » → nom « Ma position », précision « près de l'École »
    const [nom, ...reste] = x.repere.split(/ · |, /);
    return `
    <button type="button" class="recent" data-i="${i}" title="${esc(x.repere)}">
      <span class="recent-ic">${ico('history')}</span>
      <span class="recent-texte"><b>${esc(nom)}</b>${reste.length ? `<small>${esc(reste.join(', '))}</small>` : ''}</span>
    </button>`;
  }).join('');
}
// =========================================================================
// Tracé du trajet
// =========================================================================
let jetonDevis = 0;
let erreurDevis = null; // message bloquant du dernier calcul de prix (ex. hors zone)
// Tracé du trajet A → B sur la carte (route réelle, ou ligne pointillée si l'itinéraire est indisponible)
let traceRoute = null;
let ptsTrace = null; // points du trajet affiché (pour recadrer quand la carte change de taille)
function effacerTrace() {
  if (traceRoute) traceRoute.forEach((l) => l.remove());
  traceRoute = null;
  ptsTrace = null;
}
function dessinerTrace(d) {
  effacerTrace();
  const pts = d.trace || [coord(points.depart), coord(points.arrivee)].map((p) => [p.lat, p.lng]);
  traceRoute = [
    L.polyline(pts, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false }),
    L.polyline(pts, { color: '#2e90fa', weight: 5, opacity: 1, dashArray: d.trace ? null : '8 10', interactive: false }),
  ].map((l) => l.addTo(carte));
  ptsTrace = pts;
  return pts;
}
/** Zoom automatique sur tout l'itinéraire, comme un GPS (en laissant la place à la recherche et aux boutons). */
/** Téléphone : carte plein écran sous le panneau du bas. Hauteur du panneau visible (0 sur ordinateur). */
const estTelephone = () => window.matchMedia('(max-width: 959px)').matches;
// téléphone tenu à l'horizontale : panneau à gauche sur toute la hauteur, carte à droite
const REQ_PAYSAGE = '(max-width: 959px) and (orientation: landscape) and (max-height: 560px)';
const enPaysage = () => window.matchMedia(REQ_PAYSAGE).matches;
const largeurPanneau = () => (enPaysage() ? $('feuille').getBoundingClientRect().width : 0);
function hauteurFeuille() {
  if (!estTelephone() || enPaysage()) return 0;
  const r = $('feuille').getBoundingClientRect();
  return Math.max(0, window.innerHeight - r.top);
}
function majHauteurFeuille() {
  document.documentElement.style.setProperty('--feuille-h', hauteurFeuille() + 'px');
}
if ('ResizeObserver' in window) new ResizeObserver(majHauteurFeuille).observe($('feuille'));
window.addEventListener('resize', majHauteurFeuille);
// la poignée réduit / agrandit le panneau (pour mieux voir la carte)
$('poignee').onclick = () => {
  document.body.classList.toggle('feuille-reduite');
  setTimeout(() => { majHauteurFeuille(); if (ptsTrace && points.depart && points.arrivee) recadrerItineraire(ptsTrace); }, 320);
};
// flèche retour : changer de destination
$('retour-carte').onclick = () => {
  if (document.body.classList.contains('feuille-recherche')) { fermerRecherche(); return; }
  if (!points.arrivee) { ouvrirAccueil(); return; }
  form.arrivee_repere.value = '';
  delete form.arrivee_repere.dataset.auto;
  delete form.arrivee_repere.dataset.ancre;
  retirerPoint('arrivee');
  imprecis.arrivee = null;
  choisirMode('arrivee');
  majDevis();
  form.arrivee_repere.focus();
};

function recadrerItineraire(pts) {
  const zone = L.latLngBounds(pts).extend(points.depart.getLatLng()).extend(points.arrivee.getLatLng());
  const large = window.matchMedia('(min-width: 960px)').matches;
  const h = carte.getSize().y;
  // marges pour la recherche (haut) et la bulle d'aide (bas), proportionnées à la hauteur de la carte
  carte.flyToBounds(zone, {
    paddingTopLeft: [30 + largeurPanneau(), estTelephone() ? (enPaysage() ? 70 : 130) : Math.min(large ? 130 : 80, h * 0.22)], // téléphone : place pour le logo et les bulles
    paddingBottomRight: [large ? 40 : 60, estTelephone() ? hauteurFeuille() + 30 : Math.min(large ? 70 : 100, h * 0.22)],
    maxZoom: 17,
    duration: 0.8,
  });
}
// =========================================================================
// Prix et fiche de commande (écran unique)
// =========================================================================
function prixVide(texte) {
  dernierDevis = null;
  erreurDevis = null;
  effacerTrace();
  $('aide-lieux').textContent = texte;
  $('aide-lieux').classList.remove('alerte');
  majFiche();
}

/** Recalcule prix, distance, durée et tracé. recadrer : zoomer sur l'itinéraire (après un placement). */
async function majDevis(recadrer = false) {
  if (!points.depart || !points.arrivee) {
    prixVide(!points.depart ? 'Indiquez d\'où vous partez, ou touchez le bouton de position.' : 'Écrivez où vous allez, ou touchez la carte.');
    return;
  }
  if (memeEndroit()) { prixVide('Le départ et l\'arrivée sont au même endroit.'); return; }
  const jeton = ++jetonDevis;
  $('fiche').classList.add('charge');
  try {
    const d = await api('POST', '/api/courses/devis', { depart: coord(points.depart), arrivee: coord(points.arrivee) });
    if (jeton !== jetonDevis) return; // une réponse plus récente arrive
    dernierDevis = d;
    erreurDevis = null;
    $('aide-lieux').classList.remove('alerte');
    const pts = dessinerTrace(d);
    if (recadrer) recadrerItineraire(pts);
  } catch (e) {
    if (jeton !== jetonDevis) return;
    effacerTrace();
    dernierDevis = null;
    erreurDevis = e.message; // ex. hors zone
    $('aide-lieux').textContent = e.message;
    $('aide-lieux').classList.add('alerte');
  } finally {
    if (jeton === jetonDevis) { $('fiche').classList.remove('charge'); majFiche(); }
  }
}

// ---------- Ce que veut le client : moto, voiture ou colis ----------
const MAX_MIN_AFFICHE = 45; // temps d'arrivée affiché au plus (sinon « Loin »)
const CLE_CHOIX = 'tt_choix';
let choix = ['moto', 'voiture', 'confort', 'colis'].includes(Stock.get(CLE_CHOIX)) ? Stock.get(CLE_CHOIX) : 'moto';
const estTrajet = () => choix !== 'colis';
/** Prix de la course selon le choix (le calcul renvoie le prix moto et le prix voiture). */
function prixCourse(d = dernierDevis) {
  if (!d) return 0;
  return (choix === 'confort' ? (d.prix_confort || d.prix) : choix === 'voiture' ? (d.prix_voiture || d.prix) : d.prix) + fraisAchatClient();
}
/** Frais d'achat (« Acheter pour moi ») : même calcul que le serveur. */
function fraisAchatClient() {
  if (choix !== 'colis' || form.type.value !== 'achat') return 0;
  const pct = Number(reglagesFrais.frais_achat_pct) || 0;
  if (!pct) return 0;
  return Math.max(Number(reglagesFrais.frais_achat_min) || 0, Math.round(((Number(form.montant_achat.value) || 0) * pct) / 100));
}
const OPTIONS = [
  { id: 'moto', image: '/img/photos/moto.webp', nom: 'Moto', detail: 'Jakarta, 1 personne', prix: (d) => d.prix_moto || d.prix },
  { id: 'voiture', image: '/img/photos/eco.webp', nom: 'Éco', detail: 'Taxi ou clando, 4 places', prix: (d) => d.prix_voiture || d.prix },
  { id: 'confort', image: '/img/photos/confort.webp', nom: 'Confort', detail: 'Climatisée, 4 places', prix: (d) => d.prix_confort || d.prix_voiture || d.prix },
  { id: 'colis', image: '/img/photos/livraison.webp', nom: 'Colis', detail: 'Un objet, des achats', prix: (d) => d.prix },
];

/** La fiche apparaît dès que le départ et l'arrivée sont connus et le prix calculé. */
/** Bulles sur la carte : temps d'arrivée du chauffeur au départ, heure d'arrivée à destination. */
function majBulles(pret) {
  const bulle = (m, html, classe = '') => {
    if (!m) return;
    if (!html) { m.unbindTooltip(); return; }
    if (m.getTooltip()) m.setTooltipContent(html);
    else m.bindTooltip(html, { permanent: true, direction: 'top', offset: [0, -44], className: 'bulle-carte ' + classe, interactive: false }).openTooltip();
  };
  const d = dernierDevis;
  const x = pret && d && d.chauffeurs ? d.chauffeurs[choix] : null;
  bulle(points.depart, x && x.nb ? `<b>${x.minutes}</b><small>min</small>` : null, 'bulle-temps');
  if (pret && d && d.minutes) {
    const h = new Date(Date.now() + ((x && x.nb ? x.minutes : 0) + d.minutes) * 60000);
    bulle(points.arrivee, `arrivée à <b>${String(h.getHours()).padStart(2, '0')}:${String(h.getMinutes()).padStart(2, '0')}</b>`);
  } else bulle(points.arrivee, null);
}

let fichePrete = false;
function majFiche() {
  $('retour-carte').hidden = false; // avec destination : la changer ; sans : retour à l'accueil
  requestAnimationFrame(majHauteurFeuille);
  const pret = !!(dernierDevis && points.depart && points.arrivee && !erreurDevis && !memeEndroit());
  $('fiche').hidden = !pret;
  document.body.classList.toggle('fiche-ouverte', pret);
  $('aide-lieux').hidden = pret;
  afficherAdresses();
  const vientDOuvrir = pret && !fichePrete;
  // trajet prêt : on quitte l'écran de recherche pour montrer les prix
  if (vientDOuvrir) {
    document.body.classList.remove('feuille-recherche');
    if (document.activeElement && document.activeElement.closest('.lieux')) document.activeElement.blur(); // range le clavier
  }
  fichePrete = pret;
  majBulles(pret);
  if (vientDOuvrir && estTelephone()) setTimeout(() => { majHauteurFeuille(); if (ptsTrace) recadrerItineraire(ptsTrace); }, 120);
  if (!pret) return;
  const d = dernierDevis;
  $('fiche-trajet').innerHTML = `${ico('route', 'ic-sm')} ${d.distance_km.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km${d.minutes ? ` · environ ${d.minutes} min` : ''}`;
  const ch = d.chauffeurs || {};
  $('options').innerHTML = OPTIONS.map((o) => {
    const x = ch[o.id];
    // au-delà de 45 min, un temps d'arrivée n'a plus de sens pour le client : on ne l'affiche pas
    const temps = !x ? '' : x.nb ? (x.minutes <= MAX_MIN_AFFICHE ? `${x.minutes} min` : 'Loin') : 'Occupé';
    return `
    <button type="button" class="option ${choix === o.id ? 'choisi' : ''} ${x && !x.nb ? 'occupe' : ''}" data-choix="${o.id}" role="radio" aria-checked="${choix === o.id}">
      <span class="option-visuel"><img src="${o.image}" alt="" loading="lazy">${temps ? `<span class="option-temps">${temps}</span>` : ''}</span>
      <span class="option-nom">${o.nom}</span>
      <b class="option-prix">${fcfa(o.prix(d))}</b>
    </button>`;
  }).join('');
  // détail du choix, et prévenir quand personne n'est libre (la commande reste possible : elle attendra)
  const o = OPTIONS.find((x) => x.id === choix);
  const dispo = ch[choix];
  $('option-detail').innerHTML = `<span class="choix-titre">Vous avez choisi ${o.nom}</span><span class="choix-sous">${o.detail}${dispo && dispo.nb ? ` · ${dispo.nb} disponible${dispo.nb > 1 ? 's' : ''}` : ''}</span>`
    + (dispo && !dispo.nb ? `<span class="occupe-note">${ico('clock', 'ic-sm')} Aucun disponible pour l'instant : votre demande attendra le premier libre.</span>` : '');
  // faire défiler jusqu'au choix (petits écrans)
  const carteChoisie = $('options').querySelector('.option.choisi');
  if (carteChoisie) carteChoisie.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  form.service.value = estTrajet() ? 'trajet' : 'livraison';
  form.vehicule.value = ['voiture', 'confort'].includes(choix) ? choix : 'moto';
  $('bloc-colis').hidden = estTrajet();
  // « pour quelqu'un d'autre » : passager (trajet) ou destinataire (colis)
  $('pour-autre-titre').textContent = estTrajet() ? 'Commander pour quelqu\'un d\'autre' : 'Pour une autre personne (reçoit le colis)';
  $('pour-autre-aide').textContent = estTrajet()
    ? 'Le chauffeur appellera cette personne. Vous suivez la course depuis votre téléphone.'
    : 'Le livreur appellera cette personne pour la livraison.';
  $('pour-autre-nom').textContent = estTrajet() ? 'Nom du passager' : 'Son nom';
  $('pour-autre-tel').textContent = estTrajet() ? 'Téléphone du passager' : 'Son téléphone';
  majBoutonOptions();
  afficherCoordonnees();
  majPaiement();
  majCommander();
}
setInterval(() => { if (!$('fiche').hidden && document.visibilityState === 'visible') majDevis(); }, 45000);
$('options').addEventListener('click', (e) => {
  const b = e.target.closest('[data-choix]');
  if (!b) return;
  choix = b.dataset.choix;
  Stock.set(CLE_CHOIX, choix);
  if (choix !== 'colis') Stock.set('tt_choix_trajet', choix);
  majFiche();
  majBulles(fichePrete);
});

/** L'icône à droite de « Commander » est marquée quand la commande est pour quelqu'un d'autre. */
function majBoutonOptions() {
  const rempli = !!(form.destinataire_nom.value.trim() || form.destinataire_tel.value.trim());
  $('btn-options').classList.toggle('actif', rempli || $('bloc-destinataire').open);
}
$('btn-options').onclick = () => {
  const bloc = $('bloc-destinataire');
  bloc.open = !bloc.open;
  if (bloc.open) { bloc.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => form.destinataire_nom.focus(), 300); }
  majBoutonOptions();
};
$('bloc-destinataire').addEventListener('toggle', majBoutonOptions);
form.addEventListener('input', (e) => { if (/^destinataire_/.test(e.target.name)) majBoutonOptions(); });

function majCommander() {
  const m = moyenChoisi();
  $('btn-commander').innerHTML = `<span>Commander</span><small>${fcfa(prixCourse())}</small>`;
  const qui = estTrajet() ? 'un chauffeur' : 'un livreur';
  const fsrv = (dernierDevis && dernierDevis.frais_service) || 0;
  const fa = fraisAchatClient();
  const detail = [fsrv ? `${fcfa(fsrv)} de frais de service` : '', fa ? `${fcfa(fa)} de frais d'achat` : ''].filter(Boolean).join(' et ');
  $('fiche-note').textContent = (m === 'especes'
    ? (estTrajet() ? 'Espèces, à l\'arrivée' : 'Espèces, à la livraison')
    : `${MOYENS[m].nom}, après l'acceptation`)
    + (detail ? ` · dont ${detail}${fa ? ' · achats en plus' : ''}` : '');
}

/** Moyen de paiement : une petite liste, le dernier choix est gardé. */
function majPaiement() {
  const sel = $('choix-paiement');
  const dispo = [...paiementsEnLigne, 'especes'];
  const voulu = sel.value || Stock.get(CLE_PAIEMENT);
  const choisi = dispo.includes(voulu) ? voulu : 'especes';
  sel.innerHTML = dispo.map((m) => `<option value="${m}" ${m === choisi ? 'selected' : ''}>${m === 'especes' ? 'Espèces' : MOYENS[m].nom}</option>`).join('');
}
$('choix-paiement').addEventListener('change', () => { Stock.set(CLE_PAIEMENT, $('choix-paiement').value); majCommander(); });

// ---------- Colis : que faut-il livrer ? (un toucher) ----------
const CHOIX_COLIS = [['Colis', 'package'], ['Documents', 'file-text'], ['Repas', 'utensils'], ['Médicaments', 'pill'], ['Gaz', 'flame']];
function afficherChoixRapides() {
  const texte = form.description.value.trim().toLowerCase();
  const achat = form.type.value === 'achat';
  $('choix-rapides').innerHTML = CHOIX_COLIS.map(([n, i]) => `
    <button type="button" class="chip ${!achat && texte === n.toLowerCase() ? 'choisi' : ''}" data-mot="${esc(n)}">${ico(i, 'ic-sm')} ${esc(n)}</button>`).join('')
    + `<button type="button" class="chip ${achat ? 'choisi' : ''}" data-achat>${ico('shopping-bag', 'ic-sm')} Acheter pour moi</button>`;
  form.description.placeholder = achat ? 'Que faut-il acheter ? (ex : 2 pains, 1 sachet de lait)' : 'Que faut-il livrer ? (ex : un sac de riz)';
  $('l-montant').hidden = !achat;
}
$('choix-rapides').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-achat')) {
    form.type.value = form.type.value === 'achat' ? 'colis' : 'achat';
    form.description.value = '';
    afficherChoixRapides();
    majCommander();
    form.description.focus();
    return;
  }
  form.type.value = 'colis';
  form.description.value = b.dataset.mot;
  majCommander();
  form.description.classList.remove('erreur');
  afficherChoixRapides();
});
form.addEventListener('input', (e) => {
  e.target.classList.remove('erreur');
  if (e.target.name === 'description') afficherChoixRapides();
  if (e.target.name === 'montant_achat' && !$('fiche').hidden) majCommander(); // frais d'achat recalculés
});

// ---------- Vous : demandé une seule fois, ensuite résumé sur une ligne ----------
const telValide = () => /^7\d{8}$/.test(form.client_tel.value.replace(/\D/g, '').slice(-9));
let coordEnEdition = false;
try {
  const c = JSON.parse(Stock.get(CLE_COORD) || '{}');
  if (c.nom) form.client_nom.value = c.nom;
  if (c.tel) form.client_tel.value = c.tel;
} catch { /* rien */ }
function afficherCoordonnees() {
  const nom = form.client_nom.value.trim();
  const connues = !!nom && telValide() && !coordEnEdition;
  $('coord-connues').hidden = !connues;
  $('coord-saisie').hidden = connues;
  if (connues) {
    $('coord-avatar').textContent = initiales(nom);
    $('coord-nom').textContent = nom;
    $('coord-tel').textContent = telAffiche(form.client_tel.value.replace(/\D/g, '').slice(-9));
  }
}
$('coord-modifier').onclick = () => { coordEnEdition = true; afficherCoordonnees(); form.client_tel.focus(); };

// ---------- Fenêtre de paiement (secours, sans page Nangu) ----------
function fermerConfirmation() {
  $('confirmation').hidden = true;
  document.body.classList.remove('sans-defilement');
  arreterSuiviPaiement(); // la confirmation arrivera aussi en direct dans « Mes courses »
}
$('confirmation').addEventListener('click', (e) => { if (e.target.closest('[data-fermer-conf]')) fermerConfirmation(); });


// =========================================================================
// Mes livraisons (tiroir)
// =========================================================================
function ouvrirTiroir() { if ($('tiroir').hidden) empiler('tiroir'); $('tiroir').hidden = false; document.body.classList.add('sans-defilement'); }
function fermerTiroir() { $('tiroir').hidden = true; document.body.classList.remove('sans-defilement'); }
$('ouvrir-suivi').onclick = () => { ouvrirTiroir(); chargerListe(); };
$('tiroir').addEventListener('click', (e) => { if (e.target.closest('[data-fermer]')) fermerTiroir(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('tiroir').hidden) fermerTiroir(); });

function carteCourse(c) {
  const code = esc(c.suivi_token);
  const enCours = ['attente_paiement', 'en_attente', 'acceptee', 'recuperee'].includes(c.statut);
  const enLigne = c.paiement !== 'especes';
  const paye = c.paiement_statut === 'paye';
  // un livreur a accepté et attend le paiement (ou ancien fonctionnement « attente_paiement »)
  const aPayer = enLigne && !paye && (c.statut === 'attente_paiement' || (c.statut === 'acceptee' && c.paiement_statut === 'en_attente'));
  const actions = [];
  const pourMoi = codesDest().includes(c.suivi_token); // je suis le destinataire de ce colis
  const telDest = String(c.destinataire_tel || '').replace(/\D/g, '').slice(-9);
  if (!pourMoi && c.service !== 'trajet' && enCours && /^7\d{8}$/.test(telDest)) {
    // le client prévient le destinataire d'un toucher (message WhatsApp avec le lien de suivi)
    const texte = `Bonjour${c.destinataire_nom ? ' ' + c.destinataire_nom : ''}, je vous envoie un colis avec Yobalema Yène. Suivez la livraison et soyez prévenu quand le livreur arrive : ${lienDestinataire(c.suivi_token)}`;
    actions.push(`<a class="bouton whatsapp" href="https://wa.me/221${telDest}?text=${encodeURIComponent(texte)}" target="_blank" rel="noopener">${ico('message-circle', 'ic-sm')} Prévenir ${esc(c.destinataire_nom || 'le destinataire')}</a>`);
  }
  if (pourMoi) {
    if (enRoute(c)) actions.push(`<button data-voir-carte="${c.id}">${ico('map-pin', 'ic-sm')} Voir sur la carte</button>`);
    if (!enCours) actions.push(`<button class="btn-ghost" data-retirer="${code}">${ico('trash-2', 'ic-sm')} Retirer</button>`);
  }
  if (!pourMoi && aPayer) actions.push(`<button class="btn-primaire" data-payer="${code}">${ico('wallet', 'ic-sm')} Payer ${fcfa(c.montant_du || c.prix)}</button>`);
  // annulation possible tant que rien n'est payé (une course payée se règle avec Yobalema, qui rembourse)
  if (!pourMoi && !paye && (['en_attente', 'attente_paiement'].includes(c.statut) || (c.statut === 'acceptee' && enLigne))) {
    actions.push(`<button class="danger" data-annuler="${code}">${ico('circle-x', 'ic-sm')} Annuler</button>`);
  }
  if (!pourMoi && enRoute(c)) actions.push(`<button data-voir-carte="${c.id}">${ico('map-pin', 'ic-sm')} Voir sur la carte</button>`);
  if (!pourMoi && enCours) actions.push(`<button data-partager="${code}">${ico('share-2', 'ic-sm')} Partager le suivi</button>`);
  if (!pourMoi && !enCours) actions.push(`<button class="btn-ghost" data-retirer="${code}">${ico('trash-2', 'ic-sm')} Retirer</button>`);
  let notation = '';
  if (c.statut === 'livree' && !pourMoi) {
    notation = c.note
      ? `<div class="etoiles">Votre note <span style="color:#f5b301">${'★'.repeat(c.note)}${'☆'.repeat(5 - c.note)}</span></div>`
      : `<div class="etoiles">Notez le livreur ${[1, 2, 3, 4, 5].map((n) => `<button data-noter="${code}" data-note="${n}" aria-label="${n} étoile${n > 1 ? 's' : ''}">☆</button>`).join('')}</div>`;
  }
  const moyen = c.paiement === 'orange_money' ? 'Orange Money' : c.paiement === 'wave' ? 'Wave' : 'Espèces';
  let attente = '';
  if (c.statut === 'attente_paiement') attente = `<div class="ligne-info">${ico('wallet', 'ic-sm')} Paiement ${moyen} en attente : les livreurs seront prévenus dès réception.</div>`;
  else if (c.statut === 'en_attente') {
    attente = `<div class="ligne-info">${ico('loader-circle', 'ic-sm tourne')} Recherche d'un livreur disponible…</div>`;
    if (enLigne && !paye) attente += `<div class="ligne-info">${ico('wallet', 'ic-sm')} Vous paierez avec ${moyen} dès qu'un livreur aura accepté. Rien à payer pour l'instant.</div>`;
  } else if (aPayer) {
    attente = `<div class="ligne-info alerte-payer">${ico('bell', 'ic-sm')} <b>Un livreur a accepté !</b> Payez maintenant pour qu'il vienne chercher le colis (10 minutes).</div>`;
  }
  if (c.rembourse_le) attente += `<div class="ligne-info paiement-ok">${ico('undo-2', 'ic-sm')} Remboursé : ${fcfa(c.rembourse_montant)} par ${moyen}</div>`;
  else if (c.paiement_statut === 'paye' && c.statut === 'annulee') attente += `<div class="ligne-info alerte-payer">${ico('wallet', 'ic-sm')} Payé par ${moyen} : remboursement en cours</div>`;
  else if (c.paiement_statut === 'paye') attente += `<div class="ligne-info paiement-ok">${ico('circle-check', 'ic-sm')} Payé par ${moyen}</div>`;
  if (c.statut === 'annulee') attente = `<div class="ligne-info">${ico('info', 'ic-sm')} Nous sommes désolés : aucun${c.service === 'trajet' ? 'e voiture n\'était disponible' : ' livreur n\'était disponible'}.</div>` + attente;
  return `
    <article class="course">
      <div class="haut">${badge(c.statut, c.service)}<span class="prix-course">${fcfa(c.prix)}</span></div>
      ${frise(c.statut, c.service)}
      ${pourMoi ? `<div class="ligne-info pour-moi">${ico('package', 'ic-sm')} <b>Colis pour vous</b>${c.client_nom ? ` · envoyé par ${esc(c.client_nom)}` : ''}</div>` : ''}
      <div class="trajet">
        <div>${esc(c.depart_repere)}</div>
        <div>${esc(c.arrivee_repere)}</div>
      </div>
      <div class="ligne-info">${ico(c.service === 'trajet' ? gamme(c.vehicule).icone : c.type === 'achat' ? 'shopping-bag' : 'package', 'ic-sm')} ${esc(c.description)}</div>
      ${c.type === 'achat' && c.montant_achat ? `<div class="ligne-info">${ico('banknote', 'ic-sm')} Budget achats : ${fcfa(c.montant_achat)}</div>` : ''}
      ${attente}
      ${c.livreur_nom && ['acceptee', 'recuperee'].includes(c.statut) ? blocPersonne(c.livreur_nom, c.livreur_tel, c.service === 'trajet' ? 'Votre chauffeur' : 'Votre livreur') : ''}
      ${c.livreur_nom && c.service === 'trajet' && ['acceptee', 'recuperee'].includes(c.statut)
        ? `<div class="vehicule-chauffeur">${ico(gamme(c.livreur_vehicule).icone, 'ic-sm')} ${gamme(c.livreur_vehicule).vehicule}${c.livreur_modele ? ' · ' + esc(c.livreur_modele) : ''}${c.livreur_plaque ? ' · ' + esc(c.livreur_plaque) : ''}</div>` : ''}
      ${enRoute(c) && !(c.statut === 'acceptee' && c.arrive_le) ? `<div class="ligne-info approche" data-approche="${c.id}">${texteApproche(c)}</div>` : ''}
      ${c.statut === 'acceptee' && c.arrive_le ? `<div class="ligne-info chauffeur-arrive">${ico('map-pin', 'ic-sm')} ${c.service === 'trajet' ? 'Votre chauffeur est arrivé au point de départ.' : 'Le livreur est arrivé au point de départ.'}</div>` : ''}
      <div class="meta" style="margin-top:8px">${dateCourte(c.cree_le)} · ${Number(c.distance_km).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km</div>
      ${notation}
      ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
    </article>`;
}

let derniereListe = [];

// =========================================================================
// Le chauffeur / livreur en direct sur la carte (comme une appli de VTC)
// =========================================================================
const vehicules = new Map(); // id de course → { marqueur, ligne, anim }
let courseSuivie = null;     // course affichée dans le bandeau « course en cours »
let dejaCadre = null;        // id de la course déjà recadrée (on ne recadre qu'une fois, puis le client est libre)

const enRoute = (c) => ['acceptee', 'recuperee'].includes(c.statut) && c.livreur_lat != null && c.livreur_lng != null;
/** Le chauffeur va d'abord au départ (A), puis à l'arrivée (B) une fois le passager à bord / le colis récupéré. */
const cibleCourse = (c) => (c.statut === 'recuperee'
  ? { lat: c.arrivee_lat, lng: c.arrivee_lng }
  : { lat: c.depart_lat, lng: c.depart_lng });

/** Distance et durée restantes : sur la route (OSRM) quand elle est connue, sinon à vol d'oiseau corrigé. */
function approche(c) {
  const v = vehicules.get(c.id);
  const r = v && v.route;
  if (r && r.cle === cleRoute(c) && r.reste != null) {
    const min = r.duree * (r.reste / Math.max(r.distance, 1)) / 60;
    return { m: r.reste, min: Math.max(1, Math.round(min)) };
  }
  const d = distanceM({ lat: c.livreur_lat, lng: c.livreur_lng }, cibleCourse(c)) * 1.3;
  const vitesse = enVoiture(c.livreur_vehicule) ? 22 : 25; // km/h en moyenne à Yène
  return { m: d, min: Math.max(1, Math.round((d / 1000 / vitesse) * 60)) };
}
const texteDistance = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`);

function iconeVehicule(c) {
  const voiture = enVoiture(c.livreur_vehicule);
  return L.divIcon({
    className: '',
    html: `<div class="vehicule-carte${voiture ? ' voiture' : ''}">${ico(gamme(c.livreur_vehicule).icone)}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

// ---------- Itinéraire par la route (OSRM, comme le guidage du chauffeur) ----------
const OSRM_CLIENT = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
const cleRoute = (c) => c.id + ':' + c.statut; // la cible change quand le passager monte / le colis est récupéré
async function routeOSRM(de, vers) {
  const r = await fetch(`${OSRM_CLIENT}${de.lng},${de.lat};${vers.lng},${vers.lat}?overview=full&geometries=geojson`);
  if (!r.ok) throw new Error('itinéraire indisponible');
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes.length) throw new Error('aucun itinéraire');
  const x = j.routes[0];
  return { pts: x.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distance: x.distance, duree: x.duration };
}
/** Longueur (m) d'une suite de points [lat, lng]. */
function longueur(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distanceM({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] });
  return m;
}
/** Morceau de route qui reste devant le chauffeur, et sa distance à la route (pour savoir s'il s'en écarte). */
function resteDeRoute(pts, pos) {
  let k = 0;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = distanceM(pos, { lat: pts[i][0], lng: pts[i][1] });
    if (d < best) { best = d; k = i; }
  }
  return { pts: [[pos.lat, pos.lng], ...pts.slice(k + 1)], ecart: best };
}
/** Trace (ou met à jour) la route du chauffeur jusqu'à sa cible ; recalculée s'il s'écarte de plus de 120 m. */
async function majRouteVehicule(c, v, pos) {
  const cle = cleRoute(c);
  const r = v.route;
  if (r && r.cle === cle && r.pts) {
    const reste = resteDeRoute(r.pts, pos);
    if (reste.ecart < 120) {
      v.ligneRoute.forEach((l) => l.setLatLngs(reste.pts));
      r.reste = longueur(reste.pts);
      v.ligne.setStyle({ opacity: 0 });
      return;
    }
    r.reste = null; // il a pris une autre route : estimation à vol d'oiseau en attendant le nouveau calcul
  }
  if (v.calcul || (r && r.cle === cle && Date.now() - r.le < 8000)) return; // pas plus d'un calcul toutes les 8 s
  v.calcul = true;
  try {
    const x = await routeOSRM(pos, cibleCourse(c));
    x.pts.unshift([pos.lat, pos.lng]); // le tracé part bien de la moto / de la voiture, même hors route
    v.route = { cle, pts: x.pts, distance: x.distance, duree: x.duree, reste: x.distance, le: Date.now() };
    v.ligneRoute.forEach((l) => l.setLatLngs(x.pts));
    v.ligne.setStyle({ opacity: 0 }); // la ligne droite de secours disparaît
    afficherCourseActive();
    const ligne = document.querySelector(`[data-approche="${c.id}"]`);
    if (ligne) ligne.innerHTML = texteApproche(c);
  } catch {
    v.route = { cle, pts: null, le: Date.now() }; // serveur d'itinéraire indisponible : on garde la ligne droite
    v.ligne.setStyle({ opacity: 0.55 });
  } finally { v.calcul = false; }
}
/** Trajet prévu du départ à l'arrivée, en pointillé clair (calculé une fois par course). */
async function majTrajetPrevu(c, v) {
  if (v.prevu || v.calculPrevu) return;
  v.calculPrevu = true;
  try {
    const x = await routeOSRM({ lat: c.depart_lat, lng: c.depart_lng }, { lat: c.arrivee_lat, lng: c.arrivee_lng });
    v.prevu = L.polyline(x.pts, { color: '#2e90fa', weight: 4, opacity: 0.45, dashArray: '2 9', lineCap: 'round', interactive: false }).addTo(carte);
    v.prevu.bringToBack();
  } catch { /* pas grave : seule la route du chauffeur est affichée */ } finally { v.calculPrevu = false; }
}

/** Déplace le marqueur en douceur jusqu'à la nouvelle position (au lieu d'un saut). */
function glisser(v, vers) {
  if (v.anim) cancelAnimationFrame(v.anim);
  const de = v.marqueur.getLatLng();
  const t0 = performance.now();
  const pas = (t) => {
    const k = Math.min(1, (t - t0) / 1200);
    v.marqueur.setLatLng([de.lat + (vers.lat - de.lat) * k, de.lng + (vers.lng - de.lng) * k]);
    if (k < 1) v.anim = requestAnimationFrame(pas);
  };
  v.anim = requestAnimationFrame(pas);
}

/** Affiche / met à jour / retire les véhicules des courses en cours. */
function majVehicules() {
  if (!carte) return;
  const actives = derniereListe.filter(enRoute);
  const ids = new Set(actives.map((c) => c.id));
  for (const [id, v] of vehicules) {
    if (!ids.has(id)) {
      [v.marqueur, v.ligne, ...v.ligneRoute, v.prevu].forEach((l) => l && l.remove());
      vehicules.delete(id);
    }
  }
  for (const c of actives) {
    const pos = { lat: Number(c.livreur_lat), lng: Number(c.livreur_lng) };
    const cible = cibleCourse(c);
    let v = vehicules.get(c.id);
    if (!v) {
      v = {
        marqueur: L.marker(pos, { icon: iconeVehicule(c), zIndexOffset: 2000, interactive: false }).addTo(carte),
        ligne: L.polyline([pos, cible], { color: '#0a2a62', weight: 3, opacity: 0.55, dashArray: '6 8', interactive: false }).addTo(carte),
        // route par les rues : bordure blanche + trait bleu foncé, comme un GPS
        ligneRoute: [
          L.polyline([], { color: '#ffffff', weight: 9, opacity: 0.95, interactive: false }).addTo(carte),
          L.polyline([], { color: '#0a2a62', weight: 5, opacity: 0.95, interactive: false }).addTo(carte),
        ],
      };
      vehicules.set(c.id, v);
    } else {
      v.marqueur.setIcon(iconeVehicule(c));
      glisser(v, pos);
    }
    v.ligne.setLatLngs([pos, cible]);
    majRouteVehicule(c, v, pos);
    if (c.statut === 'acceptee') majTrajetPrevu(c, v);
    else if (v.prevu) { v.prevu.remove(); v.prevu = null; } // passager à bord : la route du chauffeur suffit
  }
  courseSuivie = actives[0] || derniereListe.find((c) => c.statut === 'acceptee' || c.statut === 'recuperee') || null;
  if (courseSuivie && !$('accueil').hidden) fermerAccueil();
  afficherCourseActive();
  // première apparition du véhicule : on cadre la carte sur lui et sur le point où il va
  if (courseSuivie && enRoute(courseSuivie) && dejaCadre !== courseSuivie.id + courseSuivie.statut) {
    dejaCadre = courseSuivie.id + courseSuivie.statut;
    recadrerSurVehicule(courseSuivie);
  }
}

function recadrerSurVehicule(c) {
  if (!carte || !enRoute(c)) return;
  const cible = cibleCourse(c);
  carte.invalidateSize(); // la carte a pu changer de taille (bandeau, rotation, plein écran)
  const v = vehicules.get(c.id);
  const zone = L.latLngBounds([[c.livreur_lat, c.livreur_lng], [cible.lat, cible.lng]]);
  if (v && v.route && v.route.pts) zone.extend(L.latLngBounds(v.route.pts));
  carte.fitBounds(zone, { paddingTopLeft: [50 + largeurPanneau(), 80], paddingBottomRight: [50, hauteurFeuille() + 40], maxZoom: 17 });
}

/** Bandeau sur l'écran principal : qui arrive, dans combien de temps, avec quel véhicule. */
function afficherCourseActive() {
  const el = $('suivi-direct');
  const c = courseSuivie;
  document.body.classList.toggle('course-en-cours', !!c);
  if (!c) { el.hidden = true; el.innerHTML = ''; return; }
  const trajet = c.service === 'trajet';
  const qui = esc(c.livreur_nom || (trajet ? 'Votre chauffeur' : 'Votre livreur'));
  let titre;
  let detail = '';
  if (c.statut === 'acceptee' && c.arrive_le) {
    titre = trajet ? `${qui} est arrivé, il vous attend` : `${qui} est arrivé au point de départ`;
  } else if (enRoute(c)) {
    const a = approche(c);
    if (c.statut === 'acceptee') {
      titre = a.m < 80 ? `${qui} est tout près` : `${qui} arrive dans ${a.min} min`;
      detail = `À ${texteDistance(a.m)} de vous`;
    } else {
      titre = trajet ? `Arrivée dans ${a.min} min` : `Livraison dans ${a.min} min`;
      detail = `Encore ${texteDistance(a.m)}`;
    }
  } else {
    titre = c.statut === 'recuperee' ? (trajet ? 'Course en cours' : 'Colis en route') : `${qui} arrive`;
    detail = 'Position du véhicule bientôt disponible';
  }
  const vehicule = [gamme(c.livreur_vehicule).vehicule, c.livreur_modele, c.livreur_plaque].filter(Boolean).map(esc).join(' · ');
  const tel = String(c.livreur_tel || '').replace(/\D/g, '');
  el.innerHTML = `
    <span class="pic-rond">${ico(gamme(c.livreur_vehicule).icone)}</span>
    <div class="suivi-direct-texte">
      <b>${titre}</b>
      <small>${[detail, vehicule].filter(Boolean).join(' · ')}</small>
    </div>
    <div class="suivi-direct-actions">
      ${tel ? `<a class="btn-rond" href="tel:${tel}" aria-label="Appeler">${ico('phone')}</a>` : ''}
      <button type="button" class="btn-rond" data-voir aria-label="Voir sur la carte">${ico('locate-fixed')}</button>
      <button type="button" class="btn btn-ghost" data-details>Détails</button>
    </div>`;
  el.classList.toggle('arrive', !!(c.statut === 'acceptee' && c.arrive_le));
  el.hidden = false;
}
$('suivi-direct').addEventListener('click', (e) => {
  if (e.target.closest('[data-details]')) { ouvrirTiroir(); chargerListe(); return; }
  if (e.target.closest('[data-voir]') && courseSuivie) {
    $('bloc-carte').scrollIntoView({ behavior: 'smooth', block: 'start' });
    recadrerSurVehicule(courseSuivie);
  }
});

/** Nouvelle position envoyée par le téléphone du chauffeur (toutes les 5 s environ). */
function positionVehicule(p) {
  const c = derniereListe.find((x) => x.id === p.course_id);
  if (!c) return;
  c.livreur_lat = p.lat;
  c.livreur_lng = p.lng;
  majVehicules();
  // la ligne « à X m » de la carte de suivi, si « Mes courses » est ouvert
  const ligne = document.querySelector(`[data-approche="${c.id}"]`);
  if (ligne) ligne.innerHTML = texteApproche(c);
}

function texteApproche(c) {
  if (!enRoute(c)) return '';
  const a = approche(c);
  const ou = c.statut === 'recuperee' ? 'de l\'arrivée' : 'du départ';
  return `${ico('navigation', 'ic-sm')} ${c.service === 'trajet' ? 'Chauffeur' : 'Livreur'} à ${texteDistance(a.m)} ${ou} · environ ${a.min} min`;
}

/** Code de suivi d'une course de ce téléphone, à partir de son numéro (les mises à jour en direct n'envoient que le numéro). */
const codeDeCourse = (id) => (derniereListe.find((x) => x.id === id) || {}).suivi_token;

async function chargerListe() {
  const codes = lireCodes();
  const bouton = $('ouvrir-suivi');
  if (!codes.length) { bouton.hidden = true; derniereListe = []; majVehicules(); $('liste').innerHTML = '<p class="vide">Aucune livraison pour le moment.</p>'; return; }
  try {
    const liste = await api('GET', '/api/courses/suivi?codes=' + codes.map(encodeURIComponent).join(','));
    derniereListe = liste;
    const connus = new Set(liste.map((c) => c.suivi_token));
    if (connus.size !== codes.length) ecrireCodes(codes.filter((c) => connus.has(c)));
    const actives = liste.filter((c) => ['attente_paiement', 'en_attente', 'acceptee', 'recuperee'].includes(c.statut)).length;
    bouton.hidden = !liste.length;
    $('nb-actives').hidden = !actives;
    $('nb-actives').textContent = actives;
    $('accueil-mes-courses').hidden = !liste.length;
    $('accueil-nb').hidden = !actives;
    $('accueil-nb').textContent = actives;
    $('liste').innerHTML = liste.length ? liste.map(carteCourse).join('') : '<p class="vide">Aucune livraison pour le moment.</p>';
    majVehicules();
  } catch (e) { toast(e.message, true); }
}

$('liste').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.annuler) {
      if (!confirm('Annuler cette demande de livraison ?')) return;
      await api('POST', `/api/courses/suivi/${encodeURIComponent(b.dataset.annuler)}/annuler`);
      toast('Livraison annulée');
    } else if (b.dataset.noter) {
      await api('POST', `/api/courses/suivi/${encodeURIComponent(b.dataset.noter)}/noter`, { note: Number(b.dataset.note) });
      toast('Merci pour votre note');
    } else if (b.dataset.partager) {
      const lien = lienSuivi(b.dataset.partager);
      if (navigator.share) await navigator.share({ title: 'Suivi de ma livraison', url: lien }).catch(() => {});
      else { await navigator.clipboard.writeText(lien).catch(() => {}); toast('Lien de suivi copié'); }
      return;
    } else if (b.dataset.voirCarte) {
      const c = derniereListe.find((x) => x.id === Number(b.dataset.voirCarte));
      fermerTiroir();
      if (c) { $('bloc-carte').scrollIntoView({ behavior: 'smooth', block: 'start' }); recadrerSurVehicule(c); }
      return;
    } else if (b.dataset.payer) {
      reprendrePaiement(b.dataset.payer);
      return;
    } else if (b.dataset.retirer) {
      ecrireCodes(lireCodes().filter((c) => c !== b.dataset.retirer));
    } else return;
    chargerListe();
  } catch (err) { toast(err.message, true); }
});

// =========================================================================
// Moyens de paiement (Nangu : Wave / Orange Money, ou espèces)
// =========================================================================
let paiementsEnLigne = [];  // fournisseurs disponibles, lus sur /api/config
let reglagesFrais = { frais_achat_pct: 0, frais_achat_min: 0 }; // frais d'achat (« Acheter pour moi »), lus sur /api/config
let paiementTest = false;
/** Lit les moyens de paiement disponibles ; recommence si le réseau a échoué. */
let configChargee = null;
function chargerConfig() {
  if (!configChargee) {
    configChargee = api('GET', '/api/config').then((cfg) => {
      paiementsEnLigne = cfg.paiement_en_ligne || [];
      paiementTest = !!cfg.paiement_test;
      reglagesFrais = { frais_achat_pct: cfg.frais_achat_pct || 0, frais_achat_min: cfg.frais_achat_min || 0 };
    }).catch(() => { configChargee = null; });
  }
  return configChargee;
}
const CLE_PAIEMENT = 'tt_paiement';
const MOYENS = {
  wave: { nom: 'Wave', logo: 'W', classe: 'wave', aide: 'Vous payez dès qu\'un livreur accepte' },
  orange_money: { nom: 'Orange Money', logo: 'OM', classe: 'orange', aide: 'Vous payez dès qu\'un livreur accepte' },
  especes: { nom: 'Espèces', logo: ico('banknote'), classe: 'especes', aide: 'Au livreur, à la livraison' },
};

function moyenChoisi() {
  return ($('choix-paiement') && $('choix-paiement').value) || 'especes';
}

function htmlChoixPaiement() {
  const dispo = [...paiementsEnLigne, 'especes'];
  const prefere = Stock.get(CLE_PAIEMENT);
  const choisi = dispo.includes(prefere) ? prefere : dispo[0];
  return `
    <div class="titre-section">Comment payer ?</div>
    <div class="choix-paiement" role="radiogroup" aria-label="Moyen de paiement">
      ${dispo.map((m) => `
        <label><input type="radio" name="paiement" value="${m}" ${m === choisi ? 'checked' : ''}>
          <span class="option"><span class="logo-moyen ${MOYENS[m].classe}">${MOYENS[m].logo}</span>
            <span><b>${MOYENS[m].nom}</b><small>${MOYENS[m].aide}</small></span></span></label>`).join('')}
    </div>
    ${paiementTest && paiementsEnLigne.length ? '<div class="bandeau-test">Mode test : aucun argent réel n\'est débité.</div>' : ''}`;
}

function majBoutonConfirmation() {
  const m = moyenChoisi();
  const prix = fcfa(prixCourse());
  // paiement en ligne : rien n'est débité maintenant, le client paie quand un livreur a accepté
  $('conf-envoyer').innerHTML = m === 'especes' ? `Confirmer · ${prix}` : `Commander · ${prix}`;
}

// ---------- Écran de paiement ----------
let suiviPaiement = null; // { code, minuterie }
const estAndroid = /Android/i.test(navigator.userAgent);
const estMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function arreterSuiviPaiement() {
  if (suiviPaiement) clearInterval(suiviPaiement.minuterie);
  suiviPaiement = null;
}

/** Affiche comment payer (Wave ou Orange Money) et attend la confirmation automatique. */
function afficherEcranPaiement(code, infos, prix) {
  const wave = infos.fournisseur !== 'orange_money';
  const montant = fcfa(infos.montant_du || prix);
  // Recommandation de Nangu : toujours passer par sa page de paiement (checkout_url), jamais par le lien Wave direct.
  // C'est elle qui ouvre Wave, surveille le paiement, envoie l'alerte « Paiement reçu » (Android)
  // et ramène le client ici par le return_url. Le lien direct ne sert qu'en secours si la page manque.
  const lien = wave ? (estAndroid && infos.android_intent_url) || infos.pay_url : infos.maxit_url;
  const pageNangu = infos.checkout_url;
  const retourAuto = pageNangu ? `<p class="consigne-retour">${ico('info', 'ic-sm')} Après le paiement, vous serez ramené ici automatiquement.</p>` : '';
  const blocAlerte = '';
  let corps;
  if (wave) {
    corps = pageNangu
      ? `<a class="btn btn-payer wave" href="${esc(pageNangu)}">${ico('wallet')} Payer avec Wave</a>${retourAuto}`
      : (lien ? `<a class="btn btn-payer wave" href="${esc(lien)}">${ico('wallet')} Payer avec Wave</a>` : '');
    corps += infos.qr_code_url && !estMobile ? `<p class="meta">Ou scannez ce code avec l'appli Wave de votre téléphone :</p><div class="qr"><img src="${esc(infos.qr_code_url)}" alt="QR code de paiement Wave"></div>` : '';
  } else {
    corps = `
      ${pageNangu ? `<a class="btn btn-payer orange" href="${esc(pageNangu)}">${ico('wallet')} Payer avec Orange Money</a>${retourAuto}`
        : lien ? `<a class="btn btn-payer orange" href="${esc(lien)}">${ico('wallet')} Ouvrir Max it</a>
        <p class="meta">Dans Max it, tapez exactement <b>${montant}</b>.</p>` : ''}
      <ol class="etapes-om">
        <li>Composez <b>${esc(infos.ussd_code || '#144#')}</b>${estMobile ? ` (<a href="tel:${encodeURIComponent(infos.ussd_code || '#144#')}">appeler</a>)` : ''}</li>
        <li>Choisissez <b>Paiement marchand</b></li>
        ${infos.merchant_code ? `<li>Code marchand : <b>${esc(infos.merchant_code)}</b></li>` : ''}
        <li>Montant exact : <b>${montant}</b></li>
      </ol>
      ${infos.qr_code_url && !estMobile ? `<div class="qr"><img src="${esc(infos.qr_code_url)}" alt="QR code de paiement Orange Money"></div>` : ''}`;
  }
  $('titre-conf').textContent = `Payer avec ${wave ? 'Wave' : 'Orange Money'}`;
  $('conf-contenu').innerHTML = `
    <div class="ecran-paiement" id="ecran-paiement">
      ${infos.test ? '<div class="bandeau-test">Mode test : aucun argent réel n\'est débité.</div>' : ''}
      <p class="meta" style="margin:0">Montant exact à payer</p>
      <div class="montant">${montant}</div>
      ${infos.montant_du && infos.montant_du !== prix ? `<p class="meta">Payez bien ${montant} (et non ${fcfa(prix)}) : ces quelques francs permettent de reconnaître votre paiement.</p>` : ''}
      ${blocAlerte}
      ${corps}
      <div class="attente-paiement" id="etat-paiement">${ico('loader-circle', 'tourne')} En attente de votre paiement…</div>
      <p class="meta">La confirmation est automatique. Les livreurs sont prévenus dès le paiement reçu.</p>
    </div>`;
  $('conf-envoyer').hidden = true;
  const bas = $('confirmation').querySelector('.conf-pied [data-fermer-conf]');
  bas.textContent = 'Fermer (je paierai depuis Mes livraisons)';
  $('confirmation').hidden = false;
  document.body.classList.add('sans-defilement');

  arreterSuiviPaiement();
  suiviPaiement = { code, minuterie: setInterval(() => verifierPaiement(code), 4000) };
  verifierPaiement(code);
}

const texteAlerteActive = () => `<p class="alerte-paiement ok">${ico('bell', 'ic-sm')} Une alerte s'affichera sur votre téléphone dès le paiement reçu, même dans l'appli Wave : touchez-la pour revenir ici.</p>`;
/** Le client vient d'accepter les alertes : on le lui confirme sur l'écran de paiement. */
function afficherAlerteActive() {
  const bloc = $('bloc-alerte-paiement');
  if (bloc) bloc.innerHTML = texteAlerteActive();
}

// Retour dans le navigateur après Wave / Max it : on vérifie tout de suite, sans attendre le prochain tour
// (les téléphones ralentissent les minuteries des pages restées en arrière-plan).
const verifierAuRetour = () => {
  if (document.visibilityState === 'visible' && suiviPaiement) verifierPaiement(suiviPaiement.code);
};
document.addEventListener('visibilitychange', verifierAuRetour);
window.addEventListener('focus', verifierAuRetour);
window.addEventListener('pageshow', verifierAuRetour);

async function verifierPaiement(code) {
  if (!suiviPaiement || suiviPaiement.code !== code) return;
  let p;
  try { p = await api('GET', `/api/courses/suivi/${encodeURIComponent(code)}/paiement`); } catch { return; }
  const etat = $('etat-paiement');
  if (!etat) return arreterSuiviPaiement();
  if (p.paiement_statut === 'paye') {
    arreterSuiviPaiement();
    const suite = p.statut === 'acceptee' ? 'Le livreur vient chercher votre colis.' : 'Nous cherchons un livreur.';
    etat.innerHTML = `<span class="paiement-ok">${ico('circle-check')} Paiement reçu. ${suite}</span>`;
    toast(`Paiement reçu. ${suite}`);
    setTimeout(() => { fermerConfirmation(); chargerListe().then(ouvrirTiroir); }, 1800);
  } else if (p.paiement_statut === 'expire' || p.paiement_statut === 'annule') {
    arreterSuiviPaiement();
    etat.innerHTML = `${ico('triangle-alert')} ${p.paiement_statut === 'expire' ? 'Délai de paiement dépassé : commande annulée.' : 'Paiement annulé.'}`;
    chargerListe();
  }
}

/**
 * Le client revient de la page de paiement : on demande au serveur l'état réel du paiement
 * (le serveur le relit chez Nangu), pendant au plus une minute.
 */
async function confirmerRetourPaiement(code) {
  toast('Vérification de votre paiement…');
  for (let essai = 0; essai < 15; essai++) {
    let p = null;
    try { p = await api('GET', `/api/courses/suivi/${encodeURIComponent(code)}/paiement`); } catch { /* nouvel essai */ }
    if (p && p.paiement_statut === 'paye') {
      toast(p.statut === 'acceptee' ? 'Paiement reçu. Le livreur vient chercher votre colis.' : 'Paiement reçu. Les livreurs disponibles sont prévenus.');
      return chargerListe();
    }
    if (p && (p.paiement_statut === 'expire' || p.paiement_statut === 'annule')) {
      toast(p.paiement_statut === 'expire' ? 'Délai de paiement dépassé : la commande est annulée.' : 'Paiement annulé.', true);
      return chargerListe();
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  toast('Paiement pas encore confirmé. Vous serez prévenu ici dès sa réception.', true);
  chargerListe();
}

/** Depuis « Mes livraisons » : reprendre le paiement d'une course en attente. */
async function reprendrePaiement(code) {
  try {
    const p = await api('GET', `/api/courses/suivi/${encodeURIComponent(code)}/paiement`);
    if (p.paiement_statut === 'en_attente' && !p.infos) {
      chargerListe().then(ouvrirTiroir);
      return toast('Rien à payer pour l\'instant : vous paierez dès qu\'un livreur aura accepté.');
    }
    if (p.paiement_statut !== 'en_attente' || !p.infos) { chargerListe(); return toast('Ce paiement n\'est plus en attente.'); }
    // Pas d'écran en double : on va directement sur la page de paiement Nangu (un seul bouton « Payer avec Wave »).
    // Elle ramène le client ici tout seul après le paiement (return_url).
    if (p.infos.checkout_url) {
      toast(`Ouverture du paiement ${p.infos.fournisseur === 'orange_money' ? 'Orange Money' : 'Wave'}…`);
      setTimeout(() => { location.href = p.infos.checkout_url; }, 1200);
      return;
    }
    fermerTiroir();
    afficherEcranPaiement(code, p.infos, p.montant_du); // secours : pas de page Nangu
  } catch (e) { toast(e.message, true); }
}

// =========================================================================
// Commander : un seul bouton
// =========================================================================
form.onsubmit = async (e) => {
  e.preventDefault();
  if (!dernierDevis || !points.depart || !points.arrivee) return toast('Indiquez le départ et l\'arrivée.');
  if (!estTrajet() && !form.description.value.trim()) {
    form.description.classList.add('erreur');
    form.description.focus();
    return toast(form.type.value === 'achat' ? 'Écrivez ce qu\'il faut acheter.' : 'Touchez ce qu\'il faut livrer, ou écrivez-le.', true);
  }
  if (!telValide()) {
    coordEnEdition = true;
    afficherCoordonnees();
    form.client_tel.classList.add('erreur');
    form.client_tel.focus();
    return toast(form.client_tel.value.trim() ? 'Numéro incorrect. Exemple : 77 123 45 67' : 'Écrivez votre numéro de téléphone.', true);
  }
  if (form.client_nom.value.trim().length < 2) {
    coordEnEdition = true;
    afficherCoordonnees();
    form.client_nom.classList.add('erreur');
    form.client_nom.focus();
    return toast('Écrivez votre nom.', true);
  }
  await envoyerCommande();
};

async function envoyerCommande() {
  ['depart', 'arrivee'].forEach((t) => {
    if (!form[t + '_repere'].value.trim()) form[t + '_repere'].value = 'Point placé sur la carte';
  });
  const d = Object.fromEntries(new FormData(form));
  d.paiement = moyenChoisi();
  Stock.set(CLE_PAIEMENT, d.paiement);
  const bouton = $('btn-commander');
  bouton.disabled = true;
  bouton.innerHTML = `${ico('loader-circle', 'tourne')} Envoi…`;
  try {
    const course = await api('POST', '/api/courses', { ...d, depart: coord(points.depart), arrivee: coord(points.arrivee) });
    ajouterCode(course.suivi_token);
    Stock.set(CLE_COORD, JSON.stringify({ nom: d.client_nom, tel: d.client_tel }));
    memoriserAdresse(coord(points.arrivee), d.arrivee_repere);
    memoriserAdresse(coord(points.depart), d.depart_repere);
    if ('Notification' in window && Notification.permission === 'granted') activerNotifications().catch(() => {});

    // remise à zéro de l'arrivée (le départ, souvent le même, est gardé ; nom et téléphone aussi)
    ['arrivee_repere', 'montant_achat', 'description', 'destinataire_nom', 'destinataire_tel']
      .forEach((n) => { form[n].value = ''; delete form[n].dataset.auto; delete form[n].dataset.ancre; });
    form.type.value = 'colis';
    $('bloc-destinataire').open = false;
    if (points.arrivee) { points.arrivee.remove(); points.arrivee = null; }
    imprecis.arrivee = null;
    arreterAttente();
    coordEnEdition = false;
    choisirMode('arrivee');
    afficherChoixRapides();
    majDevis();

    toast(course.service === 'trajet'
      ? `Demande envoyée. Les chauffeurs ${course.vehicule === 'confort' ? 'Confort' : course.vehicule === 'voiture' ? 'Éco' : 'à moto'} autour de vous sont prévenus.${course.paiement !== 'especes' ? ` Vous paierez avec ${MOYENS[course.paiement].nom} dès qu'un chauffeur accepte.` : ''}`
      : course.paiement !== 'especes'
        ? `Commande envoyée. Dès qu'un livreur accepte, vous paierez avec ${MOYENS[course.paiement].nom}.`
        : 'Commande envoyée. Les livreurs disponibles sont prévenus.');
    await chargerListe();
    ouvrirTiroir();
  } catch (err) {
    toast(err.message, true);
  } finally {
    bouton.disabled = false;
    majCommander();
  }
}

// =========================================================================
// Départ, arrivée et carte
// =========================================================================
/** Après avoir placé le départ, le prochain toucher sur la carte place l'arrivée. */
function apresPoint(type) {
  if (type === 'depart') choisirMode('arrivee');
}

/** Départ = ma position (au démarrage, sans rien demander si possible ; ou au toucher du bouton). */
async function utiliserMaPosition(silencieux = false) {
  try {
    const p = await positionGPS();
    const champ = form.depart_repere;
    champ.value = '';
    delete champ.dataset.auto;
    delete champ.dataset.ancre;
    placerAvecRepere('depart', p.coords.latitude, p.coords.longitude, null);
    parGPS.depart = true;
    await proposerRepere('depart', 'Ma position'); // le nom du lieu est prêt pour l'accueil
    apresPoint('depart');
    if (p.coords.accuracy > 150 && !silencieux) {
      toast(`Position approximative (±${Math.round(p.coords.accuracy)} m). Faites glisser le point A sur l'endroit exact.`, true);
    }
  } catch (err) {
    if (!silencieux) toast(err.message, true);
  }
}
$('btn-ma-position').onclick = async () => {
  const b = $('btn-ma-position');
  b.disabled = true;
  b.innerHTML = ico('loader-circle', 'tourne');
  try { await utiliserMaPosition(false); } finally {
    b.disabled = false;
    b.innerHTML = ico('locate-fixed');
  }
};

// Adresses déjà utilisées : un toucher les place (au départ s'il manque, sinon à l'arrivée)
$('recents-liste').onclick = (e) => {
  const b = e.target.closest('button[data-i]');
  const x = b && lireAdresses()[Number(b.dataset.i)];
  if (!x) return;
  const type = points.depart ? 'arrivee' : 'depart';
  form[type + '_repere'].dataset.ancre = JSON.stringify({ nom: x.repere, lat: x.lat, lng: x.lng }); // le nom choisi reste
  placerAvecRepere(type, x.lat, x.lng, x.repere, true);
  apresPoint(type);
};

/** Écran de recherche : le panneau monte presque en plein écran, avec les adresses récentes en liste. */
function ouvrirRecherche(oui) {
  if (!estTelephone()) return;
  if (oui && !document.body.classList.contains('feuille-recherche')) empiler('recherche');
  document.body.classList.toggle('feuille-recherche', oui);
  document.body.classList.remove('feuille-reduite');
  $('recents').hidden = !lireAdresses().length || (!oui && !$('fiche').hidden);
  setTimeout(majHauteurFeuille, 300);
}

// =========================================================================
// Accueil : les services, « Où allons-nous ? », les adresses récentes
// =========================================================================
/** Ferme l'écran de recherche (et range le clavier). */
function fermerRecherche() {
  document.body.classList.remove('feuille-recherche');
  if (document.activeElement && document.activeElement.closest('.lieux')) document.activeElement.blur();
  if (!lireAdresses().length || !$('fiche').hidden) $('recents').hidden = true;
  setTimeout(majHauteurFeuille, 300);
}

// =========================================================================
// Bouton « retour » du téléphone : chaque écran est déclaré au navigateur ; « retour » ferme d'abord
// ce qui est ouvert (Mes courses, recherche, destination) puis revient à l'accueil, au lieu de quitter le site.
// =========================================================================
function empiler(ecran) { try { history.pushState({ ecran }, ''); } catch { /* navigation privée */ } }
window.addEventListener('popstate', () => {
  if (!$('confirmation').hidden) { fermerConfirmation(); return; }
  if (!$('tiroir').hidden) { fermerTiroir(); return; }
  if (document.body.classList.contains('feuille-recherche')) { fermerRecherche(); return; }
  if ($('accueil').hidden && points.arrivee && !courseSuivie) {
    $('retour-carte').click(); // enlève la destination, on reste sur la commande
    empiler('commande');
    return;
  }
  if ($('accueil').hidden) ouvrirAccueil();
});

function ouvrirAccueil() {
  $('accueil').hidden = false;
  document.body.classList.add('sur-accueil');
  majAccueil();
}
function fermerAccueil() {
  if (!$('accueil').hidden) empiler('commande');
  $('accueil').hidden = true;
  document.body.classList.remove('sur-accueil');
  setTimeout(() => { if (carte) carte.invalidateSize(); majHauteurFeuille(); }, 60);
}
let jetonAccueil = 0;
async function majAccueil() {
  if ($('accueil').hidden) return;
  // « Ma position · près de l'École » → « Près de l'École »
  const ici = form.depart_repere.value.replace(/^Ma position · /, '');
  $('accueil-position-texte').textContent = ici ? ici.charAt(0).toUpperCase() + ici.slice(1) : 'Votre position';
  // adresses récentes, avec une icône comme sur l'écran de recherche
  $('accueil-recents').innerHTML = lireAdresses().slice(0, 3).map((x, i) => {
    const [nom, ...reste] = x.repere.split(/ · |, /);
    return `<button type="button" class="recent" data-recent="${i}" title="${esc(x.repere)}">
      <span class="recent-ic">${ico('history')}</span>
      <span class="recent-texte"><b>${esc(nom)}</b>${reste.length ? `<small>${esc(reste.join(', '))}</small>` : ''}</span>
    </button>`;
  }).join('');
  // « Courses · dès de 3 min » : le chauffeur libre le plus proche
  if (!points.depart) return;
  const jeton = ++jetonAccueil;
  try {
    const p = coord(points.depart);
    const ch = await api('GET', `/api/courses/chauffeurs-proches?lat=${p.lat}&lng=${p.lng}`);
    if (jeton !== jetonAccueil) return;
    const m = ['moto', 'voiture', 'confort'].map((v) => ch[v] && ch[v].minutes).filter((x) => x != null && x <= MAX_MIN_AFFICHE);
    $('tuile-courses-temps').textContent = m.length ? `· dès ${Math.min(...m)} min` : '';
  } catch { /* pas grave : texte par défaut */ }
}
/** Courses ou Livraison : on passe à l'écran de commande, réglé sur trajet ou colis. */
function choisirService(service, chercher = true) {
  if (service === 'livraison' || service === 'achats') {
    choix = 'colis';
    form.type.value = service === 'achats' ? 'achat' : 'colis';
    form.description.value = '';
    afficherChoixRapides();
  } else if (service === 'moto') {
    choix = 'moto';
    Stock.set('tt_choix_trajet', 'moto');
  } else if (choix === 'colis') choix = Stock.get('tt_choix_trajet') || 'moto';
  Stock.set(CLE_CHOIX, choix);
  fermerAccueil();
  majFiche();
  if (chercher && !points.arrivee) {
    // écran de recherche ouvert tout de suite (le focus donné par programme ne déclenche pas toujours l'événement)
    choisirMode('arrivee');
    ouvrirRecherche(true);
    setTimeout(() => form.arrivee_repere.focus(), 250);
  }
}
$('accueil').addEventListener('click', (e) => {
  const t = e.target.closest('[data-service]');
  if (t) {
    if (t.dataset.service === 'food') { toast('Food arrive bientôt à Yène.'); return; }
    choisirService(t.dataset.service);
    return;
  }
  if (e.target.closest('#accueil-recherche')) { choisirService('courses'); return; }
  if (e.target.closest('#accueil-position')) { fermerAccueil(); choisirMode('depart'); setTimeout(() => form.depart_repere.focus(), 250); return; }
  if (e.target.closest('#accueil-mes-courses')) { ouvrirTiroir(); chargerListe(); return; }
  const r = e.target.closest('[data-recent]');
  if (r) {
    const x = lireAdresses()[Number(r.dataset.recent)];
    if (!x) return;
    choisirService('courses', false);
    const type = points.depart ? 'arrivee' : 'depart';
    form[type + '_repere'].dataset.ancre = JSON.stringify({ nom: x.repere, lat: x.lat, lng: x.lng });
    placerAvecRepere(type, x.lat, x.lng, x.repere, true);
    apresPoint(type);
  }
});
// le logo ramène à l'accueil (sans recharger la page)
document.querySelector('.entete .marque').addEventListener('click', (e) => { e.preventDefault(); ouvrirAccueil(); });

function initCarte() {
  const outilsCarte = creerCarte('map');
  carte = outilsCarte.carte;
  // Toucher la carte : sur un nom de lieu, on choisit ce lieu (comme Google Maps) ; ailleurs, on pose le point
  carte.on('click', (e) => {
    const type = points.depart ? mode : 'depart';
    const lieu = outilsCarte.lieuSousLeDoigt(e.latlng);
    if (!lieu) { placer(type, e.latlng); apresPoint(type); return; }
    form[type + '_repere'].dataset.ancre = JSON.stringify({ nom: lieu.nom, lat: lieu.lat, lng: lieu.lng });
    placerAvecRepere(type, lieu.lat, lieu.lng, lieu.nom, true);
    apresPoint(type);
  });

  // Suggestions directement dans les champs : choisir un lieu place le point
  ['depart', 'arrivee'].forEach((type) => {
    const champ = form[type + '_repere'];
    champ.addEventListener('focus', () => { choisirMode(type); ouvrirRecherche(true); });
    champ.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement || !document.activeElement.closest('.lieux')) ouvrirRecherche(false); }, 250));
    brancherRecherche(champ, $('sugg-' + type), (lieu) => {
      choisirMode(type);
      if (lieu.colle) {
        champ.value = '';
        placerAvecRepere(type, lieu.lat, lieu.lng, null);
        apresPoint(type);
        return;
      }
      const texte = nomAvecVillage(lieu);
      champ.dataset.ancre = JSON.stringify({ nom: texte, lat: lieu.lat, lng: lieu.lng });
      placerAvecRepere(type, lieu.lat, lieu.lng, texte, true);
      // un village ou un quartier entier : le chauffeur ne saura pas où aller exactement
      if (['village', 'quartier'].includes(lieu.categorie)) {
        imprecis[type] = lieu.nom;
        imprecis[type + 'Cat'] = lieu.categorie;
        majPrecision();
      }
      champ.blur(); // fermer le clavier pour voir le trajet et la fiche
      apresPoint(type);
    }, { discret: true });
  });

  brancherPleinEcran($('plein-ecran'), $('bloc-carte'), carte);
  $('me-localiser').onclick = () => boutonChargement($('me-localiser'), async () => {
    try {
      const p = await positionGPS();
      carte.flyTo([p.coords.latitude, p.coords.longitude], 17, { duration: 0.6 });
    } catch (err) { toast(err.message, true); }
  });
}

initCarte();
chargerConfig().then(() => { majPaiement(); if (!$('fiche').hidden) majCommander(); });
afficherCoordonnees();
afficherChoixRapides();
afficherAdresses();
choisirMode('depart');
majDevis();
// le départ est pris automatiquement à la position du téléphone (sauf si l'on vient suivre une course)
if (!suiviPartage) utiliserMaPosition(true).then(majAccueil);
if (!suiviPartage) ouvrirAccueil();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('confirmation').hidden) fermerConfirmation(); });
brancherBoutonNotif($('btn-notif'));
proposerNotifications();
// nouvelle version en ligne : rechargement seulement si le client n'est pas en train de commander ou de payer
surveillerMiseAJour(() => $('confirmation').hidden && !suiviPaiement && !points.arrivee && !attente);

/**
 * Comme une application de téléphone : à l'ouverture, on propose une fois d'activer les notifications.
 * Le téléphone n'affiche sa question qu'après un toucher (règle des navigateurs), d'où le bouton « Activer ».
 * « Plus tard » : on ne redemande pas avant 7 jours (la question revient aussi au moment de payer).
 */
function proposerNotifications() {
  const CLE_PLUS_TARD = 'tt_alertes_plus_tard';
  const possible = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const repousse = Number(Stock.get(CLE_PLUS_TARD) || 0) > Date.now() - 7 * 24 * 3600 * 1000;
  if (!possible || Notification.permission !== 'default' || repousse) return;
  const bandeau = $('bandeau-alertes');
  bandeau.hidden = false;
  $('alertes-plus-tard').onclick = () => { Stock.set(CLE_PLUS_TARD, String(Date.now())); bandeau.hidden = true; };
  $('alertes-activer').onclick = () => boutonChargement($('alertes-activer'), async () => {
    try {
      await activerNotifications(); // question du téléphone, puis abonnement de ce téléphone à ses livraisons
      bandeau.hidden = true;
      toast('Notifications activées. Vous serez prévenu à chaque étape de vos livraisons.');
      brancherBoutonNotif($('btn-notif'));
    } catch (e) {
      bandeau.hidden = true;
      if (Notification.permission === 'denied') toast('Notifications refusées. Vous pourrez les activer plus tard dans les réglages du site.', true);
      else toast(e.message, true);
    }
  });
}
chargerListe().then(() => {
  if (ouvrirPaiement) return reprendrePaiement(suiviPartage);
  if (suiviPartage) ouvrirTiroir();
  if (retourPaiement) confirmerRetourPaiement(suiviPartage);
});

socket = io({ auth: { suivi: lireCodes() } });
socket.on('livreur:position', positionVehicule);
socket.on('position:recue', positionRecue);
socket.on('connect', () => { if (attente) socket.emit('attendre-position', attente.code); });
socket.on('course:maj', (c) => {
  if (c.statut === 'acceptee' && c.arrive_le && Date.now() - new Date(c.arrive_le).getTime() < 60000) {
    toast(c.service === 'trajet' ? 'Votre chauffeur est arrivé !' : 'Le livreur est arrivé au point de départ.');
    chargerListe();
    return;
  }
  const trajet = c.service === 'trajet';
  const messages = {
    acceptee: trajet ? `${c.livreur_nom} a accepté votre course et arrive vous chercher` : `${c.livreur_nom} a accepté votre livraison`,
    recuperee: trajet ? 'Bonne route ! Votre course a commencé.' : 'Votre colis a été récupéré, il est en route',
    livree: trajet ? 'Vous êtes arrivé. Merci !' : 'Livraison terminée',
    en_attente: trajet ? 'Le chauffeur s\'est désisté, recherche d\'un autre chauffeur…' : 'Le livreur s\'est désisté, recherche d\'un autre livreur…',
    annulee: c.rembourse_le
      ? `Nous sommes désolés : votre ${trajet ? 'course' : 'livraison'} est annulée. ${fcfa(c.rembourse_montant)} vous ont été remboursés.`
      : `Nous sommes désolés : aucun${trajet ? 'e voiture n\'est disponible' : ' livreur n\'est disponible'}, votre ${trajet ? 'course' : 'livraison'} est annulée.${c.paiement_statut === 'paye' ? ' Vous serez remboursé.' : ''}`,
  };
  // paiement tout juste confirmé : ce n'est pas un désistement
  const vientDEtrePaye = c.paye_le && Date.now() - new Date(c.paye_le).getTime() < 60000 && c.paiement_statut === 'paye';
  // un livreur vient d'accepter une course à payer en ligne : on ouvre tout de suite l'écran de paiement
  const aPayer = c.statut === 'acceptee' && c.paiement !== 'especes' && c.paiement_statut === 'en_attente';
  if (aPayer) {
    toast(`${c.livreur_nom || 'Un livreur'} a accepté ! Payez maintenant pour qu'il vienne chercher le colis.`);
    chargerListe().then(() => {
      const code = codeDeCourse(c.id);
      if (code && !suiviPaiement) reprendrePaiement(code);
    });
    return;
  }
  if (vientDEtrePaye) { if (!suiviPaiement) toast(c.statut === 'acceptee' ? 'Paiement reçu. Le livreur vient chercher le colis.' : 'Paiement reçu. Nous cherchons un livreur.'); }
  else if (messages[c.statut]) toast(messages[c.statut]);
  chargerListe();
});

