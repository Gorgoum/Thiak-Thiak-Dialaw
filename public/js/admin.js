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

let livreurs = []; // derniers livreurs chargés (pour les fenêtres « Modifier » et « Attribuer »)
let courses = new Map();

async function chargerLivreurs() {
  livreurs = await api('GET', '/api/admin/livreurs');
  document.getElementById('livreurs').innerHTML = `
    <tr><th>Nom</th><th>Actions</th><th>Téléphone</th><th>État</th><th>Livrées</th><th>Note</th></tr>
    ${livreurs.map((x) => `<tr>
      <td><b>${esc(x.nom)}</b></td>
      <td class="actions-ligne">${x.actif
        ? `<button data-livreur="${x.id}" data-actif="0">${ico('power', 'ic-sm')} Désactiver</button>`
        : `<button class="jaune" data-livreur="${x.id}" data-actif="1">${ico('check', 'ic-sm')} Valider</button>`}
        <button data-modifier-livreur="${x.id}">${ico('settings', 'ic-sm')} Modifier</button>
        <button class="danger" data-supprimer-livreur="${x.id}" aria-label="Supprimer ${esc(x.nom)}">${ico('trash-2', 'ic-sm')}</button></td>
      <td>${lienTel(x.telephone)}</td>
      <td>${!x.actif ? '<span class="badge b-en_attente">À valider</span>' : x.disponible ? '<span class="badge b-livree">Disponible</span>' : '<span class="badge b-annulee">Hors ligne</span>'}</td>
      <td>${x.nb_livrees}</td>
      <td>${x.note_moyenne ?? '–'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="vide">Aucun livreur inscrit.</td></tr>'}`;
}

async function chargerCourses() {
  const c = await api('GET', '/api/admin/courses' + (filtre ? '?statut=' + filtre : ''));
  courses = new Map(c.map((x) => [x.id, x]));
  document.getElementById('courses').innerHTML = `
    <tr><th>#</th><th></th><th>Date</th><th>Statut</th><th>Trajet</th><th>Client</th><th>Livreur</th><th>Prix</th></tr>
    ${c.map((x) => `<tr class="ligne-cliquable" data-gerer-course="${x.id}">
      <td>${x.id}</td>
      <td><button data-gerer-course="${x.id}">${ico('settings', 'ic-sm')} Gérer</button></td>
      <td>${dateCourte(x.cree_le)}</td>
      <td>${badge(x.statut)}</td>
      <td><div class="trajet" style="margin:0"><div>${esc(x.depart_repere)}</div><div>${esc(x.arrivee_repere)}</div></div><span class="meta">${ico(x.type === 'achat' ? 'shopping-bag' : 'package', 'ic-sm')} ${esc(x.description)}</span></td>
      <td>${esc(x.client_nom)}<br>${lienTel(x.client_tel)}</td>
      <td>${x.livreur_nom ? `${esc(x.livreur_nom)}<br>${lienTel(x.livreur_tel)}` : '–'}</td>
      <td class="prix-course">${fcfa(x.prix)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="vide">Aucune course.</td></tr>'}`;
}

async function chargerAdmins() {
  const l = await api('GET', '/api/admin/admins');
  document.getElementById('admins').innerHTML = `
    <tr><th>Nom</th><th>Téléphone</th><th>Actions</th></tr>
    ${l.map((x) => `<tr>
      <td>${esc(x.nom)}${x.moi ? ' <span class="badge b-livree">Vous</span>' : ''}</td>
      <td>${lienTel(x.telephone)}</td>
      <td class="actions-ligne">
        <button data-modifier-admin="${x.id}" data-nom="${esc(x.nom)}" data-tel="${esc(x.telephone)}">${ico('settings', 'ic-sm')} Modifier</button>
        ${x.moi ? '' : `<button class="danger" data-supprimer-admin="${x.id}" aria-label="Supprimer ${esc(x.nom)}">${ico('trash-2', 'ic-sm')}</button>`}</td>
    </tr>`).join('')}`;
}

// =========================================================================
// Fenêtre de modification
// =========================================================================
const fenetre = document.getElementById('fenetre');
let surEnregistrer = null;

/** Ouvre la fenêtre : titre, contenu HTML, action du bouton Enregistrer (null = pas de bouton). */
function ouvrirFenetre(titre, contenu, enregistrer, libelle = 'Enregistrer') {
  document.getElementById('fenetre-titre').textContent = titre;
  document.getElementById('fenetre-corps').innerHTML = contenu;
  const ok = document.getElementById('fenetre-ok');
  ok.hidden = !enregistrer;
  ok.textContent = libelle;
  surEnregistrer = enregistrer;
  fenetre.showModal();
  const premier = fenetre.querySelector('.fenetre-corps input, .fenetre-corps select');
  if (premier) premier.focus();
}
const fermerFenetre = () => fenetre.close();
fenetre.addEventListener('click', (e) => {
  if (e.target === fenetre || e.target.closest('[data-fermer-fenetre]')) fermerFenetre();
});
document.getElementById('fenetre-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!surEnregistrer) return;
  const d = Object.fromEntries(new FormData(e.target));
  const ok = document.getElementById('fenetre-ok');
  ok.disabled = true;
  try {
    await surEnregistrer(d);
    fermerFenetre();
  } catch (err) { toast(err.message, true); } finally { ok.disabled = false; }
});

const champ = (label, nom, valeur = '', attrs = '') => `<label>${label}<input name="${nom}" value="${esc(valeur ?? '')}" ${attrs}></label>`;
const champsCompte = (u = {}) => `
  ${champ('Nom complet', 'nom', u.nom, 'required maxlength="100" autocomplete="off"')}
  ${champ('Téléphone', 'telephone', u.telephone, 'required type="tel" inputmode="tel" placeholder="77 123 45 67"')}
  ${champ(u.id ? 'Nouveau code PIN (laisser vide pour ne pas changer)' : 'Code PIN (4 chiffres)', 'pin', '',
    `${u.id ? '' : 'required'} inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="new-password"`)}`;

function fenetreCompte(role, u = null) {
  const qui = role === 'admin' ? 'administrateur' : 'livreur';
  const route = role === 'admin' ? '/api/admin/admins' : '/api/admin/livreurs';
  ouvrirFenetre(u ? `Modifier le ${qui}` : `Ajouter un ${qui}`, champsCompte(u || {}), async (d) => {
    if (u) await api('PUT', `${route}/${u.id}`, d);
    else await api('POST', route, d);
    toast(u ? 'Modifications enregistrées' : `${d.nom} ajouté. Donnez-lui son numéro et son code PIN pour se connecter.`);
    toutCharger();
  }, u ? 'Enregistrer' : 'Ajouter');
}

// ---------- Gérer une course ----------
function fenetreCourse(x) {
  const enCours = ['acceptee', 'recuperee'].includes(x.statut);
  const finie = ['livree', 'annulee'].includes(x.statut);
  const libres = livreurs.filter((l) => l.actif);
  const actions = [];
  if (['en_attente', 'acceptee'].includes(x.statut) && libres.length) {
    actions.push(`<div class="ligne-action">
      <select id="choix-livreur" aria-label="Livreur">${libres.map((l) => `<option value="${l.id}" ${l.id === x.livreur_id ? 'selected' : ''}>${esc(l.nom)}${l.disponible ? ' · disponible' : ''}</option>`).join('')}</select>
      <button type="button" data-action="attribuer">${ico('bike', 'ic-sm')} ${x.livreur_id ? 'Changer de livreur' : 'Attribuer'}</button></div>`);
  }
  if (enCours) {
    actions.push(`<button type="button" data-action="liberer">${ico('undo-2', 'ic-sm')} Remettre en attente (retirer le livreur)</button>`);
    actions.push(`<button type="button" class="ok" data-action="terminer">${ico('circle-check', 'ic-sm')} Marquer comme livrée</button>`);
  }
  // Paiement en ligne pas encore confirmé : vérifier chez Nangu ou valider à la main
  const enLigne = x.paiement !== 'especes';
  const moyen = x.paiement === 'wave' ? 'Wave' : 'Orange Money';
  const etatsPaiement = { paye: 'payé', en_attente: 'en attente', expire: 'expiré', annule: 'annulé', a_la_livraison: 'à la livraison' };
  const blocPaiement = enLigne ? `
    <div class="bloc-paiement ${x.paiement_statut === 'paye' ? 'paye' : ''}">
      <div><b>${ico(x.paiement_statut === 'paye' ? 'circle-check' : 'wallet', 'ic-sm')} Paiement ${moyen} : ${etatsPaiement[x.paiement_statut] || x.paiement_statut}</b>
        <small>${fcfa(x.montant_du || x.prix)}${x.paye_le ? ` · reçu le ${dateCourte(x.paye_le)}` : ''}</small></div>
      ${x.paiement_statut === 'paye' ? '' : `
        <button type="button" data-action="rapprocher">${ico('refresh-cw', 'ic-sm')} Vérifier auprès de Nangu</button>
        <button type="button" class="ok" data-action="valider-paiement">${ico('check', 'ic-sm')} Valider le paiement manuellement</button>`}
    </div>` : '';
  if (!finie) actions.push(`<button type="button" class="danger" data-action="annuler">${ico('circle-x', 'ic-sm')} Annuler la course</button>`);
  if (!enCours) actions.push(`<button type="button" class="danger" data-action="supprimer">${ico('trash-2', 'ic-sm')} Supprimer définitivement</button>`);

  ouvrirFenetre(`Course n° ${x.id}`, `
    <p class="meta" style="margin:0 0 12px">${badge(x.statut)} · ${dateCourte(x.cree_le)} · ${Number(x.distance_km).toLocaleString('fr-FR')} km
      ${enLigne ? '' : ' · espèces à la livraison'}</p>
    <div class="actions-course">${blocPaiement}${actions.join('')}</div>
    <h3 class="sous-titre-fenetre">Modifier les informations</h3>
    ${champ('Départ', 'depart_repere', x.depart_repere, 'required maxlength="300"')}
    ${champ('Arrivée', 'arrivee_repere', x.arrivee_repere, 'required maxlength="300"')}
    ${champ('À livrer', 'description', x.description, 'required maxlength="500"')}
    ${champ('Prix (FCFA)', 'prix', x.prix, 'required type="number" min="0" step="50"')}
    <div class="grille-2">
      ${champ('Nom du client', 'client_nom', x.client_nom, 'maxlength="100"')}
      ${champ('Téléphone du client', 'client_tel', x.client_tel, 'required type="tel"')}
      ${champ('Nom du destinataire', 'destinataire_nom', x.destinataire_nom, 'maxlength="100"')}
      ${champ('Téléphone du destinataire', 'destinataire_tel', x.destinataire_tel, 'type="tel"')}
    </div>`, async (d) => {
    await api('PUT', `/api/admin/courses/${x.id}`, d);
    toast('Course modifiée');
    toutCharger();
  });

  document.querySelector('#fenetre-corps .actions-course').onclick = async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action;
    const questions = {
      liberer: 'Retirer le livreur et proposer de nouveau cette course aux autres livreurs ?',
      terminer: 'Marquer cette course comme livrée ?',
      annuler: `Annuler la course n° ${x.id} ? Le client sera prévenu.`,
      supprimer: `Supprimer définitivement la course n° ${x.id} ? Elle disparaîtra aussi des statistiques.`,
    };
    if (questions[a] && !confirm(questions[a])) return;
    let reference = '';
    if (a === 'valider-paiement') {
      reference = prompt(`Valider à la main le paiement ${moyen} de ${fcfa(x.montant_du || x.prix)} ?\n\nFaites-le seulement si vous avez vu l'argent arriver sur le compte ${moyen}. La course sera proposée aux livreurs.\n\nRéférence de la transaction (facultatif) :`, '');
      if (reference === null) return; // « Annuler » : rien n'est fait
    }
    b.disabled = true;
    try {
      if (a === 'rapprocher') {
        const r = await api('POST', `/api/admin/courses/${x.id}/rapprocher`);
        const lisible = { succeeded: 'payé', pending: 'pas encore payé', processing: 'en cours de traitement', expired: 'expiré', canceled: 'annulé' }[r.statut_nangu] || r.statut_nangu;
        toast(`Nangu indique : ${lisible}.${r.change ? ' La course est mise à jour.' : ''}`, r.statut_nangu !== 'succeeded');
        fermerFenetre();
        toutCharger();
        return;
      }
      if (a === 'valider-paiement') {
        await api('POST', `/api/admin/courses/${x.id}/valider-paiement`, { reference });
        toast('Paiement validé. La course est proposée aux livreurs.');
      } else if (a === 'attribuer') {
        await api('POST', `/api/admin/courses/${x.id}/attribuer`, { livreur_id: Number(document.getElementById('choix-livreur').value) });
        toast('Course attribuée : le livreur est prévenu');
      } else if (a === 'supprimer') {
        await api('DELETE', `/api/admin/courses/${x.id}`);
        toast('Course supprimée');
      } else {
        const r = await api('POST', `/api/admin/courses/${x.id}/${a}`);
        toast({ liberer: 'Course remise en attente', terminer: 'Course marquée livrée', annuler: 'Course annulée' }[a]);
        if (r && r.a_rembourser) toast('Cette course était déjà payée en ligne : pensez à rembourser le client.', true);
      }
      fermerFenetre();
      toutCharger();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  };
}

async function chargerParams() {
  const p = await api('GET', '/api/admin/parametres');
  const f = document.getElementById('f-params');
  for (const [k, v] of Object.entries(p)) if (f[k]) f[k].value = v;
}

const toutCharger = () => Promise.all([chargerStats(), chargerLivreurs(), chargerCourses(), chargerAdmins()]).catch((e) => toast(e.message, true));

document.getElementById('livreurs').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.livreur) {
      await api('POST', `/api/admin/livreurs/${b.dataset.livreur}/activer`, { actif: b.dataset.actif === '1' });
      toast(b.dataset.actif === '1' ? 'Livreur validé' : 'Livreur désactivé');
    } else if (b.dataset.modifierLivreur) {
      fenetreCompte('livreur', livreurs.find((l) => l.id === Number(b.dataset.modifierLivreur)));
      return;
    } else if (b.dataset.supprimerLivreur) {
      const l = livreurs.find((x) => x.id === Number(b.dataset.supprimerLivreur));
      if (!confirm(`Supprimer définitivement ${l.nom} ?\n\nSes anciennes courses restent, sans nom de livreur. Pour garder l'historique, préférez « Désactiver ».`)) return;
      await api('DELETE', `/api/admin/livreurs/${l.id}`);
      toast('Livreur supprimé');
    } else return;
    toutCharger();
  } catch (err) { toast(err.message, true); }
});
document.getElementById('ajout-livreur').onclick = () => fenetreCompte('livreur');
document.getElementById('ajout-admin').onclick = () => fenetreCompte('admin');

document.getElementById('courses').addEventListener('click', (e) => {
  if (e.target.closest('a')) return; // un toucher sur un numéro lance l'appel, sans ouvrir la fenêtre
  const b = e.target.closest('[data-gerer-course]');
  if (b) fenetreCourse(courses.get(Number(b.dataset.gererCourse)));
});

document.getElementById('admins').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.modifierAdmin) {
      fenetreCompte('admin', { id: Number(b.dataset.modifierAdmin), nom: b.dataset.nom, telephone: b.dataset.tel });
      return;
    }
    if (b.dataset.supprimerAdmin) {
      if (!confirm('Retirer cet administrateur ? Il ne pourra plus se connecter.')) return;
      await api('DELETE', `/api/admin/admins/${b.dataset.supprimerAdmin}`);
      toast('Administrateur retiré');
      chargerAdmins();
    }
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
      <td class="actions-ligne">
        <button data-modifier-lieu="${l.id}" data-nom="${esc(l.nom)}" data-cat="${esc(l.categorie)}">${ico('settings', 'ic-sm')} Modifier</button>
        <button class="danger" data-supprimer-lieu="${l.id}" aria-label="Supprimer ${esc(l.nom)}">${ico('trash-2', 'ic-sm')}</button></td>
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
    const m = e.target.closest('[data-modifier-lieu]');
    if (m) {
      ouvrirFenetre('Modifier le lieu', `
        ${champ('Nom du lieu', 'nom', m.dataset.nom, 'required maxlength="120"')}
        <label>Catégorie<select name="categorie">${optionsCategories(m.dataset.cat)}</select></label>`, async (d) => {
        await api('PUT', `/api/admin/lieux/${m.dataset.modifierLieu}`, d);
        toast('Lieu modifié');
        await c.rafraichir(true);
        chargerLieuxAdmin();
      });
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
