// Télécharge depuis OpenStreetMap (données libres ODbL) :
//  - les villages, quartiers, rues nommées et lieux autour de Yène → data/lieux-osm.json
//  - la limite de la commune de Yène → public/data/yene-limite.json
// À relancer de temps en temps : npm run lieux   (puis npm run init-db pour charger les lieux en base)
const fs = require('fs');
const path = require('path');

const ZONE_VILLAGES = '14.55,-17.22,14.74,-17.00';
const ZONE_LIEUX = '14.58,-17.22,14.69,-17.10';
const RELATION_YENE = 12982155; // « Communauté rurale de Yenne » sur OpenStreetMap
const SERVEURS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const REQUETE_LIEUX = `[out:json][timeout:90];
(
  node["place"~"^(village|town|hamlet|isolated_dwelling|suburb|neighbourhood|quarter|locality)$"]["name"](${ZONE_VILLAGES});
  way["place"~"^(suburb|neighbourhood|quarter)$"]["name"](${ZONE_VILLAGES});
  way["highway"]["name"](${ZONE_LIEUX});
  nwr["name"]["amenity"](${ZONE_LIEUX});
  nwr["name"]["shop"](${ZONE_LIEUX});
  nwr["name"]["healthcare"](${ZONE_LIEUX});
  nwr["name"]["tourism"](${ZONE_LIEUX});
);
out center tags;`;
const REQUETE_LIMITE = `[out:json][timeout:90];relation(${RELATION_YENE});out geom;`;

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Interroge Overpass en essayant chaque serveur, jusqu'à 3 tours (les serveurs publics sont parfois saturés). */
async function overpass(requete) {
  for (let tour = 1; tour <= 3; tour++) {
    for (const url of SERVEURS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': 'ThiakThiakDialaw/0.1 (livraison locale)', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(requete),
        });
        if (r.ok) {
          const d = await r.json();
          if (d.elements && d.elements.length) return d;
        }
        console.warn(`  ${url} : HTTP ${r.status}`);
      } catch (e) { console.warn(`  ${url} : ${e.message}`); }
    }
    if (tour < 3) { console.warn(`  serveurs occupés, nouvel essai dans ${tour * 15} s…`); await attendre(tour * 15000); }
  }
  return null;
}

function categorie(t) {
  if (t.highway) return 'rue';
  if (t.place) return ['suburb', 'neighbourhood', 'quarter', 'locality'].includes(t.place) ? 'quartier' : 'village';
  const a = t.amenity;
  if (a === 'place_of_worship') return 'culte';
  if (['school', 'kindergarten', 'college', 'university'].includes(a)) return 'ecole';
  if (['clinic', 'doctors', 'hospital', 'pharmacy', 'dentist'].includes(a) || t.healthcare) return 'sante';
  if (a === 'marketplace') return 'marche';
  if (t.shop || ['restaurant', 'fuel', 'bank', 'cafe', 'fast_food', 'bar'].includes(a)) return 'commerce';
  return 'autre';
}

async function importerLieux() {
  console.log('Lieux, quartiers et rues…');
  const donnees = await overpass(REQUETE_LIEUX);
  if (!donnees) { console.error('  échec : aucun serveur n\'a répondu, fichier existant conservé.'); return false; }
  const vus = new Set();
  const lieux = [];
  for (const e of donnees.elements) {
    const lat = e.lat ?? (e.center && e.center.lat);
    const lng = e.lon ?? (e.center && e.center.lon);
    const nom = (e.tags.name || '').trim();
    if (!nom || lat == null) continue;
    // une rue est souvent découpée en plusieurs tronçons : on n'en garde qu'un par nom
    const cle = e.tags.highway ? 'rue|' + nom.toLowerCase() : nom.toLowerCase() + '|' + lat.toFixed(3) + '|' + lng.toFixed(3);
    if (vus.has(cle)) continue;
    vus.add(cle);
    lieux.push({ osm_id: `${e.type}/${e.id}`, nom, categorie: categorie(e.tags), lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
  }
  lieux.sort((x, y) => x.nom.localeCompare(y.nom, 'fr'));
  const fichier = path.join(__dirname, '..', 'data', 'lieux-osm.json');
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, JSON.stringify(lieux, null, 1));
  const parCat = lieux.reduce((m, l) => ({ ...m, [l.categorie]: (m[l.categorie] || 0) + 1 }), {});
  console.log(`  ${lieux.length} lieux → data/lieux-osm.json`, parCat);
  return true;
}

async function importerLimite() {
  console.log('Limite de la commune de Yène…');
  const donnees = await overpass(REQUETE_LIMITE);
  if (!donnees) { console.error('  échec : aucun serveur n\'a répondu, fichier existant conservé.'); return false; }
  const rel = donnees.elements[0];
  // on garde les tronçons extérieurs, avec 5 décimales (~1 m) pour un fichier léger
  const traits = rel.members
    .filter((m) => m.role === 'outer' && m.geometry)
    .map((m) => m.geometry.map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5)]));
  const fichier = path.join(__dirname, '..', 'public', 'data', 'yene-limite.json');
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, JSON.stringify({ nom: 'Commune de Yène', source: '© OpenStreetMap (ODbL)', traits }));
  console.log(`  ${traits.length} tronçons, ${traits.reduce((s, t) => s + t.length, 0)} points → public/data/yene-limite.json`);
  return true;
}

(async () => {
  const ok1 = await importerLieux();
  const ok2 = await importerLimite();
  if (ok1) console.log('Lancez ensuite « npm run init-db » pour charger les lieux dans la base.');
  if (!ok1 || !ok2) process.exitCode = 1;
})();
