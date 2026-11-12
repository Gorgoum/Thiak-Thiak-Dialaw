// Prépare la version Cloudflare :
//  - cloudflare/public/ : pages + Leaflet + police Inter + client temps réel (à la place de Socket.io)
//  - cloudflare/migrations/0002_lieux.sql : lieux OpenStreetMap + Overture (sans doublon)
// Usage : npm run cf:construire
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const sortie = path.join(racine, 'cloudflare', 'public');

function copier(src, dst, filtre = () => true) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) if (filtre(f)) copier(path.join(src, f), path.join(dst, f), filtre);
  } else fs.copyFileSync(src, dst);
}

// ---------- Fichiers statiques ----------
fs.rmSync(sortie, { recursive: true, force: true });
copier(path.join(racine, 'public'), sortie, (f) => !f.startsWith('_')); // _*.html : pages d'essai, jamais publiées
copier(path.join(racine, 'node_modules', 'leaflet', 'dist'), path.join(sortie, 'vendor', 'leaflet'), (f) => !f.endsWith('.map') && !f.includes('-src'));
const inter = path.join(racine, 'node_modules', '@fontsource-variable', 'inter', 'files');
fs.mkdirSync(path.join(sortie, 'vendor', 'inter'), { recursive: true });
fs.copyFileSync(path.join(inter, 'inter-latin-wght-normal.woff2'), path.join(sortie, 'vendor', 'inter', 'inter-latin-wght-normal.woff2'));
fs.mkdirSync(path.join(sortie, 'socket.io'), { recursive: true });
fs.copyFileSync(path.join(racine, 'cloudflare', 'statique', 'socket.io.js'), path.join(sortie, 'socket.io', 'socket.io.js'));
// en-têtes de sécurité et de cache des fichiers statiques
fs.writeFileSync(path.join(sortie, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Permissions-Policy: geolocation=(self), camera=(), microphone=()
/vendor/*
  Cache-Control: public, max-age=2592000, immutable
/sw.js
  Cache-Control: no-cache
`);

// ---------- Lieux (même règle que l'import Node : Overture ignoré s'il double un lieu OSM à moins de 300 m) ----------
const simplifier = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const distKm = (a, b) => {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const CATEGORIES = ['village', 'quartier', 'rue', 'culte', 'ecole', 'sante', 'marche', 'commerce', 'autre'];
const sql = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const retenus = [];
const lignes = [];
for (const [fichier, source] of [['lieux-osm.json', 'osm'], ['lieux-overture.json', 'overture']]) {
  const f = path.join(racine, 'data', fichier);
  if (!fs.existsSync(f)) continue;
  for (const l of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const cle = simplifier(l.nom);
    if (retenus.some((e) => e.cle === cle && distKm(e, l) < 0.3)) continue;
    retenus.push({ cle, lat: l.lat, lng: l.lng });
    const cat = CATEGORIES.includes(l.categorie) ? l.categorie : 'autre';
    lignes.push(`INSERT OR IGNORE INTO lieux (nom, categorie, lat, lng, source, osm_id) VALUES (${[l.nom, cat, l.lat, l.lng, source, l.osm_id].map(sql).join(', ')});`);
  }
}
fs.writeFileSync(path.join(racine, 'cloudflare', 'migrations', '0002_lieux.sql'),
  `-- Lieux OpenStreetMap (ODbL) et Overture Maps, générés par scripts/construire-cloudflare.js\n${lignes.join('\n')}\n`);

const taille = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).length;
console.log(`cloudflare/public : ${taille(sortie)} fichiers · migrations/0002_lieux.sql : ${lignes.length} lieux`);
