let filtre = '';

async function chargerStats() {
  const s = await api('GET', '/api/admin/stats');
  const tuiles = [
    [s.en_attente, 'en attente de livreur'],
    [s.en_cours, 'en cours de livraison'],
    [s.livrees_jour, 'livrées aujourd\'hui'],
    [fcfa(s.ca_jour), 'chiffre du jour'],
    [fcfa(s.commission_jour), 'commission du jour'],
    [`${s.livreurs.disponibles} / ${s.livreurs.total}`, 'livreurs disponibles'],
    [s.livreurs.a_valider, 'livreurs à valider'],
    [s.note_moyenne ?? '–', 'note moyenne'],
  ];
  document.getElementById('stats').innerHTML = tuiles
    .map(([v, l]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join('');
}

async function chargerLivreurs() {
  const l = await api('GET', '/api/admin/livreurs');
  document.getElementById('livreurs').innerHTML = `
    <tr><th>Nom</th><th>Téléphone</th><th>État</th><th>Livrées</th><th>Note</th><th></th></tr>
    ${l.map((x) => `<tr>
      <td>${esc(x.nom)}</td>
      <td>${lienTel(x.telephone)}</td>
      <td>${!x.actif ? '<span class="badge b-en_attente">À valider</span>' : x.disponible ? '<span class="badge b-livree">Disponible</span>' : '<span class="badge b-annulee">Hors ligne</span>'}</td>
      <td>${x.nb_livrees}</td>
      <td>${x.note_moyenne ?? '–'}</td>
      <td>${x.actif
        ? `<button class="danger" data-livreur="${x.id}" data-actif="0">Désactiver</button>`
        : `<button class="jaune" data-livreur="${x.id}" data-actif="1">Valider</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="vide">Aucun livreur inscrit.</td></tr>'}`;
}

async function chargerCourses() {
  const c = await api('GET', '/api/admin/courses' + (filtre ? '?statut=' + filtre : ''));
  document.getElementById('courses').innerHTML = `
    <tr><th>#</th><th>Date</th><th>Statut</th><th>Trajet</th><th>Client</th><th>Livreur</th><th>Prix</th></tr>
    ${c.map((x) => `<tr>
      <td>${x.id}</td>
      <td>${dateCourte(x.cree_le)}</td>
      <td>${badge(x.statut)}</td>
      <td><div class="trajet" style="margin:0"><div>${esc(x.depart_repere)}</div><div>${esc(x.arrivee_repere)}</div></div><span class="meta">${ico(x.type === 'achat' ? 'shopping-bag' : 'package', 'ic-sm')} ${esc(x.description)}</span></td>
      <td>${esc(x.client_nom)}<br>${lienTel(x.client_tel)}</td>
      <td>${x.livreur_nom ? `${esc(x.livreur_nom)}<br>${lienTel(x.livreur_tel)}` : '–'}</td>
      <td class="prix-course">${fcfa(x.prix)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="vide">Aucune course.</td></tr>'}`;
}

async function chargerParams() {
  const p = await api('GET', '/api/admin/parametres');
  const f = document.getElementById('f-params');
  for (const [k, v] of Object.entries(p)) if (f[k]) f[k].value = v;
}

const toutCharger = () => Promise.all([chargerStats(), chargerLivreurs(), chargerCourses()]).catch((e) => toast(e.message, true));

document.getElementById('livreurs').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-livreur]');
  if (!b) return;
  try {
    await api('POST', `/api/admin/livreurs/${b.dataset.livreur}/activer`, { actif: b.dataset.actif === '1' });
    toast(b.dataset.actif === '1' ? 'Livreur validé' : 'Livreur désactivé');
    toutCharger();
  } catch (err) { toast(err.message, true); }
});

document.getElementById('filtres').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filtre = b.dataset.statut;
  document.querySelectorAll('#filtres button').forEach((x) => x.classList.toggle('actif', x === b));
  chargerCourses().catch((err) => toast(err.message, true));
});

document.getElementById('f-params').onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    await api('PUT', '/api/admin/parametres', d);
    toast('Réglages enregistrés');
  } catch (err) { toast(err.message, true); }
};

// ---------- Lieux ----------
let carteLieux;
let pointLieu = null;

async function chargerLieuxAdmin() {
  const lieux = (await chargerLieux(true)).filter((l) => l.source === 'admin' || l.source === 'livraison');
  document.getElementById('lieux-admin').innerHTML = `
    <tr><th>Nom</th><th>Catégorie</th><th></th></tr>
    ${lieux.map((l) => `<tr>
      <td><a href="#" data-aller="${l.lat},${l.lng}">${esc(l.nom)}</a></td>
      <td>${ico(ICONES[l.categorie] || 'map-pin', 'ic-sm')} ${esc(NOMS_CATEGORIES[l.categorie] || l.categorie)}</td>
      <td><button class="danger" data-supprimer-lieu="${l.id}">Supprimer</button></td>
    </tr>`).join('') || '<tr><td colspan="3" class="vide">Aucun lieu ajouté pour l\'instant.</td></tr>'}`;
}

const optionsCategories = (choisie) => Object.entries(NOMS_CATEGORIES)
  .map(([v, n]) => `<option value="${v}" ${v === choisie ? 'selected' : ''}>${esc(n)}</option>`).join('');

async function chargerLieuxProposes() {
  const liste = await api('GET', '/api/admin/lieux-proposes');
  const nb = document.getElementById('nb-proposes');
  nb.hidden = !liste.length;
  nb.textContent = liste.length;
  document.getElementById('lieux-proposes').innerHTML = `
    <tr><th>Nom proposé</th><th>Catégorie</th><th>Livraisons</th><th></th></tr>
    ${liste.map((l) => `<tr data-id="${l.id}">
      <td style="min-width:200px"><input value="${esc(l.nom)}" data-nom aria-label="Nom du lieu" style="margin:0"></td>
      <td style="min-width:150px"><select data-cat aria-label="Catégorie" style="margin:0">${optionsCategories(l.categorie)}</select></td>
      <td>${l.vu_fois}</td>
      <td style="white-space:nowrap">
        <button data-voir="${l.lat},${l.lng}" title="Voir sur la carte">${ico('map-pin', 'ic-sm')}</button>
        <button class="ok" data-valider="${l.id}">${ico('check', 'ic-sm')} Valider</button>
        <button class="danger" data-refuser="${l.id}">${ico('x', 'ic-sm')}</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="4" class="vide">Aucun lieu en attente. Ils apparaissent après chaque livraison terminée.</td></tr>'}`;
}

function initLieux() {
  const c = creerCarte('map');
  carteLieux = c.carte;
  carteLieux.on('click', (e) => {
    if (pointLieu) pointLieu.setLatLng(e.latlng);
    else pointLieu = L.marker(e.latlng, { draggable: true }).addTo(carteLieux);
    document.querySelector('#f-lieu [name=nom]').focus();
  });
  brancherRecherche(document.getElementById('recherche'), document.getElementById('suggestions'), (l) => carteLieux.flyTo([l.lat, l.lng], ZOOM_LIEU));
  brancherPleinEcran(document.getElementById('plein-ecran'), document.getElementById('bloc-carte'), carteLieux);

  document.getElementById('f-lieu').onsubmit = async (e) => {
    e.preventDefault();
    if (!pointLieu) return toast('Touchez d\'abord la carte à l\'endroit du lieu', true);
    const d = Object.fromEntries(new FormData(e.target));
    const { lat, lng } = pointLieu.getLatLng();
    try {
      await api('POST', '/api/admin/lieux', { ...d, lat, lng });
      toast(`« ${d.nom} » ajouté`);
      e.target.nom.value = '';
      pointLieu.remove();
      pointLieu = null;
      await c.rafraichir(true);
      chargerLieuxAdmin();
    } catch (err) { toast(err.message, true); }
  };

  document.getElementById('lieux-admin').addEventListener('click', async (e) => {
    const aller = e.target.closest('[data-aller]');
    if (aller) {
      e.preventDefault();
      const [lat, lng] = aller.dataset.aller.split(',').map(Number);
      carteLieux.flyTo([lat, lng], ZOOM_LIEU);
      document.getElementById('bloc-carte').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const b = e.target.closest('[data-supprimer-lieu]');
    if (!b || !confirm('Supprimer ce lieu ?')) return;
    try {
      await api('DELETE', `/api/admin/lieux/${b.dataset.supprimerLieu}`);
      await c.rafraichir(true);
      chargerLieuxAdmin();
    } catch (err) { toast(err.message, true); }
  });
  chargerLieuxAdmin().catch(() => {});

  document.getElementById('lieux-proposes').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const ligne = b.closest('tr');
    try {
      if (b.dataset.voir) {
        const [lat, lng] = b.dataset.voir.split(',').map(Number);
        carteLieux.flyTo([lat, lng], 18);
        L.popup().setLatLng([lat, lng]).setContent(esc(ligne.querySelector('[data-nom]').value)).openOn(carteLieux);
        document.getElementById('bloc-carte').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      if (b.dataset.valider) {
        await api('POST', `/api/admin/lieux/${b.dataset.valider}/valider`, {
          nom: ligne.querySelector('[data-nom]').value,
          categorie: ligne.querySelector('[data-cat]').value,
        });
        toast('Lieu validé : il apparaît maintenant dans la recherche');
      } else if (b.dataset.refuser) {
        await api('DELETE', `/api/admin/lieux/${b.dataset.refuser}`);
        toast('Proposition refusée');
      } else return;
      await c.rafraichir(true);
      chargerLieuxProposes();
      chargerLieuxAdmin();
    } catch (err) { toast(err.message, true); }
  });
  chargerLieuxProposes().catch(() => {});
}

function demarrer() {
  document.getElementById('auth').hidden = true;
  document.getElementById('app').hidden = false;
  initLieux();
  document.getElementById('deco').hidden = false;
  document.getElementById('deco').onclick = deconnexion;
  toutCharger();
  chargerParams().catch(() => {});
  const socket = connecterTempsReel();
  socket.on('courses:changement', toutCharger);
  socket.on('livreurs:changement', toutCharger);
  socket.on('lieux:proposes', () => chargerLieuxProposes().catch(() => {}));
}

(async () => {
  const u = await sessionExistante();
  if (u) demarrer();
  else ecranAuth(document.getElementById('auth'), { inscription: false, titre: 'Espace administrateur' }, demarrer);
})();
