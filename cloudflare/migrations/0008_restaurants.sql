-- Restaurants partenaires (ex. : Resto OUMY DJIAMIL) : ils reçoivent dans Yobalema les commandes passées
-- depuis leur site, et signalent quand les plats sont prêts. Compte à part des livreurs (connexion : téléphone + PIN).
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,            -- identifiant public, utilisé par le site du restaurant (« oumy-djiamil »)
  nom TEXT NOT NULL,
  telephone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  adresse TEXT,
  actif INTEGER NOT NULL DEFAULT 1,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
ALTER TABLE courses ADD COLUMN restaurant_id INTEGER;   -- commande de plats d'un restaurant partenaire
ALTER TABLE courses ADD COLUMN plats_prets_le TEXT;     -- le restaurant a signalé « plats prêts »
CREATE INDEX IF NOT EXISTS courses_restaurant ON courses(restaurant_id);
