// Génère les icônes PNG de l'application (sans dépendance) : fond vert, roue jaune.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const bloc = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(taille) {
  const VERT = [15, 81, 50], JAUNE = [255, 193, 7], BLANC = [255, 255, 255];
  const lignes = [];
  const c = taille / 2;
  for (let y = 0; y < taille; y++) {
    const ligne = [0];
    for (let x = 0; x < taille; x++) {
      const d = Math.hypot(x - c, y - c) / taille;
      let px = VERT;
      if (d < 0.30 && d > 0.22) px = JAUNE;          // pneu
      else if (d < 0.07) px = JAUNE;                  // moyeu
      else if (d < 0.22) {                            // rayons
        const ang = Math.atan2(y - c, x - c);
        if (Math.abs(Math.sin(ang * 3)) < 0.12) px = BLANC;
      }
      ligne.push(...px);
    }
    lignes.push(Buffer.from(ligne));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(taille, 0); ihdr.writeUInt32BE(taille, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc('IHDR', ihdr),
    bloc('IDAT', zlib.deflateSync(Buffer.concat(lignes))),
    bloc('IEND', Buffer.alloc(0)),
  ]);
}

const dossier = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dossier, { recursive: true });
for (const t of [96, 192, 512]) {
  fs.writeFileSync(path.join(dossier, `icon-${t}.png`), png(t));
  console.log(`icon-${t}.png`);
}
