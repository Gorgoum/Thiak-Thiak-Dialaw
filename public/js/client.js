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
let etape = 1; // assistant : 1 départ · 2 arrivée · 3 quoi · 4 vous
let dernierDevis = null;
const points = { depart: null, arrivee: null };
const attentes = {}; // demandes de position en cours, par type : { code, minuterie }

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
if (suiviPartage) {
  ajouterCode(suiviPartage);
  history.replaceState(null, '', '/');
}

// Notifications du client : rattachées à chacune de ses courses
// eslint-disable-next-line no-global-assign
activerNotifications = async () => {
  const ab = await obtenirAbonnement();
  await Promise.all(lireCodes().map((c) => api('POST', `/api/courses/suivi/${encodeURIComponent(c)}/push`, { abonnement: ab }).catch(() => {})));
};

// =========================================================================
// Itinéraire : étapes A / B
// =========================================================================
function choisirMode(m) {
  mode = m;
  document.querySelectorAll('.etape-trajet').forEach((e) => e.classList.toggle('actif', e.dataset.type === m));
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
  el.className = 'etape-etat ' + classe;
  el.innerHTML = texte;
}

function placer(type, latlng) {
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
  majDevis(true); // les deux points placés : trajet tracé et zoom sur l'itinéraire
}

const DISTANCE_MIN_M = 30;
const memeEndroit = () => points.depart && points.arrivee
  && distanceM(coord(points.depart), coord(points.arrivee)) < DISTANCE_MIN_M;

/** A et B au même endroit : on écarte visuellement A et on explique (sinon A disparaît sous B). */
/** Coordonnées précises du point, affichées sous le repère (mises à jour en direct). */
function majCoord(type) {
  const el = $('coord-' + type);
  if (!points[type]) { el.hidden = true; return; }
  const { lat, lng } = points[type].getLatLng();
  el.hidden = false;
  el.innerHTML = `${ico('map-pin', 'ic-sm')} ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function retirerPoint(type) {
  arreterAttente(type);
  if (points[type]) { points[type].remove(); points[type] = null; }
  majCoord(type);
  majEtat(type, 'À placer sur la carte'); // le repère écrit est conservé
}

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
  $('recents').hidden = !liste.length || etape > 2;
  $('recents-liste').innerHTML = liste.map((x, i) => `
    <button type="button" class="chip" data-i="${i}" title="${esc(x.repere)}">${ico('map-pin', 'ic-sm')}${esc(x.repere.length > 30 ? x.repere.slice(0, 29) + '…' : x.repere)}</button>`).join('');
}
$('recents-liste').onclick = (e) => {
  const b = e.target.closest('button[data-i]');
  const x = b && lireAdresses()[Number(b.dataset.i)];
  if (x) { placerAvecRepere(mode, x.lat, x.lng, x.repere, true); avancer(mode); }
};

// =========================================================================
// Demander la position (WhatsApp / SMS)
// =========================================================================
function arreterAttente(type) {
  const a = attentes[type];
  if (a) clearInterval(a.minuterie);
  delete attentes[type];
  $('attente-' + type).hidden = true;
  if (!points[type]) majEtat(type, 'À placer sur la carte');
}

function positionRecue(d) {
  const type = Object.keys(attentes).find((t) => attentes[t].code === d.code);
  if (!type || d.lat == null) return;
  arreterAttente(type);
  placerAvecRepere(type, d.lat, d.lng, null);
  if (!memeEndroit()) majEtat(type, `${ico('check', 'ic-sm')} Position reçue${d.precision_m ? ` · ±${d.precision_m} m` : ''}`, 'place');
  toast(`Position ${type === 'depart' ? 'du départ' : 'du destinataire'} reçue.`);
  avancer(type);
}

async function demanderPosition(type) {
  const nom = form.client_nom.value.trim();
  let code;
  try {
    ({ code } = await api('POST', '/api/positions', { demandeur: nom || null }));
  } catch (e) { return toast(e.message, true); }
  arreterAttente(type);
  choisirMode(type);

  const lien = `${location.origin}/position.html?d=${encodeURIComponent(code)}`;
  const message = `${nom || 'Quelqu\'un'} vous envoie une livraison Thiak Thiak Dialaw. `
    + `Ouvrez ce lien et touchez « Envoyer ma position » pour que le livreur trouve l'endroit : ${lien}`;
  const tel = type === 'arrivee' ? form.destinataire_tel.value.replace(/\D/g, '').slice(-9) : '';
  const telOk = /^7\d{8}$/.test(tel);
  const texte = encodeURIComponent(message);

  attentes[type] = { code, minuterie: null };
  socket.emit('attendre-position', code);
  attentes[type].minuterie = setInterval(async () => {
    try { positionRecue(await api('GET', '/api/positions/' + encodeURIComponent(code))); } catch { /* nouvel essai */ }
  }, 5000);

  majEtat(type, `${ico('loader-circle', 'ic-sm tourne')} En attente…`, 'attente');
  const zone = $('attente-' + type);
  zone.hidden = false;
  zone.innerHTML = `
    <div class="titre">${ico('send', 'ic-sm')} Envoyez ce lien ${type === 'arrivee' ? 'au destinataire' : 'à la personne au départ'}</div>
    <p>Dès qu'elle touche « Envoyer ma position », le point ${LETTRE[type]} se place tout seul.</p>
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
  zone.querySelector('[data-annuler-attente]').onclick = () => arreterAttente(type);
}

// =========================================================================
// Prix et barre de commande
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
function recadrerItineraire(pts) {
  const zone = L.latLngBounds(pts).extend(points.depart.getLatLng()).extend(points.arrivee.getLatLng());
  const large = window.matchMedia('(min-width: 960px)').matches;
  const h = carte.getSize().y;
  // marges pour la recherche (haut) et la bulle d'aide (bas), proportionnées à la hauteur de la carte
  carte.flyToBounds(zone, {
    paddingTopLeft: [30, Math.min(large ? 130 : 80, h * 0.22)],
    paddingBottomRight: [large ? 40 : 60, Math.min(large ? 70 : 100, h * 0.22)],
    maxZoom: 17,
    duration: 0.8,
  });
}

function prixVide(texte) {
  dernierDevis = null;
  erreurDevis = null;
  effacerTrace();
  $('resume-prix').textContent = '— FCFA';
  $('resume-detail').textContent = texte;
  $('resume-detail').classList.remove('alerte');
  majBouton();
api('GET', '/api/config').then((cfg) => {
  paiementsEnLigne = cfg.paiement_en_ligne || [];
  paiementTest = !!cfg.paiement_test;
}).catch(() => {});
}

/** Recalcule prix, distance, durée et tracé. recadrer : zoomer sur l'itinéraire (après un placement). */
async function majDevis(recadrer = false) {
  const prix = $('resume-prix');
  const detail = $('resume-detail');
  if (!points.depart || !points.arrivee) {
    prixVide(!points.depart ? 'Placez le départ (A)' : 'Placez l\'arrivée (B)');
    return;
  }
  if (memeEndroit()) {
    prixVide('Départ et arrivée au même endroit');
    return;
  }
  const jeton = ++jetonDevis;
  prix.classList.add('charge');
  try {
    const d = await api('POST', '/api/courses/devis', { depart: coord(points.depart), arrivee: coord(points.arrivee) });
    if (jeton !== jetonDevis) return; // une réponse plus récente arrive
    dernierDevis = d;
    erreurDevis = null;
    detail.classList.remove('alerte');
    const achat = form.type.value === 'achat';
    prix.textContent = fcfa(d.prix);
    detail.textContent = `${d.distance_km.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`
      + `${d.minutes ? ` · ${d.minutes} min` : ''} · ${achat ? 'achats en plus · ' : ''}${paiementsEnLigne.length ? 'Wave, Orange Money ou espèces' : 'espèces à la livraison'}`;
    const pts = dessinerTrace(d);
    if (recadrer) recadrerItineraire(pts);
  } catch (e) {
    if (jeton !== jetonDevis) return;
    effacerTrace();
    dernierDevis = null;
    erreurDevis = e.message; // ex. hors zone
    prix.textContent = '— FCFA';
    detail.textContent = e.message;
    detail.classList.add('alerte');
  } finally {
    if (jeton === jetonDevis) { prix.classList.remove('charge'); majBouton(); }
  }
}

// =========================================================================
// Mes livraisons (tiroir)
// =========================================================================
function ouvrirTiroir() { $('tiroir').hidden = false; document.body.classList.add('sans-defilement'); }
function fermerTiroir() { $('tiroir').hidden = true; document.body.classList.remove('sans-defilement'); }
$('ouvrir-suivi').onclick = () => { ouvrirTiroir(); chargerListe(); };
$('tiroir').addEventListener('click', (e) => { if (e.target.closest('[data-fermer]')) fermerTiroir(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('tiroir').hidden) fermerTiroir(); });

function carteCourse(c) {
  const code = esc(c.suivi_token);
  const enCours = ['attente_paiement', 'en_attente', 'acceptee', 'recuperee'].includes(c.statut);
  const actions = [];
  if (c.statut === 'attente_paiement') actions.push(`<button class="btn-primaire" data-payer="${code}">${ico('wallet', 'ic-sm')} Payer ${fcfa(c.montant_du || c.prix)}</button>`);
  if (['en_attente', 'attente_paiement'].includes(c.statut)) actions.push(`<button class="danger" data-annuler="${code}">${ico('circle-x', 'ic-sm')} Annuler</button>`);
  if (enCours) actions.push(`<button data-partager="${code}">${ico('share-2', 'ic-sm')} Partager le suivi</button>`);
  if (!enCours) actions.push(`<button class="btn-ghost" data-retirer="${code}">${ico('trash-2', 'ic-sm')} Retirer</button>`);
  let notation = '';
  if (c.statut === 'livree') {
    notation = c.note
      ? `<div class="etoiles">Votre note <span style="color:#f5b301">${'★'.repeat(c.note)}${'☆'.repeat(5 - c.note)}</span></div>`
      : `<div class="etoiles">Notez le livreur ${[1, 2, 3, 4, 5].map((n) => `<button data-noter="${code}" data-note="${n}" aria-label="${n} étoile${n > 1 ? 's' : ''}">☆</button>`).join('')}</div>`;
  }
  const moyen = c.paiement === 'orange_money' ? 'Orange Money' : c.paiement === 'wave' ? 'Wave' : 'Espèces';
  let attente = '';
  if (c.statut === 'attente_paiement') attente = `<div class="ligne-info">${ico('wallet', 'ic-sm')} Paiement ${moyen} en attente : les livreurs seront prévenus dès réception.</div>`;
  else if (c.statut === 'en_attente') attente = `<div class="ligne-info">${ico('loader-circle', 'ic-sm tourne')} Recherche d'un livreur disponible…</div>`;
  if (c.paiement_statut === 'paye') attente += `<div class="ligne-info paiement-ok">${ico('circle-check', 'ic-sm')} Payé par ${moyen}</div>`;
  return `
    <article class="course">
      <div class="haut">${badge(c.statut)}<span class="prix-course">${fcfa(c.prix)}</span></div>
      ${frise(c.statut)}
      <div class="trajet">
        <div>${esc(c.depart_repere)}</div>
        <div>${esc(c.arrivee_repere)}</div>
      </div>
      <div class="ligne-info">${ico(c.type === 'achat' ? 'shopping-bag' : 'package', 'ic-sm')} ${esc(c.description)}</div>
      ${c.type === 'achat' && c.montant_achat ? `<div class="ligne-info">${ico('banknote', 'ic-sm')} Budget achats : ${fcfa(c.montant_achat)}</div>` : ''}
      ${attente}
      ${c.livreur_nom && ['acceptee', 'recuperee'].includes(c.statut) ? blocPersonne(c.livreur_nom, c.livreur_tel, 'Votre livreur') : ''}
      <div class="meta" style="margin-top:8px">${dateCourte(c.cree_le)} · ${Number(c.distance_km).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km</div>
      ${notation}
      ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
    </article>`;
}

async function chargerListe() {
  const codes = lireCodes();
  const bouton = $('ouvrir-suivi');
  if (!codes.length) { bouton.hidden = true; $('liste').innerHTML = '<p class="vide">Aucune livraison pour le moment.</p>'; return; }
  try {
    const liste = await api('GET', '/api/courses/suivi?codes=' + codes.map(encodeURIComponent).join(','));
    const connus = new Set(liste.map((c) => c.suivi_token));
    if (connus.size !== codes.length) ecrireCodes(codes.filter((c) => connus.has(c)));
    const actives = liste.filter((c) => ['attente_paiement', 'en_attente', 'acceptee', 'recuperee'].includes(c.statut)).length;
    bouton.hidden = !liste.length;
    $('nb-actives').hidden = !actives;
    $('nb-actives').textContent = actives;
    $('liste').innerHTML = liste.length ? liste.map(carteCourse).join('') : '<p class="vide">Aucune livraison pour le moment.</p>';
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
// Formulaire
// =========================================================================
try {
  const c = JSON.parse(Stock.get(CLE_COORD) || '{}');
  if (c.nom) form.client_nom.value = c.nom;
  if (c.tel) form.client_tel.value = c.tel;
} catch { /* rien */ }

form.addEventListener('change', (e) => {
  if (e.target.name === 'type') {
    $('l-montant').hidden = form.type.value !== 'achat';
    afficherChoixRapides();
    majDevis();
  }
});
form.addEventListener('input', (e) => {
  e.target.classList.remove('erreur');
  if (e.target.name === 'description') afficherChoixRapides();
  majBouton();
});

// Une étape (A/B) devient active quand on la touche
document.querySelectorAll('.etape-trajet').forEach((etape) => {
  etape.addEventListener('click', (e) => {
    if (e.target.closest('.attente-pos')) return;
    choisirMode(etape.dataset.type);
  });
  etape.querySelector('input').addEventListener('focus', () => choisirMode(etape.dataset.type));
});

document.querySelectorAll('[data-gps]').forEach((b) => {
  b.onclick = (e) => {
    e.stopPropagation();
    const type = b.dataset.gps;
    choisirMode(type);
    boutonChargement(b, async () => {
      try {
        const p = await positionGPS();
        placerAvecRepere(type, p.coords.latitude, p.coords.longitude, null);
        proposerRepere(type, 'Ma position');
        if (memeEndroit()) return; // l'alerte « même endroit » est déjà affichée
        if (type === 'arrivee') {
          // c'est le client lui-même qui reçoit : pas de destinataire séparé
          majEtat(type, `${ico('check', 'ic-sm')} Chez vous · ±${Math.round(p.coords.accuracy)} m`, 'place');
          if (!form.destinataire_nom.value && !form.destinataire_tel.value) $('bloc-destinataire').open = false;
          toast('Arrivée placée sur votre position : c\'est vous qui recevez la livraison.');
        } else {
          majEtat(type, `${ico('check', 'ic-sm')} Votre position · ±${Math.round(p.coords.accuracy)} m`, 'place');
        }
        if (p.coords.accuracy > 150) {
          toast(`Position approximative (±${Math.round(p.coords.accuracy)} m). Faites glisser le point ${LETTRE[type]} sur l'endroit exact.`, true);
        } else avancer(type);
      } catch (err) { toast(err.message, true); }
    });
  };
});
document.querySelectorAll('[data-demander]').forEach((b) => {
  b.onclick = (e) => { e.stopPropagation(); demanderPosition(b.dataset.demander); };
});
// « Toucher la carte » : on montre la carte et on explique quoi faire
document.querySelectorAll('[data-sur-carte]').forEach((b) => {
  b.onclick = (e) => {
    e.stopPropagation();
    choisirMode(b.dataset.surCarte);
    $('bloc-carte').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const cadre = $('bloc-carte').querySelector('.carte-cadre');
    cadre.classList.remove('signale'); void cadre.offsetWidth; cadre.classList.add('signale');
    toast(`Touchez la carte à l'endroit ${b.dataset.surCarte === 'depart' ? 'où le livreur prend le colis' : 'où il faut livrer'}.`);
  };
});

// =========================================================================
// Parcours guidé : le bouton du bas indique toujours la prochaine action
// =========================================================================
const telValide = () => /^7\d{8}$/.test(form.client_tel.value.replace(/\D/g, '').slice(-9));

/** Amène l'utilisateur au champ à compléter et le met en évidence. */
function allerA(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.focus({ preventScroll: true }), 350);
  el.classList.add('erreur');
}

// =========================================================================
// Assistant : une question par écran, un seul gros bouton en bas
// =========================================================================
const grandEcran = () => window.matchMedia('(min-width: 960px)').matches;

function allerEtape(n) {
  etape = n;
  document.querySelectorAll('.ecran').forEach((e) => { e.hidden = Number(e.dataset.etape) !== n; });
  document.body.dataset.etape = n;
  document.querySelectorAll('#progression li').forEach((li) => {
    const i = Number(li.dataset.aller);
    li.classList.toggle('actif', i === n);
    li.classList.toggle('fait', i < n);
  });
  $('btn-retour').hidden = n === 1;
  afficherAdresses();
  if (n <= 2) choisirMode(n === 1 ? 'depart' : 'arrivee');
  if (n === 4) afficherCoordonnees();
  majBouton();
  // haut de l'écran : on voit la carte et la question
  if (grandEcran()) document.querySelector('.volet-form').scrollTo({ top: 0, behavior: 'smooth' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
  // la carte change de taille selon l'étape : on la redimensionne, puis on recadre le trajet
  setTimeout(() => {
    carte.invalidateSize();
    if (ptsTrace) recadrerItineraire(ptsTrace);
    else if (points[mode]) carte.panTo(points[mode].getLatLng());
  }, 320);
}

/** Après un choix sûr (position, recherche, adresse récente) : on passe tout seul à la question suivante. */
let minuterieAvance = null;
function avancer(type) {
  clearTimeout(minuterieAvance);
  if (type !== 'depart' || etape !== 1) return;
  minuterieAvance = setTimeout(() => {
    if (etape === 1 && points.depart && !memeEndroit()) {
      toast('Départ choisi. Maintenant : où faut-il livrer ?');
      allerEtape(2);
    }
  }, 900);
}

/** Ce qui manque à l'étape n, ou null si elle est complète. */
function manque(n) {
  if (n === 1 && !points.depart) {
    return { label: 'Choisissez le départ', faire: () => toast('Touchez « Je suis ici », touchez la carte ou écrivez le nom du lieu.') };
  }
  if (n === 2) {
    if (!points.arrivee) return { label: 'Choisissez l\'arrivée', faire: () => toast('Touchez « Chez moi, ici », touchez la carte ou écrivez le nom du lieu.') };
    if (memeEndroit()) return { label: 'Départ = arrivée', faire: () => toast('Le départ et l\'arrivée sont au même endroit. Touchez la carte là où il faut livrer.', true) };
    if (erreurDevis) return { label: 'Hors zone', faire: () => toast(erreurDevis, true) };
    if (!dernierDevis) return { label: 'Calcul du prix…', faire: () => {} };
  }
  if (n === 3 && !form.description.value.trim()) {
    return { label: 'Choisissez ci-dessus', faire: () => toast('Touchez ce qu\'il faut livrer, par exemple « Colis ».') };
  }
  if (n === 4) {
    if (!telValide()) {
      return {
        label: 'Votre numéro',
        faire: () => {
          ouvrirCoordonnees();
          allerA(form.client_tel);
          toast(form.client_tel.value.trim() ? 'Numéro incorrect. Exemple : 77 123 45 67' : 'Écrivez votre numéro de téléphone.', true);
        },
      };
    }
    if (!form.client_nom.value.trim()) return { label: 'Votre nom', faire: () => { ouvrirCoordonnees(); allerA(form.client_nom); toast('Écrivez votre nom.'); } };
  }
  return null;
}

/** Prochaine chose à faire, ou null si la commande est prête à être vérifiée. */
function prochaineAction() {
  for (let n = 1; n < etape; n++) {
    const m = manque(n);
    if (m) return { ...m, faire: () => { allerEtape(n); m.faire(); } };
  }
  const m = manque(etape);
  if (m) return m;
  if (etape < 4) return { label: 'Continuer', suivant: true, faire: () => allerEtape(etape + 1) };
  return null;
}

function majBouton() {
  const b = $('btn-commander');
  const a = prochaineAction();
  b.classList.toggle('a-faire', !!a && !a.suivant);
  b.innerHTML = a ? `${esc(a.label)} ${ico('arrow-right')}` : `Commander ${ico('arrow-right')}`;
}

$('btn-retour').onclick = () => { if (etape > 1) allerEtape(etape - 1); };
// Points de progression : on peut revenir en arrière, ou avancer si tout est rempli
$('progression').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-aller]');
  if (!li) return;
  const n = Number(li.dataset.aller);
  for (let i = 1; i < n; i++) { const m = manque(i); if (m) { allerEtape(i); m.faire(); return; } }
  allerEtape(n);
});

// =========================================================================
// Choix rapides pour la description
// =========================================================================
const CHOIX_RAPIDES = {
  colis: [['Colis', 'package'], ['Documents', 'file-text'], ['Repas', 'utensils'], ['Vêtements', 'shirt'], ['Médicaments', 'pill'], ['Bouteille de gaz', 'flame']],
  achat: [['Pain', 'croissant'], ['Courses du marché', 'shopping-bag'], ['Médicaments', 'pill'], ['Eau', 'droplet'], ['Crédit téléphone', 'phone'], ['Gaz', 'flame']],
};
function afficherChoixRapides() {
  const texte = form.description.value.toLowerCase();
  $('choix-rapides').innerHTML = CHOIX_RAPIDES[form.type.value].map(([c, icone]) => {
    const choisi = texte.includes(c.toLowerCase());
    return `<button type="button" class="vignette ${choisi ? 'choisi' : ''}" data-choix="${esc(c)}" aria-pressed="${choisi}">
      ${ico(icone)}<span>${esc(c)}</span></button>`;
  }).join('') + `<button type="button" class="vignette" data-autre>${ico('ellipsis')}<span>Autre chose</span></button>`;
}
$('choix-rapides').addEventListener('click', (e) => {
  if (e.target.closest('[data-autre]')) { allerA(form.description); form.description.classList.remove('erreur'); return; }
  const b = e.target.closest('[data-choix]');
  if (!b) return;
  const champ = form.description;
  const mot = b.dataset.choix;
  const actuel = champ.value.trim();
  if (actuel.toLowerCase().includes(mot.toLowerCase())) {
    // second toucher : on retire ce choix
    champ.value = actuel.split(/\s*,\s*/).filter((x) => x.toLowerCase() !== mot.toLowerCase()).join(', ');
  } else {
    champ.value = actuel ? `${actuel}, ${mot}` : mot;
  }
  champ.classList.remove('erreur');
  afficherChoixRapides();
  majBouton();
});

// =========================================================================
// Coordonnées : résumées en une ligne quand elles sont déjà connues
// =========================================================================
let coordEnEdition = false;
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
function ouvrirCoordonnees() { coordEnEdition = true; afficherCoordonnees(); }
$('coord-modifier').onclick = () => { ouvrirCoordonnees(); form.client_nom.focus(); };

// =========================================================================
// Confirmation puis envoi
// =========================================================================
function fermerConfirmation() {
  $('confirmation').hidden = true;
  document.body.classList.remove('sans-defilement');
  arreterSuiviPaiement(); // la confirmation arrivera aussi en direct dans « Mes livraisons »
}
$('confirmation').addEventListener('click', (e) => { if (e.target.closest('[data-fermer-conf]')) fermerConfirmation(); });

function ouvrirConfirmation() {
  ['depart', 'arrivee'].forEach((t) => {
    if (!form[t + '_repere'].value.trim()) form[t + '_repere'].value = 'Point placé sur la carte';
  });
  const d = dernierDevis;
  const achat = form.type.value === 'achat';
  const budget = achat ? Number(form.montant_achat.value) || 0 : 0;
  const tel = form.client_tel.value.replace(/\D/g, '').slice(-9);
  const destNom = form.destinataire_nom.value.trim();
  const destTel = form.destinataire_tel.value.replace(/\D/g, '').slice(-9);
  const km = d.distance_km.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const remis = destNom || destTel
    ? `Remis à ${esc(destNom || 'destinataire')}${destTel ? ` · ${esc(telAffiche(destTel))}` : ''}`
    : 'Vous recevez la livraison';
  $('conf-contenu').innerHTML = `
    <div class="conf-total"><span>Prix de la course</span><b>${fcfa(d.prix)}</b></div>
    ${htmlChoixPaiement()}
    <div class="trajet" style="margin:8px 0 6px">
      <div>${esc(form.depart_repere.value)}</div>
      <div>${esc(form.arrivee_repere.value)}</div>
    </div>
    <div class="conf-ligne">${ico('route')}<div>${km} km${d.minutes ? ` · environ ${d.minutes} min` : ''}</div></div>
    <div class="conf-ligne">${ico(achat ? 'shopping-bag' : 'package')}<div>${esc(form.description.value.trim())}<small>${achat ? 'Acheter pour moi' : 'Livrer un colis'}</small></div></div>
    ${achat && budget ? `<div class="conf-ligne">${ico('banknote')}<div>Achats : environ ${fcfa(budget)}<small>Avancés par le livreur, à lui rembourser sur présentation du ticket</small></div></div>` : ''}
    <div class="conf-ligne">${ico('user')}<div>${esc(form.client_nom.value.trim())} · ${esc(telAffiche(tel))}<small>${remis}</small></div></div>`;
  $('conf-contenu').querySelectorAll('input[name=paiement]').forEach((r) => { r.onchange = majBoutonConfirmation; });
  majBoutonConfirmation();
  $('titre-conf').textContent = 'Vérifiez votre commande';
  $('conf-envoyer').hidden = false;
  $('confirmation').querySelector('.conf-pied [data-fermer-conf]').textContent = 'Modifier';
  $('confirmation').hidden = false;
  document.body.classList.add('sans-defilement');
}

// =========================================================================
// Moyens de paiement (Nangu : Wave / Orange Money, ou espèces)
// =========================================================================
let paiementsEnLigne = [];  // fournisseurs disponibles, lus sur /api/config
let paiementTest = false;
const CLE_PAIEMENT = 'tt_paiement';
const MOYENS = {
  wave: { nom: 'Wave', logo: 'W', classe: 'wave', aide: 'Payez maintenant, confirmé automatiquement' },
  orange_money: { nom: 'Orange Money', logo: 'OM', classe: 'orange', aide: 'Max it ou #144#, confirmé automatiquement' },
  especes: { nom: 'Espèces', logo: 'F', classe: 'especes', aide: 'Au livreur, à la livraison' },
};

function moyenChoisi() {
  const r = $('conf-contenu').querySelector('input[name=paiement]:checked');
  return r ? r.value : 'especes';
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
  const prix = fcfa(dernierDevis.prix);
  $('conf-envoyer').innerHTML = m === 'especes' ? `Confirmer · ${prix}` : `Payer avec ${MOYENS[m].nom} · ${prix}`;
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
  const lien = wave ? (estAndroid && infos.android_intent_url) || infos.pay_url : infos.maxit_url;
  let corps;
  if (wave) {
    corps = `
      ${lien ? `<a class="btn btn-payer wave" href="${esc(lien)}" ${estAndroid ? '' : 'target="_blank" rel="noopener"'}>${ico('wallet')} Ouvrir Wave et payer</a>` : ''}
      ${infos.qr_code_url && !estMobile ? `<p class="meta">Ou scannez ce code avec l'appli Wave de votre téléphone :</p><div class="qr"><img src="${esc(infos.qr_code_url)}" alt="QR code de paiement Wave"></div>` : ''}`;
  } else {
    corps = `
      ${lien ? `<a class="btn btn-payer orange" href="${esc(lien)}" target="_blank" rel="noopener">${ico('wallet')} Ouvrir Max it</a>
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
      ${corps}
      ${infos.checkout_url ? `<p class="meta"><a href="${esc(infos.checkout_url)}" target="_blank" rel="noopener">Ouvrir la page de paiement sécurisée</a></p>` : ''}
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

async function verifierPaiement(code) {
  if (!suiviPaiement || suiviPaiement.code !== code) return;
  let p;
  try { p = await api('GET', `/api/courses/suivi/${encodeURIComponent(code)}/paiement`); } catch { return; }
  const etat = $('etat-paiement');
  if (!etat) return arreterSuiviPaiement();
  if (p.paiement_statut === 'paye') {
    arreterSuiviPaiement();
    etat.innerHTML = `<span class="paiement-ok">${ico('circle-check')} Paiement reçu. Nous cherchons un livreur.</span>`;
    toast('Paiement reçu. Les livreurs disponibles sont prévenus.');
    setTimeout(() => { fermerConfirmation(); chargerListe().then(ouvrirTiroir); }, 1800);
  } else if (p.paiement_statut === 'expire' || p.paiement_statut === 'annule') {
    arreterSuiviPaiement();
    etat.innerHTML = `${ico('triangle-alert')} ${p.paiement_statut === 'expire' ? 'Délai de paiement dépassé : commande annulée.' : 'Paiement annulé.'}`;
    chargerListe();
  }
}

/** Depuis « Mes livraisons » : reprendre le paiement d'une course en attente. */
async function reprendrePaiement(code) {
  try {
    const p = await api('GET', `/api/courses/suivi/${encodeURIComponent(code)}/paiement`);
    if (p.paiement_statut !== 'en_attente' || !p.infos) { chargerListe(); return toast('Ce paiement n\'est plus en attente.'); }
    fermerTiroir();
    afficherEcranPaiement(code, p.infos, p.montant_du);
  } catch (e) { toast(e.message, true); }
}

async function envoyerCommande() {
  const d = Object.fromEntries(new FormData(form));
  d.paiement = moyenChoisi();
  Stock.set(CLE_PAIEMENT, d.paiement);
  const bouton = $('conf-envoyer');
  const contenu = bouton.innerHTML;
  bouton.disabled = true;
  bouton.innerHTML = `${ico('loader-circle', 'tourne')} Envoi…`;
  try {
    const course = await api('POST', '/api/courses', { ...d, depart: coord(points.depart), arrivee: coord(points.arrivee) });
    ajouterCode(course.suivi_token);
    Stock.set(CLE_COORD, JSON.stringify({ nom: d.client_nom, tel: d.client_tel }));
    memoriserAdresse(coord(points.arrivee), d.arrivee_repere);
    memoriserAdresse(coord(points.depart), d.depart_repere);
    if ('Notification' in window && Notification.permission === 'granted') activerNotifications().catch(() => {});

    // remise à zéro (on garde nom et téléphone)
    ['depart_repere', 'arrivee_repere', 'montant_achat', 'description', 'destinataire_nom', 'destinataire_tel']
      .forEach((n) => { form[n].value = ''; delete form[n].dataset.auto; delete form[n].dataset.ancre; });
    form.querySelector('input[name=type][value=colis]').checked = true;
    $('l-montant').hidden = true;
    $('bloc-destinataire').open = false;
    ['depart', 'arrivee'].forEach((t) => {
      arreterAttente(t);
      if (points[t]) { points[t].remove(); points[t] = null; }
      majCoord(t);
      majEtat(t, 'À placer sur la carte');
    });
    coordEnEdition = false;
    afficherCoordonnees();
    afficherChoixRapides();
    majDevis();
    allerEtape(1);

    if (course.paiement_infos) {
      // paiement en ligne : on reste dans la fenêtre, qui devient l'écran de paiement
      chargerListe();
      afficherEcranPaiement(course.suivi_token, course.paiement_infos, course.prix);
      return;
    }
    fermerConfirmation();
    toast('Commande envoyée. Les livreurs disponibles sont prévenus.');
    await chargerListe();
    ouvrirTiroir();
  } catch (err) {
    toast(err.message, true);
  } finally {
    bouton.disabled = false;
    bouton.innerHTML = contenu;
  }
}
$('conf-envoyer').onclick = envoyerCommande;

form.onsubmit = (e) => {
  e.preventDefault();
  const a = prochaineAction();
  if (a) { a.faire(); return; }
  ouvrirConfirmation();
};

// =========================================================================
// Démarrage
// =========================================================================
function initCarte() {
  const outilsCarte = creerCarte('map');
  carte = outilsCarte.carte;
  // Toucher la carte : sur un nom de lieu, on choisit ce lieu (comme Google Maps) ; ailleurs, on pose le point
  carte.on('click', (e) => {
    if (etape > 2) return; // aux étapes « quoi » et « vous », la carte sert seulement d'aperçu
    const lieu = outilsCarte.lieuSousLeDoigt(e.latlng);
    if (!lieu) return placer(mode, e.latlng);
    const type = mode;
    form[type + '_repere'].dataset.ancre = JSON.stringify({ nom: lieu.nom, lat: lieu.lat, lng: lieu.lng });
    placerAvecRepere(type, lieu.lat, lieu.lng, lieu.nom, true);
    toast(`${type === 'depart' ? 'Départ' : 'Arrivée'} : « ${lieu.nom} »`);
  });

  // Suggestions directement dans les champs Départ / Arrivée : choisir un lieu place le point
  ['depart', 'arrivee'].forEach((type) => {
    const champ = form[type + '_repere'];
    brancherRecherche(champ, $('sugg-' + type), (lieu) => {
      choisirMode(type);
      if (lieu.colle) {
        champ.value = '';
        placerAvecRepere(type, lieu.lat, lieu.lng, null);
        if (!memeEndroit()) majEtat(type, `${ico('check', 'ic-sm')} Position collée`, 'place');
        avancer(type);
        return;
      }
      const texte = nomAvecVillage(lieu);
      champ.dataset.ancre = JSON.stringify({ nom: texte, lat: lieu.lat, lng: lieu.lng });
      placerAvecRepere(type, lieu.lat, lieu.lng, texte, true);
      champ.blur(); // fermer le clavier pour voir le point sur la carte
      if (!grandEcran()) window.scrollTo({ top: 0, behavior: 'smooth' });
      avancer(type);
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
afficherCoordonnees();
afficherChoixRapides();
allerEtape(1);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('confirmation').hidden) fermerConfirmation(); });
brancherBoutonNotif($('btn-notif'));
chargerListe().then(() => { if (suiviPartage) ouvrirTiroir(); });

socket = io({ auth: { suivi: lireCodes() } });
socket.on('position:recue', positionRecue);
socket.on('connect', () => Object.values(attentes).forEach((a) => socket.emit('attendre-position', a.code)));
socket.on('course:maj', (c) => {
  const messages = {
    acceptee: `${c.livreur_nom} a accepté votre livraison`,
    recuperee: 'Votre colis a été récupéré, il est en route',
    livree: 'Livraison terminée',
    en_attente: 'Le livreur s\'est désisté, recherche d\'un autre livreur…',
  };
  // paiement tout juste confirmé : ce n'est pas un désistement
  const vientDEtrePaye = c.statut === 'en_attente' && c.paye_le && Date.now() - new Date(c.paye_le).getTime() < 60000;
  if (vientDEtrePaye) { if (!suiviPaiement) toast('Paiement reçu. Nous cherchons un livreur.'); }
  else if (messages[c.statut]) toast(messages[c.statut]);
  chargerListe();
});
