// Palettes de couleurs des sites de restaurant (choisies dans la page admin, onglet Restaurant).
// La même liste existe dans Yobalema (tuile Food) pour afficher chaque restaurant à ses couleurs.
window.THEMES = {
  terre: { nom: 'Terre', principale: '#7a2e1d', variante: '#a8432a', accent: '#f3c46b', secondaire: '#1f4d3a', fond: '#fbf6ee', trait: '#ead9c6' },
  ocean: { nom: 'Océan', principale: '#0b3d5c', variante: '#1b6a8f', accent: '#ffb547', secondaire: '#0e7c66', fond: '#f2f7fa', trait: '#d6e4ee' },
  foret: { nom: 'Forêt', principale: '#1f4d3a', variante: '#2f6f52', accent: '#f2c14e', secondaire: '#7a2e1d', fond: '#f4f8f2', trait: '#d9e6d6' },
  nuit: { nom: 'Nuit', principale: '#2b2140', variante: '#4b3a6b', accent: '#ff8a5c', secondaire: '#1f6f8b', fond: '#f7f5fb', trait: '#e2dcef' },
  piment: { nom: 'Piment', principale: '#9f1d14', variante: '#d0402c', accent: '#ffd166', secondaire: '#264653', fond: '#fff7f2', trait: '#f3dccf' },
};

/** Applique une palette au site (variables CSS + couleur de la barre du téléphone). */
window.appliquerTheme = (nom) => {
  const t = window.THEMES[nom] || window.THEMES.terre;
  const r = document.documentElement.style;
  r.setProperty('--terre', t.principale);
  r.setProperty('--terre-2', t.variante);
  r.setProperty('--safran', t.accent);
  r.setProperty('--vert', t.secondaire);
  r.setProperty('--creme', t.fond);
  r.setProperty('--trait', t.trait);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.principale);
};
