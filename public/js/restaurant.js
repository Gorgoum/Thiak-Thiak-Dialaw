// Espace restaurant : les commandes de plats arrivent ici (passées depuis le site du restaurant, livrées par Yobalema).
// Le restaurant voit les plats, suit le livreur et appuie sur « Plats prêts » quand c'est cuisiné.
/* global api, toast, esc, fcfa, ico, Stock, CLE_TOKEN, initiales, surveillerMiseAJour */
const $ = (id) => document.getElementById(id);
const ACTIFS = ['en_attente', 'attente_paiement', 'acceptee', 'recuperee'];
let connues = null; // numéros des commandes déjà vues (pour sonner à l'arrivée d'une nouvelle)
let contexteAudio = null;

// ---------------------------------------------------------------- son et vibration à chaque nouvelle commande
function preparerSon() {
  try {
    contexteAudio = contexteAudio || new (window.AudioContext || window.webkitAudioContext)();
    if (contexteAudio.state === 'suspended') contexteAudio.resume();
  } catch { contexteAudio = null; }
  $('btn-son').hidden = !contexteAudio || contexteAudio.state === 'running';
}
function sonner() {
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  if (!contexteAudio || contexteAudio.state !== 'running') return;
  // trois « ding » montants
  [0, 0.35, 0.7].forEach((t, i) => {
    const o = contexteAudio.createOscillator();
    const g = contexteAudio.createGain();
    o.frequency.value = [880, 1046, 1318][i];
    g.gain.setValueAtTime(0.0001, contexteAudio.currentTime + t);
    g.gain.exponentialRampToValueAtTime(0.4, contexteAudio.currentTime + t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, contexteAudio.currentTime + t + 0.3);
    o.connect(g).connect(contexteAudio.destination);
    o.start(contexteAudio.currentTime + t);
    o.stop(contexteAudio.currentTime + t + 0.32);
  });
}
document.addEventListener('pointerdown', preparerSon, { once: true });
$('btn-son').onclick = () => { preparerSon(); sonner(); };

// ---------------------------------------------------------------- connexion
$('f-connexion').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/restaurant/connexion', Object.fromEntries(new FormData(e.target)));
    Stock.set(CLE_TOKEN(), r.token);
    preparerSon();
    demarrer();
  } catch (err) { toast(err.message, true); }
};
$('deco').onclick = () => { Stock.del(CLE_TOKEN()); location.reload(); };

// ---------------------------------------------------------------- commandes
const heure = (d) => (d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');

/** Où en est la commande, du point de vue du restaurant. */
function etape(c) {
  if (c.statut === 'annulee') return { texte: 'Annulée', classe: 'annulee' };
  if (c.statut === 'livree') return { texte: `Livrée à ${heure(c.livree_le)}`, classe: 'livree' };
  if (c.statut === 'recuperee') return { texte: `Partie avec ${esc(c.livreur_nom || 'le livreur')} à ${heure(c.recuperee_le)}`, classe: 'recuperee' };
  if (c.statut === 'acceptee' && c.arrive_le) return { texte: `${esc(c.livreur_nom || 'Le livreur')} est arrivé au restaurant`, classe: 'arrive' };
  if (c.statut === 'acceptee') return { texte: `${esc(c.livreur_nom || 'Un livreur')} arrive pour récupérer`, classe: 'acceptee' };
  return { texte: 'Recherche d\'un livreur…', classe: 'en_attente' };
}

function carte(c) {
  const e = etape(c);
  const enCours = ACTIFS.includes(c.statut);
  const plats = String(c.description || '').split(/,\s*/).map((p) => `<li>${esc(p)}</li>`).join('');
  const tel = String(c.livreur_tel || '').replace(/\D/g, '');
  return `
    <article class="card commande-resto ${enCours ? '' : 'passee'}">
      <header class="commande-tete">
        <b>Commande n° ${c.id}</b>
        <span class="meta">${heure(c.cree_le)}${c.client_prenom ? ` · pour ${esc(c.client_prenom)}` : ''}</span>
      </header>
      <ul class="plats-commande">${plats}</ul>
      <div class="commande-total">Le livreur vous remet : <b>${fcfa(c.montant_achat - (c.commission_resto || 0))}</b>${c.commission_resto ? `<br><small class="meta">Plats ${fcfa(c.montant_achat)} − commission Yobalema ${fcfa(c.commission_resto)}</small>` : ''}</div>
      <div class="etape-resto ${e.classe}">${e.texte}</div>
      ${enCours && c.statut !== 'recuperee' ? (c.plats_prets_le
        ? `<div class="prets-ok">${ico('circle-check', 'ic-sm')} Plats prêts depuis ${heure(c.plats_prets_le)}</div>`
        : `<button class="primaire" data-prets="${c.id}">${ico('check')} Plats prêts</button>`) : ''}
      ${enCours && tel ? `<a class="bouton" href="tel:${tel}">${ico('phone', 'ic-sm')} Appeler ${esc(c.livreur_nom || 'le livreur')}</a>` : ''}
    </article>`;
}

async function charger() {
  let liste;
  try { liste = await api('GET', '/api/restaurant/commandes'); } catch (err) { toast(err.message, true); return; }
  const enCours = liste.filter((c) => ACTIFS.includes(c.statut));
  const passees = liste.filter((c) => !ACTIFS.includes(c.statut));
  // nouvelle commande depuis le dernier passage : son, vibration, titre de l'onglet
  const nouvelles = connues ? enCours.filter((c) => !connues.has(c.id)) : [];
  connues = new Set(liste.map((c) => c.id));
  if (nouvelles.length) {
    sonner();
    toast(nouvelles.length > 1 ? `${nouvelles.length} nouvelles commandes !` : `Nouvelle commande : ${nouvelles[0].description}`);
  }
  document.title = enCours.length ? `(${enCours.length}) Yobalema Restaurant` : 'Yobalema Restaurant';
  $('nb-cours').hidden = !enCours.length;
  $('nb-cours').textContent = enCours.length;
  $('en-cours').innerHTML = enCours.map(carte).join('') || '<p class="vide">Aucune commande en cours. Elles s\'afficheront ici, avec une sonnerie.</p>';
  $('historique').innerHTML = passees.map(carte).join('') || '<p class="vide">Rien pour le moment.</p>';
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-prets]');
  if (!b) return;
  b.disabled = true;
  try {
    await api('POST', `/api/restaurant/commandes/${b.dataset.prets}/prets`);
    toast('Le livreur est prévenu que les plats sont prêts.');
    charger();
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

async function demarrer() {
  let moi;
  try { moi = await api('GET', '/api/restaurant/moi'); } catch { moi = null; }
  if (!moi) { Stock.del(CLE_TOKEN()); $('auth').hidden = false; $('app').hidden = true; return; }
  $('auth').hidden = true;
  $('app').hidden = false;
  $('deco').hidden = false;
  $('nom-resto').textContent = moi.nom;
  $('avatar').textContent = initiales(moi.nom);
  preparerSon();
  await charger();
  setInterval(charger, 15000); // nouvelles commandes toutes les 15 s
  document.addEventListener('visibilitychange', () => { if (!document.hidden) charger(); });
}

if (Stock.get(CLE_TOKEN())) demarrer();
else $('auth').hidden = false;
surveillerMiseAJour(() => true);
