-- Base du Resto OUMY DJIAMIL (PostgreSQL, hébergée sur Neon)
-- Créée automatiquement au démarrage du serveur si elle n'existe pas.

-- Informations du restaurant (une seule ligne) : nom, téléphone, adresse, horaires…
CREATE TABLE IF NOT EXISTS infos (
  id INTEGER PRIMARY KEY,
  donnees JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  nom TEXT NOT NULL,
  ordre INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plats (
  id SERIAL PRIMARY KEY,
  categorie_id INTEGER NOT NULL REFERENCES categories(id),
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prix INTEGER NOT NULL,
  jour TEXT,                                   -- servi seulement ce jour-là (« Vendredi »), sinon NULL
  disponible BOOLEAN NOT NULL DEFAULT TRUE,    -- FALSE : épuisé aujourd'hui
  ordre INTEGER NOT NULL DEFAULT 0,
  photo TEXT,                                  -- photo JPEG réduite, en base64 (quelques dizaines de Ko)
  photo_maj TIMESTAMPTZ
);
