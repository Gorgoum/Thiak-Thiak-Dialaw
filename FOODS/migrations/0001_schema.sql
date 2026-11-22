-- Base du Resto OUMY DJIAMIL (Cloudflare D1, SQLite)

-- Informations du restaurant (une seule ligne, en JSON) : nom, téléphone, adresse, horaires…
CREATE TABLE IF NOT EXISTS infos (
  id INTEGER PRIMARY KEY,
  donnees TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  ordre INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  categorie_id INTEGER NOT NULL REFERENCES categories(id),
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prix INTEGER NOT NULL,
  jour TEXT,                               -- servi seulement ce jour-là (« Vendredi »), sinon NULL
  disponible INTEGER NOT NULL DEFAULT 1,   -- 0 : épuisé aujourd'hui
  ordre INTEGER NOT NULL DEFAULT 0,
  photo TEXT,                              -- photo JPEG réduite, en base64 (quelques dizaines de Ko)
  photo_maj INTEGER                        -- date de la photo (ms), pour que les téléphones rechargent la nouvelle
);
CREATE INDEX IF NOT EXISTS plats_categorie ON plats(categorie_id);

-- Essais de connexion ratés à la page admin (anti-devinette)
CREATE TABLE IF NOT EXISTS essais (
  ip TEXT NOT NULL,
  le INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS essais_ip ON essais(ip, le);
