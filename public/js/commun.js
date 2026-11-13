// Code partagé par les pages client, livreur et admin.
// Chaque page définit window.ROLE avant de charger ce fichier.

const Stock = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* navigation privée */ } },
};
const CLE_TOKEN = () => 'tt_token_' + window.ROLE;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fcfa = (n) => Number(n || 0).toLocaleString('fr-FR') + ' FCFA';
const dateCourte = (d) => (d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const telAffiche = (t) => (t ? String(t).replace(/(\d{2})(\d{3})(\d{2})(\d{2})/, '$1 $2 $3 $4') : '');
/** Icône Lucide du sprite /icons.svg */
const ico = (nom, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="/icons.svg#${nom}"></use></svg>`;
const lienTel = (t) => (t ? `<a class="tel" href="tel:+221${esc(t)}">${ico('phone', 'ic-sm')} ${esc(telAffiche(t))}</a>` : '');
const initiales = (nom) => String(nom || '?').trim().split(/\s+/).slice(0, 2).map((m) => m[0]).join('').toUpperCase();
/** Bloc « personne » : avatar, nom, rôle, bouton appeler */
const blocPersonne = (nom, tel, role) => `
  <div class="personne">
    <div class="qui"><span class="avatar">${esc(initiales(nom))}</span><span><b>${esc(nom)}</b><small>${esc(role)}</small></span></div>
    ${tel ? `<a class="bouton" href="tel:+221${esc(tel)}">${ico('phone', 'ic-sm')} Appeler</a>` : ''}
  </div>`;
/** Frise des 4 étapes d'une course : faites, en cours, à venir */
function frise(statut) {
  if (statut === 'annulee') return '';
  const ordre = ['en_attente', 'acceptee', 'recuperee', 'livree'];
  const noms = ['Demandée', 'Acceptée', 'Récupérée', 'Livrée'];
  const i = ordre.indexOf(statut);
  return `<ol class="frise">${noms.map((n, k) => {
    const cls = k <= i ? 'fait' : (k === i + 1 ? 'encours' : '');
    return `<li class="${cls}">${n}</li>`;
  }).join('')}</ol>`;
}
/**
 * Lien d'itinéraire adapté à l'appareil (aucun service payant) :
 *  - Android : lien « geo: », le téléphone propose ses applis GPS (Google Maps, OsmAnd, Organic Maps…) ;
 *  - iPhone  : Plans d'Apple ;
 *  - ordinateur : itinéraire OpenStreetMap dans le navigateur (depuis la position connue, sinon le point seul).
 * Renvoie les attributs HTML du lien.
 */
function lienItineraire(lat, lng, origine = null) {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return `href="geo:${lat},${lng}?q=${lat},${lng}"`;
  if (/iPhone|iPad|iPod/i.test(ua)) return `href="https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d" target="_blank" rel="noopener"`;
  const url = origine
    ? `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${origine.lat},${origine.lng};${lat},${lng}`
    : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;
  return `href="${url}" target="_blank" rel="noopener"`;
}

const STATUTS = {
  attente_paiement: 'En attente de paiement',
  en_attente: 'En attente d\'un livreur',
  acceptee: 'Livreur en route vers le départ',
  recuperee: 'Récupéré, en livraison',
  livree: 'Livrée',
  annulee: 'Annulée',
};
const badge = (s) => `<span class="badge b-${s}">${STATUTS[s] || s}</span>`;

async function api(methode, url, corps) {
  const token = Stock.get(CLE_TOKEN());
  const r = await fetch(url, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { deconnexion(); throw new Error('Session expirée'); }
  if (!r.ok) throw new Error(d.erreur || 'Erreur réseau');
  return d;
}

function toast(msg, erreur = false) {
  let pile = document.querySelector('.toasts');
  if (!pile) {
    pile = document.createElement('div');
    pile.className = 'toasts';
    pile.setAttribute('role', 'status');
    pile.setAttribute('aria-live', 'polite');
    document.body.appendChild(pile);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (erreur ? ' erreur' : '');
  t.innerHTML = `${ico(erreur ? 'triangle-alert' : 'circle-check')}<span></span>`;
  t.querySelector('span').textContent = msg;
  pile.appendChild(t);
  while (pile.children.length > 3) pile.firstChild.remove();
  setTimeout(() => { t.classList.add('sort'); setTimeout(() => t.remove(), 220); }, erreur ? 5000 : 3500);
}

function deconnexion() {
  Stock.del(CLE_TOKEN());
  location.reload();
}

/** Formulaire connexion / inscription. onOk(utilisateur) est appelé une fois connecté. */
function ecranAuth(conteneur, { inscription = true, titre = '' } = {}, onOk) {
  let mode = 'connexion';
  const rendre = () => {
    const ins = mode === 'inscription';
    conteneur.innerHTML = `
      <div class="card auth">
        <img class="logo-complet" src="/img/logo.webp" alt="Thiak Thiak Dialaw" width="900" height="600">
        ${titre ? `<p class="sous-titre">${titre}</p>` : ''}
        <h2>${ins ? 'Créer un compte' : 'Connexion'}</h2>
        <form>
          ${ins ? '<label>Nom complet<input name="nom" required autocomplete="name"></label>' : ''}
          <label>Téléphone<input name="telephone" type="tel" required placeholder="77 123 45 67" autocomplete="tel"></label>
          <label>Code PIN (4 chiffres)<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label>
          <button class="primaire">${ins ? 'Créer mon compte' : 'Se connecter'}</button>
        </form>
        ${inscription ? `<p class="lien"><a href="#">${ins ? 'Déjà un compte ? Se connecter' : 'Pas encore de compte ? S\'inscrire'}</a></p>` : ''}
      </div>`;
    const lien = conteneur.querySelector('.lien a');
    if (lien) lien.onclick = (e) => { e.preventDefault(); mode = ins ? 'connexion' : 'inscription'; rendre(); };
    conteneur.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api('POST', '/api/auth/' + mode, { ...d, role: window.ROLE });
        if (r.utilisateur.role !== window.ROLE) {
          throw new Error(`Ce numéro est un compte « ${r.utilisateur.role} », pas « ${window.ROLE} »`);
        }
        Stock.set(CLE_TOKEN(), r.token);
        onOk(r.utilisateur);
      } catch (err) { toast(err.message, true); }
    };
  };
  rendre();
}

/** Démarre la session si un jeton existe déjà. */
async function sessionExistante() {
  if (!Stock.get(CLE_TOKEN())) return null;
  try {
    const u = await api('GET', '/api/auth/moi');
    return u.role === window.ROLE ? u : null;
  } catch { return null; }
}

function connecterTempsReel() {
  // eslint-disable-next-line no-undef
  return io({ auth: { token: Stock.get(CLE_TOKEN()) } });
}

function b64EnOctets(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const brut = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(brut, (c) => c.charCodeAt(0));
}

/** Demande la permission et renvoie l'abonnement push du téléphone (objet JSON). */
async function obtenirAbonnement() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Ce navigateur ne gère pas les notifications. Utilisez Chrome sur Android.');
  }
  if (!window.isSecureContext) throw new Error('Les notifications exigent une adresse en https://');
  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Autorisez les notifications dans les réglages du navigateur');
  const { cle } = await api('GET', '/api/push/cle');
  let ab = await reg.pushManager.getSubscription();
  if (!ab) ab = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64EnOctets(cle) });
  return ab.toJSON();
}

/** Par défaut (livreur, admin) : rattache l'abonnement au compte connecté. La page client remplace cette fonction. */
async function activerNotifications() {
  await api('POST', '/api/auth/push', { abonnement: await obtenirAbonnement() });
}

/** Met à jour l'état du bouton cloche selon la permission actuelle. */
function brancherBoutonNotif(bouton) {
  const maj = () => {
    const ok = 'Notification' in window && Notification.permission === 'granted';
    bouton.innerHTML = ok ? `${ico('bell')} Notifications actives` : `${ico('bell-off')} Activer les notifications`;
    bouton.classList.toggle('ok', ok);
  };
  bouton.onclick = async () => {
    try { await activerNotifications(); toast('Notifications activées'); } catch (e) { toast(e.message, true); }
    maj();
  };
  maj();
  // Réenregistre silencieusement l'abonnement si déjà autorisé
  if ('Notification' in window && Notification.permission === 'granted') activerNotifications().catch(() => {});
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
