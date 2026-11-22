// Resto OUMY DJIAMIL : affichage du menu, panier, commande livrée par Yobalema Yène.
// Les informations et le menu viennent de la base (modifiables depuis la page admin).
async function demarrer() {
  let donnees;
  try {
    const r = await fetch('/api/resto');
    if (!r.ok) throw new Error();
    donnees = await r.json();
  } catch {
    document.getElementById('carte-menu').innerHTML = '<p class="vide">Le menu ne se charge pas. Vérifiez votre connexion et rechargez la page.</p>';
    return;
  }
  const R = { ...donnees.infos, menu: donnees.menu.map((c) => ({ categorie: c.nom, plats: c.plats.map((p) => ({ ...p, id: String(p.id) })) })) };
  R.position = R.position || { lat: 14.6391, lng: -17.1734 };
  R.horaires = R.horaires || [];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fcfa = (n) => Number(n || 0).toLocaleString('fr-FR') + ' FCFA';
  const tel221 = (t) => '221' + String(t || '').replace(/\D/g, '').replace(/^221/, '');
  const telAffiche = (t) => String(t || '').replace(/\D/g, '').replace(/(\d{2})(\d{3})(\d{2})(\d{2})/, '$1 $2 $3 $4');
  const JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const aujourdhui = JOURS[new Date().getDay()];
  const tousLesPlats = R.menu.flatMap((c) => c.plats);
  const disponible = (p) => p.disponible !== false && (!p.jour || p.jour === aujourdhui) && !R.commandes_fermees;

  // ---------- Informations ----------
  document.title = `${R.nom} · Cuisine sénégalaise à Yène`;
  $('hero-titre').textContent = R.nom;
  $('hero-slogan').textContent = R.slogan;
  $('presentation').textContent = R.presentation;
  $('adresse').textContent = R.adresse;
  $('lien-itineraire').href = `https://www.openstreetmap.org/directions?to=${R.position.lat}%2C${R.position.lng}`;
  $('horaires').innerHTML = R.horaires.map(([j, h]) => `<dt>${esc(j)}</dt><dd>${esc(h)}</dd>`).join('');
  $('lien-tel').href = `tel:+${tel221(R.telephone)}`;
  $('lien-tel').textContent = telAffiche(R.telephone);
  $('nav-appel').href = `tel:+${tel221(R.telephone)}`;
  $('lien-yobalema').href = R.yobalema;
  $('annee').textContent = new Date().getFullYear();

  // Ouvert maintenant ? (lecture simple de « 11 h – 22 h » ; le dimanche a sa propre ligne)
  (() => {
    const ligne = R.horaires.find(([j]) => (new Date().getDay() === 0 ? /dimanche/i.test(j) : !/dimanche/i.test(j)));
    const m = ligne && ligne[1].match(/(\d{1,2})\s*h\s*(\d{2})?\s*[–-]\s*(\d{1,2})\s*h\s*(\d{2})?/);
    const el = $('hero-etat');
    if (!m) { el.hidden = true; return; }
    const min = new Date().getHours() * 60 + new Date().getMinutes();
    const debut = Number(m[1]) * 60 + Number(m[2] || 0);
    const fin = Number(m[3]) * 60 + Number(m[4] || 0);
    const ouvert = min >= debut && min < fin;
    el.classList.toggle('ouvert', ouvert);
    el.textContent = ouvert ? `Ouvert · jusqu'à ${m[3]} h${m[4] || ''}` : `Fermé · ouvre à ${m[1]} h${m[2] || ''}`;
  })();

  // ---------- Panier (gardé sur le téléphone) ----------
  const CLE = 'oumy_panier';
  let panier = {};
  try { panier = JSON.parse(localStorage.getItem(CLE) || '{}') || {}; } catch { panier = {}; }
  for (const id of Object.keys(panier)) {
    const p = tousLesPlats.find((x) => x.id === id);
    if (!p || !disponible(p) || !(panier[id] > 0)) delete panier[id];
  }
  const sauver = () => { try { localStorage.setItem(CLE, JSON.stringify(panier)); } catch { /* navigation privée */ } };
  const lignes = () => Object.entries(panier).map(([id, q]) => ({ p: tousLesPlats.find((x) => x.id === id), q })).filter((l) => l.p);
  const total = () => lignes().reduce((s, l) => s + l.p.prix * l.q, 0);
  const nb = () => lignes().reduce((s, l) => s + l.q, 0);
  function changer(id, delta) {
    panier[id] = Math.max(0, Math.min(20, (panier[id] || 0) + delta));
    if (!panier[id]) delete panier[id];
    sauver();
    majQuantites();
    majPanier();
  }

  // ---------- Menu ----------
  const initiales = (nom) => nom.split(/\s+/).filter((m) => /^[A-Za-zÀ-ÿ]/.test(m)).slice(0, 2).map((m) => m[0]).join('').toUpperCase();
  $('onglets').innerHTML = R.menu.map((c, i) => `<button type="button" class="onglet ${i ? '' : 'actif'}" role="tab" data-cat="cat-${i}">${esc(c.categorie)}</button>`).join('');
  $('carte-menu').innerHTML = R.menu.map((c, i) => `
    <div class="categorie" id="cat-${i}">
      <h3>${esc(c.categorie)}</h3>
      <div class="plats">
        ${c.plats.map((p) => `
        <article class="plat ${disponible(p) ? '' : 'indispo'}" data-id="${esc(p.id)}">
          ${p.photo ? `<img class="plat-photo" src="${esc(p.photo)}" alt="${esc(p.nom)}" loading="lazy">` : `<span class="plat-pastille" aria-hidden="true">${esc(initiales(p.nom))}</span>`}
          <div class="plat-corps">
            <span class="plat-nom">${esc(p.nom)}${p.jour ? `<span class="plat-jour">${esc(p.jour)}</span>` : ''}</span>
            <p class="plat-desc">${esc(p.description || '')}</p>
            <div class="plat-bas">
              <span class="plat-prix">${fcfa(p.prix)}</span>
              ${disponible(p)
                ? `<span class="quantite"><button type="button" class="moins" data-moins="${esc(p.id)}" aria-label="Retirer un ${esc(p.nom)}" hidden>−</button><span data-q="${esc(p.id)}" hidden>0</span><button type="button" data-plus="${esc(p.id)}" aria-label="Ajouter un ${esc(p.nom)}">+</button></span>`
                : `<span class="indispo-texte">${R.commandes_fermees ? '' : p.disponible === false ? 'Épuisé aujourd\x27hui' : `Servi le ${esc(String(p.jour).toLowerCase())}`}</span>`}
            </div>
          </div>
        </article>`).join('')}
      </div>
    </div>`).join('');

  function majQuantites() {
    document.querySelectorAll('[data-q]').forEach((el) => {
      const q = panier[el.dataset.q] || 0;
      el.textContent = q;
      el.hidden = !q;
      el.parentElement.querySelector('[data-moins]').hidden = !q;
    });
  }

  document.addEventListener('click', (e) => {
    const plus = e.target.closest('[data-plus]');
    const moins = e.target.closest('[data-moins]');
    if (plus) changer(plus.dataset.plus, 1);
    if (moins) changer(moins.dataset.moins, -1);
    const onglet = e.target.closest('.onglet');
    if (onglet) $(onglet.dataset.cat).scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (e.target.closest('[data-fermer]')) fermerPanier();
  });

  // onglet actif selon la catégorie visible
  const observateur = new IntersectionObserver((entrees) => {
    for (const en of entrees) {
      if (!en.isIntersecting) continue;
      document.querySelectorAll('.onglet').forEach((o) => o.classList.toggle('actif', o.dataset.cat === en.target.id));
    }
  }, { rootMargin: '-40% 0px -55% 0px' });
  document.querySelectorAll('.categorie').forEach((c) => observateur.observe(c));

  // ---------- Barre et tiroir du panier ----------
  function majPanier() {
    const n = nb();
    $('barre-panier').hidden = !n;
    $('barre-nb').textContent = n;
    $('barre-total').textContent = fcfa(total());
    $('panier-total').textContent = fcfa(total());
    $('panier-liste').innerHTML = n
      ? lignes().map(({ p, q }) => `
        <div class="ligne-panier">
          <span class="nom">${esc(p.nom)}<small>${fcfa(p.prix)} × ${q}</small></span>
          <span class="quantite"><button type="button" class="moins" data-moins="${esc(p.id)}" aria-label="Retirer">−</button><span>${q}</span><button type="button" data-plus="${esc(p.id)}" aria-label="Ajouter">+</button></span>
        </div>`).join('')
      : '<p class="vide">Votre commande est vide.</p>';
    $('btn-livraison').disabled = !n;
    if (!n && !$('tiroir').hidden) fermerPanier();
  }
  function ouvrirPanier() { $('tiroir').hidden = false; document.body.style.overflow = 'hidden'; }
  function fermerPanier() { $('tiroir').hidden = true; document.body.style.overflow = ''; }
  $('barre-panier').onclick = ouvrirPanier;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('tiroir').hidden) fermerPanier(); });

  /** « 2 × Thiéboudienne, 1 × Bissap » (+ la précision du client) */
  function texteCommande() {
    const note = $('panier-note').value.trim();
    return lignes().map(({ p, q }) => `${q} × ${p.nom}`).join(', ') + (note ? ` (${note})` : '');
  }

  // Livraison : on ouvre Yobalema Yène avec la commande déjà remplie.
  // Départ = le restaurant ; le client indique où livrer, voit le prix de la livraison et valide.
  // La commande arrive dans l'espace restaurant de Yobalema (code du restaurant) ; le livreur avance
  // le prix des plats au restaurant et le client le rembourse à la livraison.
  $('btn-livraison').onclick = () => {
    const q = new URLSearchParams({
      restaurant: R.code_yobalema || '',
      resto: R.nom,
      resto_lat: R.position.lat,
      resto_lng: R.position.lng,
      resto_adresse: R.adresse,
      plats: texteCommande(),
      montant: total(),
    });
    location.href = `${R.yobalema.replace(/\/$/, '')}/?${q}`;
  };

  if (R.commandes_fermees) {
    $('hero-etat').hidden = false;
    $('hero-etat').classList.remove('ouvert');
    $('hero-etat').textContent = 'Commandes fermées pour le moment';
  }
  majQuantites();
  majPanier();
}
demarrer();
