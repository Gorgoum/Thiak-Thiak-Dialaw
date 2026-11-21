let suiviPosition = null;
let dernierEnvoi = 0;
let enCourse = false; // pendant une course, le client suit la moto / la voiture en direct
let derniereEnvoyee = null;

function bip() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.3, ctx.currentTime + t);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.2);
    });
  } catch { /* audio indisponible */ }
  if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
}

let maPosition = null; // dernière position connue du livreur { lat, lng }
let maPositionInfo = { le: 0, precision: null }; // quand et avec quelle précision (pour le contrôle « sur place »)
const debutPage = Date.now();
// GPS actif : position reçue il y a moins de 45 s (au démarrage, on lui laisse 45 s pour trouver le premier point)
const gpsActif = () => (maPosition ? Date.now() - maPositionInfo.le < 45000 : Date.now() - debutPage < 45000);
let gpsAffiche = null; // état du GPS lors du dernier affichage de la course
setInterval(() => {
  if (gpsAffiche !== null && gpsAffiche !== gpsActif()) chargerTout(); // boutons de secours affichés / retirés
}, 15000);

/** Position fraîche (≤ 8 s) envoyée avec « Je suis arrivé » & co : le serveur vérifie que le livreur est sur place. */
function positionPourControle() {
  return new Promise((ok) => {
    const repli = () => ok(maPosition ? { ...maPosition, precision: maPositionInfo.precision } : null);
    // position du suivi GPS toute fraîche : on l'utilise tout de suite (pas d'attente)
    if (maPosition && Date.now() - maPositionInfo.le < 15000) return repli();
    if (!('geolocation' in navigator)) return repli();
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude, precision: p.coords.accuracy }),
      repli,
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }
    );
  });
}

function envoyerPosition(p) {
  maPosition = { lat: p.coords.latitude, lng: p.coords.longitude };
  maPositionInfo = { le: Date.now(), precision: p.coords.accuracy };
  majPositionSurCarte();
  Guidage.majPosition(maPosition);
  // envoi au serveur : toutes les 5 s pendant une course (le client voit le véhicule bouger), sinon toutes les 30 s
  const ecart = Date.now() - dernierEnvoi;
  if (ecart < (enCourse ? 5000 : 30000)) return;
  // à l'arrêt pendant une course, inutile de renvoyer la même position plus d'une fois par 30 s
  if (enCourse && derniereEnvoyee && ecart < 30000 && distanceM(derniereEnvoyee, maPosition) < 8) return;
  dernierEnvoi = Date.now();
  derniereEnvoyee = maPosition;
  api('POST', '/api/livreur/position', { ...maPosition, precision: maPositionInfo.precision }).then((r) => {
    enCourse = !!(r && r.en_course);
    if (r && r.transitions && r.transitions.length) chargerTout();
  }).catch(() => {});
}

// =========================================================================
// Carte de la course en cours : départ A, arrivée B, position du livreur
// =========================================================================
let carteCourse = null;
let cleCourse = null; // id + statut de la course affichée (pour recadrer seulement si ça change)
const marqueursCourse = {};

const iconePin = (type) => L.divIcon({
  className: '',
  html: `<div class="pin pin-${type}"><span>${type === 'depart' ? 'A' : 'B'}</span></div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 41],
});

function majPositionSurCarte() {
  if (!carteCourse || !maPosition) return;
  if (marqueursCourse.moi) marqueursCourse.moi.setLatLng(maPosition);
  else {
    marqueursCourse.moi = L.marker(maPosition, {
      interactive: false,
      zIndexOffset: 1000,
      icon: L.divIcon({ className: '', html: '<span class="point-livreur"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(carteCourse);
  }
}

function recadrerCourse(c) {
  const pts = [[c.depart_lat, c.depart_lng], [c.arrivee_lat, c.arrivee_lng]];
  if (maPosition) pts.push([maPosition.lat, maPosition.lng]);
  carteCourse.fitBounds(pts, { padding: [50, 50], maxZoom: 17 });
}

function majCarteCourse(c) {
  const bloc = document.getElementById('bloc-carte-course');
  courseActive = c;
  if (!c) {
    if (Guidage.actif) quitterGuidage();
    bloc.hidden = true;
    cleCourse = null;
    if (!document.getElementById('dispo').checked) suivreGPS(false); // course finie, livreur hors service
    return;
  }
  bloc.hidden = false;
  if (!carteCourse) {
    carteCourse = creerCarte('map-course').carte;
    brancherPleinEcran(document.getElementById('plein-course'), bloc, carteCourse);
  }
  carteCourse.invalidateSize();
  ['depart', 'arrivee'].forEach((t) => {
    const ll = [c[t + '_lat'], c[t + '_lng']];
    if (marqueursCourse[t]) marqueursCourse[t].setLatLng(ll);
    else marqueursCourse[t] = L.marker(ll, { icon: iconePin(t), keyboard: false }).addTo(carteCourse);
    marqueursCourse[t].bindTooltip(esc(c[t + '_repere']), { direction: 'top', offset: [0, -40] });
  });
  majPositionSurCarte();
  const cle = c.id + ':' + c.statut;
  if (cle !== cleCourse) {
    const avant = cleCourse;
    cleCourse = cle;
    // Guidage automatique : course acceptée → vers le départ ; colis récupéré → vers l'arrivée.
    // Il ne redémarre pas tout seul pour une étape que le livreur a quittée ou déjà atteinte.
    if (Guidage.actif && avant && avant.startsWith(c.id + ':')) demarrerGuidage();
    else if (!Guidage.actif && Stock.get(CLE_NAV_QUITTE) !== cle) demarrerGuidage();
    else if (!Guidage.actif) recadrerCourse(c);
  }
  document.getElementById('recentrer-course').onclick = () => recadrerCourse(c);
  // pendant une course, on suit la position même si le livreur n'est plus « disponible »
  suivreGPS(true);
}

// =========================================================================
// Guidage étape par étape
// =========================================================================
let courseActive = null;
const CLE_NAV_QUITTE = 'tt_nav_quitte'; // « course:statut » pour laquelle le guidage a été quitté ou terminé
const memoriserFinGuidage = () => { if (cleCourse) Stock.set(CLE_NAV_QUITTE, cleCourse); };

function quitterGuidage() {
  Guidage.arreter();
  const bloc = document.getElementById('bloc-carte-course');
  bloc.classList.remove('carte-plein');
  document.body.classList.remove('sans-defilement');
  if (carteCourse) setTimeout(() => { carteCourse.invalidateSize(); if (courseActive) recadrerCourse(courseActive); }, 50);
}

async function demarrerGuidage() {
  const c = courseActive;
  if (!c) return;
  const versDepart = c.statut === 'acceptee';
  const cible = versDepart
    ? { lat: c.depart_lat, lng: c.depart_lng, nom: c.depart_repere, type: 'depart' }
    : { lat: c.arrivee_lat, lng: c.arrivee_lng, nom: c.arrivee_repere, type: 'arrivee' };

  let pos = maPosition;
  if (!pos) {
    try {
      const p = await new Promise((ok, ko) => navigator.geolocation.getCurrentPosition(ok, ko, { enableHighAccuracy: true, timeout: 12000 }));
      maPosition = pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      majPositionSurCarte();
    } catch {
      return toast('Position introuvable : activez la localisation du téléphone pour être guidé.', true);
    }
  }
  // carte en plein écran pendant le guidage
  const bloc = document.getElementById('bloc-carte-course');
  bloc.classList.add('carte-plein');
  document.body.classList.add('sans-defilement');
  setTimeout(() => carteCourse.invalidateSize(), 50);
  await Guidage.demarrer(carteCourse, cible, pos, {
    surFin: () => {
      memoriserFinGuidage();
      quitterGuidage();
      document.getElementById('bloc-active').scrollIntoView({ behavior: 'smooth' });
      toast(versDepart ? 'Arrivé au départ : récupérez le colis puis confirmez.' : 'Arrivé à destination : remettez le colis puis confirmez.');
    },
  });
}

document.getElementById('nav-stop').onclick = () => { memoriserFinGuidage(); quitterGuidage(); };
document.getElementById('nav-voix').onclick = () => Guidage.basculerVoix();
document.getElementById('nav-recentrer').onclick = () => Guidage.recentrer();

function suivreGPS(actif) {
  if (!navigator.geolocation) return;
  if (actif && suiviPosition === null) {
    suiviPosition = navigator.geolocation.watchPosition(envoyerPosition, () => {}, { enableHighAccuracy: true, maximumAge: 3000 }); // position fraîche pour le guidage
  } else if (!actif && suiviPosition !== null) {
    navigator.geolocation.clearWatch(suiviPosition);
    suiviPosition = null;
  }
}

async function changerDispo(dispo) {
  const etat = document.getElementById('etat-dispo');
  const envoyer = (pos) => api('POST', '/api/livreur/disponibilite', {
    disponible: dispo,
    ...(pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : {}),
  });
  try {
    if (dispo && navigator.geolocation) {
      await new Promise((ok) => navigator.geolocation.getCurrentPosition(
        (p) => envoyer(p).then(ok, ok),
        () => envoyer(null).then(ok, ok),
        { enableHighAccuracy: true, timeout: 10000 }
      ));
    } else {
      await envoyer(null);
    }
    suivreGPS(dispo);
    etat.innerHTML = dispo
      ? `${ico('circle-check', 'ic-sm')} Vous recevez les nouvelles courses autour de vous.`
      : `${ico('power', 'ic-sm')} Vous ne recevez plus de nouvelles courses.`;
  } catch (e) { toast(e.message, true); }
}

function trajet(c) {
  return `<div class="trajet">
    <div>${esc(c.depart_repere)}</div>
    <div>${esc(c.arrivee_repere)}</div>
  </div>
  ${c.service === 'trajet'
    ? `<div class="ligne-info">${ico(gamme(c.vehicule).icone, 'ic-sm')} <b>Passager · ${gamme(c.vehicule).nom}</b> · ${esc(c.description)}</div>`
    : `<div class="ligne-info">${ico(c.type === 'achat' ? 'shopping-bag' : 'package', 'ic-sm')} ${c.type === 'achat' ? '<b>Achat :</b> ' : ''}${esc(c.description)}</div>`}
  ${c.type === 'achat' && c.montant_achat ? `<div class="meta">Avance estimée : ${fcfa(c.montant_achat)} (remboursée par le client)</div>` : ''}`;
}

/** Ce qui va se passer tout seul (le GPS détecte l'arrivée, comme Google Maps). */
function etatAuto(c, versDepart, attendPaiement, aEncaisser) {
  const trajet = c.service === 'trajet';
  let texte;
  if (!gpsActif()) {
    texte = `<b>GPS indisponible</b><small>Activez la localisation pour que l'arrivée soit détectée toute seule. En attendant, confirmez à la main ci-dessous.</small>`;
  } else if (versDepart && !c.arrive_le) {
    texte = `<b>Arrivée détectée automatiquement</b><small>Dès que vous serez sur place, ${trajet ? 'le passager' : 'le client'} sera prévenu. Rien à toucher.</small>`;
  } else if (versDepart && attendPaiement) {
    texte = `<b>Vous êtes arrivé</b><small>Attendez le paiement du client avant de ${trajet ? 'partir avec le passager' : 'récupérer le colis'}.</small>`;
  } else if (versDepart) {
    texte = trajet
      ? '<b>Vous êtes arrivé, le passager est prévenu</b><small>La course démarre toute seule quand vous partez avec lui.</small>'
      : '<b>Vous êtes arrivé</b><small>Récupérez le colis : la livraison démarre toute seule quand vous repartez.</small>';
  } else {
    texte = `<b>Fin de course détectée automatiquement</b><small>À l'arrivée, la course se termine toute seule${aEncaisser ? ` : encaissez ${fcfa(aEncaisser)}` : ''}.</small>`;
  }
  return `<div class="etat-auto ${gpsActif() ? '' : 'alerte'}">${ico(gpsActif() ? 'navigation' : 'triangle-alert')}<div>${texte}</div></div>`;
}

/** Boutons de secours, seulement quand le GPS ne répond plus (le serveur vérifie quand même la position connue). */
function boutonsSecours(c, versDepart, attendPaiement) {
  const trajet = c.service === 'trajet';
  if (!versDepart) return `<button class="jaune grand" data-etape="livree" data-id="${c.id}">${ico('circle-check')} ${trajet ? 'Arrivé à destination' : 'Livraison terminée'}</button>`;
  if (!c.arrive_le) return `<button class="jaune grand" data-etape="arrive" data-id="${c.id}">${ico('map-pin')} Je suis arrivé</button>`;
  return `<button class="jaune grand" data-etape="recuperee" data-id="${c.id}" ${attendPaiement ? 'disabled' : ''}>${ico(trajet ? 'user' : 'package')} ${trajet ? 'Passager à bord' : 'J\'ai récupéré le colis'}</button>`;
}

function carteActive(c) {
  enCourse = true; // une course en cours : la position part toutes les 5 s
  gpsAffiche = gpsActif();
  const versDepart = c.statut === 'acceptee';
  const cible = versDepart ? [c.depart_lat, c.depart_lng] : [c.arrivee_lat, c.arrivee_lng];
  const payeEnLigne = c.paiement_statut === 'paye';
  const moyen = c.paiement === 'orange_money' ? 'Orange Money' : 'Wave';
  const achats = c.type === 'achat' ? c.montant_achat : 0;
  const aEncaisser = (payeEnLigne ? 0 : c.prix) + achats;
  let detailEncaisser = '';
  if (payeEnLigne && achats) detailEncaisser = `<br><small>Course déjà payée par ${moyen} · seulement les achats (montant réel du ticket)</small>`;
  else if (c.type === 'achat') detailEncaisser = `<br><small>course ${fcfa(c.prix)} + achats (montant réel du ticket)</small>`;
  // en espèces : les frais de service et d'achat sont encaissés avec la course, puis reversés à la plateforme
  const fraisYob = (Number(c.frais_service) || 0) + (Number(c.frais_achat) || 0);
  if (!payeEnLigne && fraisYob) detailEncaisser += `<br><small>dont ${fcfa(fraisYob)} de frais Yobalema, à reverser avec la commission</small>`;
  // course à payer en ligne, pas encore payée : le client paie maintenant (10 minutes au plus)
  const attendPaiement = c.paiement !== 'especes' && !payeEnLigne;
  const blocEncaisser = attendPaiement
    ? `<div class="attente-client">${ico('loader-circle', 'tourne')} <div><b>En attente du paiement ${moyen} du client</b>
        <small>Vous serez prévenu dès qu'il a payé. Ne récupérez pas le colis avant. Sans paiement dans les 10 minutes, la course est annulée et vous êtes libéré.</small></div></div>`
    : payeEnLigne && !achats
      ? `<div class="devis paye-en-ligne" style="margin-top:10px">${ico('circle-check')} Course déjà payée par ${moyen} : <b>rien à encaisser</b></div>`
      : `<div class="devis" style="margin-top:10px">À encaisser : <span class="prix">${fcfa(aEncaisser)}</span>${detailEncaisser}</div>`;
  return `
    <div class="card course-active" data-service="${c.service || 'livraison'}">
      <h2>Course en cours ${badge(c.statut, c.service)}</h2>
      ${frise(c.statut, c.service)}
      ${trajet(c)}
      ${(() => {
        const autre = !!(c.destinataire_nom || c.destinataire_tel);
        const trajet = c.service === 'trajet';
        // commande pour quelqu'un d'autre : on appelle d'abord le passager (ou le destinataire du colis)
        return autre
          ? blocPersonne(c.destinataire_nom || (trajet ? 'Passager' : 'Destinataire'), c.destinataire_tel, trajet ? 'Passager' : 'Destinataire')
            + blocPersonne(c.client_nom, c.client_tel, 'A commandé la course')
          : blocPersonne(c.client_nom, c.client_tel, trajet ? 'Passager' : 'Client · reçoit la livraison');
      })()}
      ${(() => {
        // colis en route : le livreur prévient le destinataire d'un toucher (WhatsApp ou SMS, depuis son téléphone)
        const tel = String(c.destinataire_tel || '').replace(/\D/g, '').slice(-9);
        if (c.service === 'trajet' || c.statut !== 'recuperee' || !/^7\d{8}$/.test(tel)) return '';
        const texte = encodeURIComponent(`Bonjour${c.destinataire_nom ? ' ' + c.destinataire_nom : ''}, je suis le livreur Yobalema Yène. J'arrive avec votre colis${c.client_nom ? ` envoyé par ${c.client_nom}` : ''}, à ${c.arrivee_repere}. Merci d'être disponible.`);
        return `<div class="prevenir-dest"><b>${ico('bell', 'ic-sm')} Prévenir ${esc(c.destinataire_nom || 'le destinataire')}</b>
          <div class="actions"><a class="bouton whatsapp" href="https://wa.me/221${tel}?text=${texte}" target="_blank" rel="noopener">${ico('message-circle', 'ic-sm')} WhatsApp</a>
          <a class="bouton" href="sms:+221${tel}?body=${texte}">${ico('message-square', 'ic-sm')} SMS</a></div></div>`;
      })()}
      ${blocEncaisser}
      <div class="actions">
        <button class="btn-primaire" data-guidage>${ico('navigation', 'ic-sm')} Guider jusqu'${versDepart ? 'au départ' : 'à l\'arrivée'}</button>
      </div>
      <a class="lien-secondaire" data-nav="${cible[0]},${cible[1]}" ${lienItineraire(cible[0], cible[1], maPosition)}>Ouvrir dans une autre application GPS</a>
      ${etatAuto(c, versDepart, attendPaiement, aEncaisser)}
      <div class="actions">
        ${gpsActif() ? '' : boutonsSecours(c, versDepart, attendPaiement)}
        ${versDepart ? `<button class="danger" data-etape="liberer" data-id="${c.id}">Me désister</button>` : ''}
      </div>
    </div>`;
}

/** « Mon argent » : une phrase claire pour le solde, la journée, puis l'historique. */
function htmlArgent(a) {
  const s = a.solde;
  const solde = s > 0
    ? `<div class="solde solde-plus"><small>La plateforme vous doit</small><b>${fcfa(s)}</b><span>Versé lors du prochain règlement.</span></div>`
    : s < 0
      ? `<div class="solde solde-moins ${a.bloque ? 'bloque' : ''}"><small>Vous devez reverser à la plateforme</small><b>${fcfa(-s)}</b>
          <span>${a.bloque
            ? `Plafond de ${fcfa(a.plafond)} dépassé : vous ne pouvez plus accepter de course. Envoyez ce montant par Wave à la plateforme.`
            : `Commissions des courses payées en espèces${a.plafond ? ` (plafond ${fcfa(a.plafond)})` : ''}.`}</span></div>`
      : `<div class="solde"><small>Votre solde</small><b>0 FCFA</b><span>Rien à recevoir, rien à reverser.</span></div>`;
  const lignes = a.mouvements.map((m) => `
    <li><span>${esc(m.libelle)}<small>${dateCourte(m.cree_le)}${m.reference ? ` · réf. ${esc(m.reference)}` : ''}</small></span>
      <b class="${m.montant >= 0 ? 'plus' : 'moins'}">${m.montant >= 0 ? '+' : '−'}${fcfa(Math.abs(m.montant))}</b></li>`).join('');
  return `${solde}
    <div class="stats" style="margin:12px 0 0">
      <div class="stat"><div class="v">${a.aujourdhui.nb}</div><div class="l">courses livrées aujourd'hui</div></div>
      <div class="stat"><div class="v">${fcfa(a.aujourdhui.part)}</div><div class="l">votre part aujourd'hui (après ${a.commission_pct} %)</div></div>
      <div class="stat"><div class="v">${fcfa(a.aujourdhui.especes)}</div><div class="l">encaissé en espèces aujourd'hui</div></div>
    </div>
    ${lignes ? `<details class="replier" style="margin-top:14px"><summary>${ico('chevron-down', 'ic-sm')} Détail de mes comptes</summary>
      <ul class="mouvements">${lignes}</ul>
      <p class="aide">« + » : la plateforme vous le doit. « − » : vous le devez à la plateforme.</p></details>` : ''}`;
}

async function chargerTout() {
  try {
    const [dispos, mes, argent] = await Promise.all([
      api('GET', '/api/livreur/courses-disponibles'),
      api('GET', '/api/livreur/mes-courses'),
      api('GET', '/api/livreur/argent'),
    ]);
    const active = mes.find((c) => ['acceptee', 'recuperee'].includes(c.statut));
    document.getElementById('bloc-active').innerHTML = active ? carteActive(active) : '';
    majCarteCourse(active);

    document.getElementById('disponibles').innerHTML = dispos.length
      ? dispos.map((c) => `
        <div class="course">
          <div class="haut"><span class="meta">${dateCourte(c.cree_le)} · ${Number(c.distance_km).toLocaleString('fr-FR')} km
            ${c.distance_moi_km != null ? ` · à ${c.distance_moi_km.toLocaleString('fr-FR')} km de vous` : ''}</span>
            <span class="prix-course">${fcfa(c.prix)}${c.part_livreur != null ? `<br><small class="part-livreur">vous gagnez ${fcfa(c.part_livreur)}</small>` : ''}${c.service === 'trajet' ? `<br><span class="badge b-acceptee">${ico(gamme(c.vehicule).icone, 'ic-sm')} Trajet · ${gamme(c.vehicule).nom}</span>` : ''}${c.paiement_statut === 'paye' ? `<br><span class="badge b-livree">Payé en ligne</span>` : c.paiement !== 'especes' ? `<br><span class="badge b-acceptee">${c.paiement === 'wave' ? 'Wave' : 'Orange Money'} à l'acceptation</span>` : ''}</span></div>
          ${trajet(c)}
          <div class="actions">
            <a class="bouton" data-nav="${c.depart_lat},${c.depart_lng}" ${lienItineraire(c.depart_lat, c.depart_lng, maPosition)}>${ico('map', 'ic-sm')} Voir le départ</a>
            <button class="jaune" data-accepter="${c.id}" ${active || argent.bloque ? 'disabled' : ''}>${ico('check', 'ic-sm')} Accepter</button>
          </div>
          ${active ? `<p class="meta bloque">${ico('info', 'ic-sm')} Terminez d'abord votre course en cours pour accepter celle-ci.</p>`
            : argent.bloque ? `<p class="meta bloque">${ico('info', 'ic-sm')} Reversez d'abord ce que vous devez à la plateforme (voir « Mon argent »).</p>` : ''}
        </div>`).join('')
      : '<p class="vide">Aucune course en attente. Restez disponible, vous serez notifié.</p>';

    document.getElementById('gains').innerHTML = htmlArgent(argent);

    const hist = mes.filter((c) => ['livree', 'annulee'].includes(c.statut));
    document.getElementById('historique').innerHTML = hist.length
      ? hist.map((c) => `
        <div class="course">
          <div class="haut">${badge(c.statut, c.service)}<span class="prix-course">${fcfa(c.prix)}</span></div>
          <div class="meta">${dateCourte(c.livree_le || c.cree_le)} · ${esc(c.depart_repere)} → ${esc(c.arrivee_repere)}
          ${c.note ? ` · ${'★'.repeat(c.note)}` : ''}</div>
        </div>`).join('')
      : '<p class="vide">Pas encore de course terminée.</p>';
  } catch (e) { toast(e.message, true); }
}

// Liens d'itinéraire : on les recalcule au moment du clic, avec la position la plus récente
document.getElementById('app').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a) return;
  const [lat, lng] = a.dataset.nav.split(',').map(Number);
  const tmp = document.createElement('div');
  tmp.innerHTML = `<a ${lienItineraire(lat, lng, maPosition)}></a>`;
  const frais = tmp.firstChild;
  a.href = frais.getAttribute('href');
  if (frais.target) { a.target = frais.target; a.rel = frais.rel; } else { a.removeAttribute('target'); }
}, true);

document.getElementById('app').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.id === 'btn-notif') return;
  if (b.hasAttribute('data-guidage')) { demarrerGuidage(); return; }
  try {
    if (b.dataset.accepter) {
      b.disabled = true;
      // position fraîche : le serveur vérifie que le client est dans mon rayon
      await api('POST', `/api/livreur/courses/${b.dataset.accepter}/accepter`, (await positionPourControle()) || {});
      // position envoyée tout de suite : le client voit aussitôt où est son chauffeur
      enCourse = true; dernierEnvoi = 0; derniereEnvoyee = null;
      if (maPosition) envoyerPosition({ coords: { latitude: maPosition.lat, longitude: maPosition.lng } });
      toast('Course acceptée ! Le guidage vers le départ démarre.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (b.dataset.etape) {
      const carte = b.closest('.course-active');
      const trajet = !!(carte && carte.dataset.service === 'trajet');
      const msgs = {
        recuperee: trajet ? 'Le passager est-il à bord ?' : 'Confirmer que vous avez récupéré le colis ?',
        livree: trajet ? 'Confirmer l\'arrivée à destination et l\'encaissement ?' : 'Confirmer la livraison et l\'encaissement ?',
        liberer: 'Rendre cette course aux autres livreurs ?',
      };
      if (msgs[b.dataset.etape] && !confirm(msgs[b.dataset.etape])) return;
      b.disabled = true;
      // arrivée, prise en charge, fin de course : le serveur vérifie que le livreur est bien sur place
      const surPlace = ['arrive', 'recuperee', 'livree'].includes(b.dataset.etape);
      if (surPlace) b.innerHTML = `${ico('loader-circle', 'tourne')} Vérification de votre position…`;
      const ici = surPlace ? await positionPourControle() : null;
      await api('POST', `/api/livreur/courses/${b.dataset.id}/${b.dataset.etape}`, ici || {});
    } else return;
    chargerTout();
  } catch (err) { toast(err.message, true); chargerTout(); }
});

function afficherApp(u) {
  document.getElementById('auth').hidden = true;
  document.getElementById('deco').hidden = false;
  document.getElementById('deco').onclick = deconnexion;
  document.querySelectorAll('.nom').forEach((n) => { n.textContent = u.nom; });
  const ligneVehicule = document.querySelector('.bonjour small.meta');
  if (ligneVehicule) ligneVehicule.textContent = ['Chauffeur · ' + gamme(u.vehicule).vehicule, u.modele, u.plaque].filter(Boolean).join(' · ');
  const av = document.getElementById('avatar');
  if (av) av.textContent = initiales(u.nom);

  if (!u.actif) {
    document.getElementById('attente').hidden = false;
    document.getElementById('reverifier').onclick = async () => {
      const moi = await api('GET', '/api/auth/moi').catch(() => null);
      if (moi && moi.actif) location.reload(); else toast('Toujours en attente de validation');
    };
    return;
  }

  document.getElementById('app').hidden = false;
  brancherBoutonNotif(document.getElementById('btn-notif'));
  const dispo = document.getElementById('dispo');
  dispo.checked = !!u.disponible;
  dispo.onchange = () => changerDispo(dispo.checked);
  if (u.disponible) changerDispo(true);
  chargerTout();
  setInterval(chargerTout, 60000);

  const socket = connecterTempsReel();
  let nbAvant = null;
  socket.on('courses:changement', async () => {
    await chargerTout();
    const n = document.querySelectorAll('[data-accepter]').length;
    if (dispo.checked && nbAvant !== null && n > nbAvant) { bip(); toast('Nouvelle course disponible'); }
    nbAvant = n;
  });
  socket.on('course:maj', (c) => {
    const recent = (d) => d && Date.now() - new Date(d).getTime() < 60000;
    if (c && c.livreur_id && c.statut === 'acceptee' && recent(c.arrive_le) && !recent(c.paye_le)) {
      bip();
      toast(c.service === 'trajet' ? 'Vous êtes arrivé : le passager est prévenu.' : 'Vous êtes arrivé : le client est prévenu.');
    } else if (c && c.livreur_id && c.statut === 'recuperee' && recent(c.recuperee_le)) {
      toast(c.service === 'trajet' ? 'Course démarrée. Bonne route !' : 'Livraison démarrée. Bonne route !');
    } else if (c && c.livreur_id && c.statut === 'livree' && recent(c.livree_le)) {
      bip();
      const reste = (c.paiement_statut === 'paye' ? 0 : c.prix) + (c.type === 'achat' ? (c.montant_achat || 0) : 0);
      toast(`${c.service === 'trajet' ? 'Arrivé à destination' : 'Livraison terminée'} ✓${reste ? ` Encaissez ${fcfa(reste)}.` : ''}`);
    }
    // course à payer en ligne : le livreur sait tout de suite si le client a payé, ou s'il a renoncé
    if (c && c.statut === 'acceptee' && c.paiement_statut === 'paye' && c.paye_le && Date.now() - new Date(c.paye_le).getTime() < 60000) {
      bip();
      toast('Paiement reçu ✓ Vous pouvez récupérer le colis.');
    } else if (c && c.statut === 'annulee' && c.livreur_id) {
      toast('Course annulée : le client n\'a pas payé. Vous êtes libre pour une autre course.', true);
    }
    chargerTout();
  });
  socket.on('argent:maj', (r) => {
    toast(r.sens === 'paye_au_livreur' ? 'La plateforme vous a versé votre argent. Merci !' : 'Votre versement à la plateforme est bien enregistré. Merci !');
    chargerTout();
  });
  setTimeout(() => { nbAvant = document.querySelectorAll('[data-accepter]').length; }, 1500);
}

// nouvelle version en ligne : rechargement seulement hors guidage
surveillerMiseAJour(() => !Guidage.actif);

(async () => {
  const u = await sessionExistante();
  if (u) afficherApp(u);
  else ecranAuth(document.getElementById('auth'), { titre: 'Recevez les courses de Yène directement sur votre téléphone.' }, afficherApp);
})();
