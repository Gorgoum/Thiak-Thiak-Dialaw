// Connexion à la base PostgreSQL (Neon en ligne).
// Sans DATABASE_URL (essai sur l'ordinateur), base en mémoire pg-mem : rien n'est gardé à l'arrêt.
const fs = require('fs');
const path = require('path');

let pool;
let memoire = false;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Neon exige une connexion chiffrée
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
} else if (process.env.RENDER || process.env.NODE_ENV === 'production') {
  throw new Error('DATABASE_URL manquante : collez l\x27adresse de la base Neon dans les réglages Render (Environment).');
} else {
  const { newDb } = require('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  pool = new Pool();
  memoire = true;
}

const query = (texte, valeurs) => pool.query(texte, valeurs);

/** Crée les tables si besoin, et met le menu d'exemple dans une base vide. */
async function preparer() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const deja = await query('SELECT id FROM infos WHERE id = 1');
  if (deja.rows.length) return;
  const ex = require('./donnees-exemple');
  const { menu, ...infos } = ex;
  await query('INSERT INTO infos (id, donnees) VALUES (1, $1)', [JSON.stringify(infos)]);
  for (const [i, cat] of menu.entries()) {
    const c = await query('INSERT INTO categories (nom, ordre) VALUES ($1, $2) RETURNING id', [cat.categorie, i]);
    for (const [j, p] of cat.plats.entries()) {
      await query('INSERT INTO plats (categorie_id, nom, description, prix, jour, ordre) VALUES ($1, $2, $3, $4, $5, $6)',
        [c.rows[0].id, p.nom, p.description || '', p.prix, p.jour || null, j]);
    }
  }
  console.log('Base vide : menu d\'exemple chargé.');
}

module.exports = { query, preparer, memoire: () => memoire };
