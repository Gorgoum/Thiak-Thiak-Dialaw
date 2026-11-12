// Génère le SQL qui crée (ou met à jour) le compte admin dans D1, avec le PIN haché en PBKDF2
// au même format que le Worker. Lit ADMIN_NOM, ADMIN_TEL, ADMIN_PIN dans le .env.
// Usage : node scripts/admin-cloudflare.js <fichier.sql>   (fichier à exécuter avec wrangler d1 execute, puis à supprimer)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const fs = require('fs');

const b64url = (b) => Buffer.from(b).toString('base64url');
let tel = String(process.env.ADMIN_TEL || '').replace(/\D/g, '');
if (tel.startsWith('221') && tel.length === 12) tel = tel.slice(3);
const pin = String(process.env.ADMIN_PIN || '');
if (!/^7\d{8}$/.test(tel) || !/^\d{4}$/.test(pin)) {
  console.error('ADMIN_TEL (77…) et ADMIN_PIN (4 chiffres) doivent être renseignés dans le .env');
  process.exit(1);
}
const iterations = 10000;
const sel = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(pin, sel, iterations, 32, 'sha256');
const pinHash = `pbkdf2$${iterations}$${b64url(sel)}$${b64url(hash)}`;
const nom = String(process.env.ADMIN_NOM || 'Administrateur').replace(/'/g, "''");
const sql = `INSERT INTO utilisateurs (nom, telephone, pin_hash, role, actif) VALUES ('${nom}', '${tel}', '${pinHash}', 'admin', 1)
ON CONFLICT (telephone) DO UPDATE SET role = 'admin', pin_hash = excluded.pin_hash, actif = 1;\n`;
fs.writeFileSync(process.argv[2], sql);
console.log(`Compte admin prêt pour ${tel} → ${process.argv[2]}`);
