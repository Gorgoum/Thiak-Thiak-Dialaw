// Page admin du Resto OUMY DJIAMIL : menu (catégories, plats, photos) et informations du restaurant.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fcfa = (n) => Number(n || 0).toLocaleString('fr-FR') + ' FCFA';
  const CLE = 'oumy_admin';
  let jeton = null;
  try { jeton = localStorage.getItem(CLE); } catch { /* navigation privée */ }
  let donnees = null;

  function toast(texte, erreur = false) {
    const t = $('toast');
    t.textContent = texte;
    t.classList.toggle('erreur-toast', erreur);
    t.hidden = false;
    clearTimeout(toast.minuteur);
    toast.minuteur = setTimeout(() => { t.hidden = true; }, 3500);
  }

  async function api(methode, chemin, corps) {
    const r = await fetch(chemin, {
      method: methode,
      headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: 'Bearer ' + jeton } : {}) },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && chemin !== '/api/admin/connexion') { deconnecter(); throw new Error('Session terminée, reconnectez-vous'); }
    if (!r.ok) throw new Error(d.erreur || 'Erreur, réessayez');
    return d;
  }

  // ---------------------------------------------------------------- connexion
  function afficherEcran() {
    $('ecran-connexion').hidden = !!jeton;
    $('ecran-admin').hidden = !jeton;
    $('nav-admin').hidden = !jeton;
    if (jeton) charger();
  }
  function deconnecter() {
    jeton = null;
    try { localStorage.removeItem(CLE); } catch { /* rien */ }
    afficherEcran();
  }
  $('f-connexion').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('erreur-connexion');
    err.hidden = true;
    try {
      const d = await api('POST', '/api/admin/connexion', { mot_de_passe: e.target.mot_de_passe.value });
      jeton = d.token;
      try { localStorage.setItem(CLE, jeton); } catch { /* rien */ }
      e.target.reset();
      afficherEcran();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  };
  $('deconnexion').onclick = deconnecter;

  // ---------------------------------------------------------------- onglets
  document.querySelectorAll('[data-onglet]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-onglet]').forEach((x) => x.classList.toggle('actif', x === b));
    $('onglet-menu').hidden = b.dataset.onglet !== 'menu';
    $('onglet-resto').hidden = b.dataset.onglet !== 'resto';
  }));

  async function charger() {
    try {
      donnees = await api('GET', '/api/admin/menu');
      afficherMenu();
      remplirResto();
    } catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------- menu
  const initiales = (nom) => nom.split(/\s+/).filter((m) => /^[A-Za-zÀ-ÿ]/.test(m)).slice(0, 2).map((m) => m[0]).join('').toUpperCase();
  function afficherMenu() {
    const cats = donnees.menu;
    $('liste-categories').innerHTML = cats.map((c, i) => `
      <div class="categorie-admin">
        <div class="categorie-tete">
          <h2>${esc(c.nom)}</h2>
          <button type="button" class="petit" data-cat-haut="${c.id}" ${i ? '' : 'disabled'} aria-label="Monter">↑</button>
          <button type="button" class="petit" data-cat-bas="${c.id}" ${i < cats.length - 1 ? '' : 'disabled'} aria-label="Descendre">↓</button>
          <button type="button" class="petit" data-cat-renommer="${c.id}" aria-label="Renommer">✎</button>
          <button type="button" class="petit" data-cat-supprimer="${c.id}" aria-label="Supprimer">🗑</button>
        </div>
        ${c.plats.map((p, j) => `
          <div class="plat-admin ${p.disponible ? '' : 'epuise'}">
            ${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<span class="vignette">${esc(initiales(p.nom))}</span>`}
            <span class="infos-plat"><b>${esc(p.nom)}</b><small>${fcfa(p.prix)}${p.jour ? ` · ${esc(p.jour)}` : ''}</small></span>
            <button type="button" class="etat ${p.disponible ? '' : 'non'}" data-dispo="${p.id}" data-valeur="${p.disponible ? 0 : 1}">${p.disponible ? 'Disponible' : 'Épuisé'}</button>
            <span class="actions-plat">
              <button type="button" class="petit ordre" data-plat-haut="${p.id}" ${j ? '' : 'disabled'} aria-label="Monter">↑</button>
              <button type="button" class="petit ordre" data-plat-bas="${p.id}" ${j < c.plats.length - 1 ? '' : 'disabled'} aria-label="Descendre">↓</button>
              <button type="button" class="petit" data-plat-modifier="${p.id}" aria-label="Modifier">✎</button>
            </span>
          </div>`).join('') || '<p class="aide">Aucun plat dans cette catégorie.</p>'}
        <button type="button" class="lien-bouton ajouter-plat" data-plat-ajouter="${c.id}">+ Ajouter un plat</button>
      </div>`).join('') || '<p class="aide">Aucune catégorie. Commencez par en ajouter une (ex. : Plats, Boissons).</p>';
  }

  const action = async (fn, message) => {
    try { await fn(); if (message) toast(message); await charger(); } catch (e) { toast(e.message, true); }
  };
  $('liste-categories').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.catHaut) action(() => api('POST', `/api/admin/categories/${d.catHaut}/deplacer`, { sens: 'haut' }));
    else if (d.catBas) action(() => api('POST', `/api/admin/categories/${d.catBas}/deplacer`, { sens: 'bas' }));
    else if (d.catRenommer) {
      const c = donnees.menu.find((x) => x.id === Number(d.catRenommer));
      const nom = prompt('Nouveau nom de la catégorie :', c.nom);
      if (nom && nom.trim()) action(() => api('PUT', `/api/admin/categories/${c.id}`, { nom }), 'Catégorie renommée');
    } else if (d.catSupprimer) {
      const c = donnees.menu.find((x) => x.id === Number(d.catSupprimer));
      if (confirm(`Supprimer la catégorie « ${c.nom} » ?`)) action(() => api('DELETE', `/api/admin/categories/${c.id}`), 'Catégorie supprimée');
    } else if (d.platHaut) action(() => api('POST', `/api/admin/plats/${d.platHaut}/deplacer`, { sens: 'haut' }));
    else if (d.platBas) action(() => api('POST', `/api/admin/plats/${d.platBas}/deplacer`, { sens: 'bas' }));
    else if (d.dispo) action(() => api('POST', `/api/admin/plats/${d.dispo}/disponible`, { disponible: d.valeur === '1' }), d.valeur === '1' ? 'Plat de nouveau disponible' : 'Plat marqué épuisé');
    else if (d.platModifier) ouvrirPlat(Number(d.platModifier));
    else if (d.platAjouter) ouvrirPlat(null, Number(d.platAjouter));
  });
  $('ajouter-categorie').onclick = () => {
    const nom = prompt('Nom de la nouvelle catégorie (ex. : Boissons) :');
    if (nom && nom.trim()) action(() => api('POST', '/api/admin/categories', { nom }), 'Catégorie ajoutée');
  };

  // ---------------------------------------------------------------- plat
  let platOuvert = null;   // id du plat modifié (null : nouveau plat)
  let nouvellePhoto = null; // JPEG réduit en attente d'enregistrement (data:…)
  let retirerPhoto = false;
  const tousLesPlats = () => donnees.menu.flatMap((c) => c.plats.map((p) => ({ ...p, categorie_id: c.id })));

  function ouvrirPlat(id, categorieId) {
    const f = $('f-plat');
    const p = id ? tousLesPlats().find((x) => x.id === id) : null;
    platOuvert = id;
    nouvellePhoto = null;
    retirerPhoto = false;
    $('titre-plat').textContent = p ? 'Modifier le plat' : 'Nouveau plat';
    f.categorie_id.innerHTML = donnees.menu.map((c) => `<option value="${c.id}">${esc(c.nom)}</option>`).join('');
    f.nom.value = p ? p.nom : '';
    f.description.value = p ? p.description : '';
    f.prix.value = p ? p.prix : '';
    f.jour.value = p && p.jour ? p.jour : '';
    f.categorie_id.value = String(p ? p.categorie_id : categorieId);
    f.disponible.checked = p ? p.disponible : true;
    montrerPhoto(p && p.photo);
    $('supprimer-plat').hidden = !p;
    $('tiroir-plat').hidden = false;
    setTimeout(() => f.nom.focus(), 50);
  }
  function fermerPlat() { $('tiroir-plat').hidden = true; }
  function montrerPhoto(src) {
    $('photo-apercu').hidden = !src;
    if (src) $('photo-apercu').src = src;
    $('photo-vide').hidden = !!src;
    $('photo-retirer').hidden = !src;
  }
  document.addEventListener('click', (e) => { if (e.target.closest('#tiroir-plat [data-fermer]')) fermerPlat(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerPlat(); });

  /** Photo du téléphone réduite à 900 px (JPEG ~150 Ko) avant l'envoi. */
  function reduirePhoto(fichier) {
    return new Promise((ok, ko) => {
      const img = new Image();
      const url = URL.createObjectURL(fichier);
      img.onload = () => {
        const max = 900;
        const r = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * r);
        c.height = Math.round(img.height * r);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('Image illisible')); };
      img.src = url;
    });
  }
  $('photo-fichier').onchange = async (e) => {
    const fichier = e.target.files[0];
    e.target.value = '';
    if (!fichier) return;
    try {
      nouvellePhoto = await reduirePhoto(fichier);
      retirerPhoto = false;
      montrerPhoto(nouvellePhoto);
    } catch (x) { toast(x.message, true); }
  };
  $('photo-retirer').onclick = () => { nouvellePhoto = null; retirerPhoto = true; montrerPhoto(null); };

  $('f-plat').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const corps = {
      nom: f.nom.value, description: f.description.value, prix: Number(f.prix.value),
      jour: f.jour.value || null, categorie_id: Number(f.categorie_id.value), disponible: f.disponible.checked,
    };
    const bouton = f.querySelector('[type=submit]');
    bouton.disabled = true;
    try {
      let id = platOuvert;
      if (id) await api('PUT', `/api/admin/plats/${id}`, corps);
      else id = (await api('POST', '/api/admin/plats', corps)).id;
      if (nouvellePhoto) await api('PUT', `/api/admin/plats/${id}/photo`, { photo: nouvellePhoto });
      else if (retirerPhoto) await api('DELETE', `/api/admin/plats/${id}/photo`);
      fermerPlat();
      toast(platOuvert ? 'Plat enregistré' : 'Plat ajouté');
      await charger();
    } catch (x) { toast(x.message, true); } finally { bouton.disabled = false; }
  };
  $('supprimer-plat').onclick = () => {
    const p = tousLesPlats().find((x) => x.id === platOuvert);
    if (!p || !confirm(`Supprimer « ${p.nom} » du menu ?`)) return;
    action(async () => { await api('DELETE', `/api/admin/plats/${p.id}`); fermerPlat(); }, 'Plat supprimé');
  };

  // ---------------------------------------------------------------- restaurant
  const ligneHoraire = (j = '', h = '') => `
    <div class="grille-2 ligne-horaire">
      <label class="champ">Jours<input value="${esc(j)}" placeholder="Lundi – Samedi"></label>
      <label class="champ">Heures<input value="${esc(h)}" placeholder="11 h – 22 h"></label>
    </div>`;
  function remplirResto() {
    const i = donnees.infos || {};
    const f = $('f-resto');
    for (const k of ['nom', 'slogan', 'presentation', 'telephone', 'code_yobalema', 'adresse', 'yobalema']) f[k].value = i[k] || '';
    f.lat.value = i.position ? i.position.lat : '';
    f.lng.value = i.position ? i.position.lng : '';
    f.commandes_fermees.checked = !!i.commandes_fermees;
    $('horaires').innerHTML = (i.horaires && i.horaires.length ? i.horaires : [['', '']]).map(([j, h]) => ligneHoraire(j, h)).join('');
    majLienPosition();
  }
  function majLienPosition() {
    const f = $('f-resto');
    $('voir-position').href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(f.lat.value)}&mlon=${encodeURIComponent(f.lng.value)}#map=18/${encodeURIComponent(f.lat.value)}/${encodeURIComponent(f.lng.value)}`;
  }
  $('f-resto').addEventListener('input', (e) => { if (['lat', 'lng'].includes(e.target.name)) majLienPosition(); });
  $('ajouter-horaire').onclick = () => $('horaires').insertAdjacentHTML('beforeend', ligneHoraire());
  $('ma-position').onclick = () => {
    if (!navigator.geolocation) return toast('Ce navigateur ne donne pas la position', true);
    const b = $('ma-position');
    b.disabled = true;
    navigator.geolocation.getCurrentPosition((p) => {
      b.disabled = false;
      $('f-resto').lat.value = p.coords.latitude.toFixed(6);
      $('f-resto').lng.value = p.coords.longitude.toFixed(6);
      majLienPosition();
      toast(`Position prise (±${Math.round(p.coords.accuracy)} m). Pensez à enregistrer.`);
    }, () => { b.disabled = false; toast('Position introuvable : activez la localisation du téléphone.', true); }, { enableHighAccuracy: true, timeout: 15000 });
  };
  $('f-resto').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const horaires = [...document.querySelectorAll('.ligne-horaire')].map((l) => [...l.querySelectorAll('input')].map((x) => x.value));
    const corps = {
      nom: f.nom.value, slogan: f.slogan.value, presentation: f.presentation.value,
      telephone: f.telephone.value, code_yobalema: f.code_yobalema.value, adresse: f.adresse.value,
      position: { lat: Number(String(f.lat.value).replace(',', '.')), lng: Number(String(f.lng.value).replace(',', '.')) },
      horaires, yobalema: f.yobalema.value, commandes_fermees: f.commandes_fermees.checked,
    };
    try {
      donnees.infos = await api('PUT', '/api/admin/infos', corps);
      remplirResto();
      toast('Informations enregistrées');
    } catch (x) { toast(x.message, true); }
  };

  afficherEcran();
})();
