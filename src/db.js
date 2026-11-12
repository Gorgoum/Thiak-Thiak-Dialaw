const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant : copiez .env.example vers .env et complétez-le.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = {
  pool,
  query: (texte, params) => pool.query(texte, params),
};
