// Crée la base si besoin, applique le schéma et crée le compte administrateur.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

async function creerBaseSiAbsente() {
  const url = new URL(process.env.DATABASE_URL);
  const nomBase = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  const existe = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [nomBase]);
  if (!existe.rows.length) {
    await c.query(`CREATE DATABASE "${nomBase.replace(/"/g, '""')}"`);
    console.log(`Base "${nomBase}" créée.`);
  }
  await c.end();
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquant dans .env');
  await creerBaseSiAbsente();

  const { pool } = require('./db');
  const { normaliserTel } = require('./auth');
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  console.log('Schéma appliqué.');
  const n = await require('./lieux').importerLieuxOsm(pool);
  console.log(`${n} nouveaux lieux OpenStreetMap chargés.`);

  const tel = normaliserTel(process.env.ADMIN_TEL);
  const pin = String(process.env.ADMIN_PIN || '');
  if (tel && /^\d{4}$/.test(pin)) {
    const hash = await bcrypt.hash(pin, 10);
    await pool.query(
      `INSERT INTO utilisateurs (nom, telephone, pin_hash, role, actif) VALUES ($1, $2, $3, 'admin', true)
       ON CONFLICT (telephone) DO UPDATE SET role = 'admin', pin_hash = EXCLUDED.pin_hash, actif = true`,
      [process.env.ADMIN_NOM || 'Administrateur', tel, hash]
    );
    console.log(`Compte admin prêt : ${tel}`);
  } else {
    console.log('ADMIN_TEL / ADMIN_PIN absents ou invalides : aucun admin créé.');
  }
  await pool.end();
})().catch((e) => {
  console.error('Échec :', e.message);
  process.exit(1);
});
