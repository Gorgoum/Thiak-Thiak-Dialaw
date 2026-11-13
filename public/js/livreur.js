let suiviPosition = null;
let dernierEnvoi = 0;

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

function envoyerPosition(p) {
  maPosition = { lat: p.coords.latitude, lng: p.coords.longitude };
  majPositionSurCarte();
  Guidage.majPosition(maPosition);
  if (Date.now() - dernierEnvoi < 30000) return; // envoi au serveur au plus toutes les 30 s
  dernierEnvoi = Date.now();
  api('POST', '/api/livreur/position', { lat: p.coords.latitude, lng: p.coords.longitude }).catch(() => {});
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
    ? { lat: c.depart_lat, lng: c.depart_lng, nom: c.depart_repere }
    : { lat: c.arrivee_lat, lng: c.arrivee_lng, nom: c.arrivee_repere };

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
  <div class="ligne-info">${ico(c.type === 'achat' ? 'shopping-bag' : 'package', 'ic-sm')} ${c.type === 'achat' ? '<b>Achat :</b> ' : ''}${esc(c.description)}</div>
  ${c.type === 'achat' && c.montant_achat ? `<div class="meta">Avance estimée : ${fcfa(c.montant_achat)} (remboursée par le client)</div>` : ''}`;
}

function carteActive(c) {
  const versDepart = c.statut === 'acceptee';
  const cible = versDepart ? [c.depart_lat, c.depart_lng] : [c.arrivee_lat, c.arrivee_lng];
  const payeEnLigne = c.paiement_statut === 'paye';
  const moyen = c.paiement === 'orange_money' ? 'Orange Money' : 'Wave';
  const achats = c.type === 'achat' ? c.montant_achat : 0;
  const aEncaisser = (payeEnLigne ? 0 : c.prix) + achats;
  let detailEncaisser = '';
  if (payeEnLigne && achats) detailEncaisser = `<br><small>Course déjà payée par ${moyen} · seulement les achats (montant réel du ticket)</small>`;
  else if (c.type === 'achat') detailEncaisser = `<br><small>course ${fcfa(c.prix)} + achats (montant réel du ticket)</small>`;
  const blocEncaisser = payeEnLigne && !achats
    ? `<div class="devis paye-en-ligne" style="margin-top:10px">${ico('circle-check')} Course déjà payée par ${moyen} : <b>rien à encaisser</b></div>`
    : `<div class="devis" style="margin-top:10px">À encaisser : <span class="prix">${fcfa(aEncaisser)}</span>${detailEncaisser}</div>`;
  return `
    <div class="card course-active">
      <h2>Course en cours ${badge(c.statut)}</h2>
      ${frise(c.statut)}
      ${trajet(c)}
      ${blocPersonne(c.client_nom, c.client_tel, c.destinataire_nom || c.destinataire_tel ? 'Client' : 'Client · reçoit la livraison')}
      ${c.destinataire_nom || c.destinataire_tel ? blocPersonne(c.destinataire_nom || 'Destinataire', c.destinataire_tel, 'Destinataire') : ''}
      ${blocEncaisser}
      <div class="actions">
        <button class="btn-primaire" data-guidage>${ico('navigation', 'ic-sm')} Guider jusqu'${versDepart ? 'au départ' : 'à l\'arrivée'}</button>
      </div>
      <a class="lien-secondaire" data-nav="${cible[0]},${cible[1]}" ${lienItineraire(cible[0], cible[1], maPosition)}>Ouvrir dans une autre application GPS</a>
      <div class="actions">
        ${versDepart
          ? `<button class="jaune grand" data-etape="recuperee" data-id="${c.id}">${ico('package')} J'ai récupéré le colis</button>
             <button class="danger" data-etape="liberer" data-id="${c.id}">Me désister</button>`
          : `<button class="jaune grand" data-etape="livree" data-id="${c.id}">${ico('circle-check')} Livraison terminée</button>`}
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
            <span class="prix-course">${fcfa(c.prix)}${c.paiement_statut === 'paye' ? `<br><span class="badge b-livree">Payé en ligne</span>` : ''}</span></div>
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
          <div class="haut">${badge(c.statut)}<span class="prix-course">${fcfa(c.prix)}</span></div>
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
      await api('POST', `/api/livreur/courses/${b.dataset.accepter}/accepter`);
      toast('Course acceptée ! Le guidage vers le départ démarre.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (b.dataset.etape) {
      const msgs = { recuperee: 'Confirmer que vous avez récupéré le colis ?', livree: 'Confirmer la livraison et l\'encaissement ?', liberer: 'Rendre cette course aux autres livreurs ?' };
      if (!confirm(msgs[b.dataset.etape])) return;
      await api('POST', `/api/livreur/courses/${b.dataset.id}/${b.dataset.etape}`);
    } else return;
    chargerTout();
  } catch (err) { toast(err.message, true); chargerTout(); }
});

function afficherApp(u) {
  document.getElementById('auth').hidden = true;
  document.getElementById('deco').hidden = false;
  document.getElementById('deco').onclick = deconnexion;
  document.querySelectorAll('.nom').forEach((n) => { n.textContent = u.nom; });
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
  socket.on('course:maj', chargerTout);
  socket.on('argent:maj', (r) => {
    toast(r.sens === 'paye_au_livreur' ? 'La plateforme vous a versé votre argent. Merci !' : 'Votre versement à la plateforme est bien enregistré. Merci !');
    chargerTout();
  });
  setTimeout(() => { nbAvant = document.querySelectorAll('[data-accepter]').length; }, 1500);
}

(async () => {
  const u = await sessionExistante();
  if (u) afficherApp(u);
  else ecranAuth(document.getElementById('auth'), { titre: 'Recevez les courses de Yène directement sur votre téléphone.' }, afficherApp);
})();
