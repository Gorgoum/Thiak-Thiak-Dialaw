// Construit public/icons.svg (sprite) à partir des icônes Lucide (licence ISC) réellement utilisées.
// Usage dans les pages : <svg class="ic"><use href="/icons.svg#map-pin"></use></svg>
const fs = require('fs');
const path = require('path');

const ICONES = [
  'map-pin', 'navigation', 'locate-fixed', 'search', 'x', 'maximize-2', 'minimize-2', 'send', 'share-2', 'copy',
  'message-circle', 'message-square', 'phone', 'package', 'shopping-bag', 'bike', 'clock', 'history', 'check',
  'circle-check', 'chevron-right', 'chevron-down', 'list', 'star', 'user', 'bell', 'bell-off', 'log-out',
  'wallet', 'route', 'layers', 'info', 'triangle-alert', 'loader-circle', 'school', 'landmark', 'store',
  'heart-pulse', 'moon-star', 'house', 'map', 'plus', 'trash-2', 'settings', 'chart-column', 'refresh-cw',
  'arrow-right', 'power', 'banknote', 'circle-x', 'users', 'shield-check', 'signpost', 'milestone', 'undo-2',
  'corner-up-left', 'corner-up-right', 'arrow-up', 'arrow-up-left', 'arrow-up-right', 'rotate-cw', 'flag',
  'volume-2', 'volume-x', 'locate',
  'file-text', 'utensils', 'flame', 'pill', 'shirt', 'ellipsis', 'hand', 'chevron-left', 'pointer', 'croissant', 'droplet',
];

const dossier = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const manquantes = [];
const symboles = ICONES.map((nom) => {
  const f = path.join(dossier, nom + '.svg');
  if (!fs.existsSync(f)) { manquantes.push(nom); return ''; }
  const svg = fs.readFileSync(f, 'utf8');
  const interieur = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  return `<symbol id="${nom}" viewBox="0 0 24 24">${interieur.replace(/\s*\n\s*/g, '')}</symbol>`;
}).join('\n');

const sortie = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
<!-- Icônes Lucide (https://lucide.dev) — licence ISC -->
${symboles}
</svg>
`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icons.svg'), sortie);
console.log(`${ICONES.length - manquantes.length} icônes → public/icons.svg`);
if (manquantes.length) { console.error('Introuvables :', manquantes.join(', ')); process.exitCode = 1; }
