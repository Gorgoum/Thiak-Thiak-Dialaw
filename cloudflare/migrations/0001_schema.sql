-- Thiak Thiak Dialaw — schéma pour Cloudflare D1 (SQLite)
-- Dates en texte ISO 8601 UTC ; booléens en 0/1 ; JSON en texte.

CREATE TABLE IF NOT EXISTS utilisateurs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nom           TEXT NOT NULL,
  telephone     TEXT NOT NULL UNIQUE,
  pin_hash      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('livreur', 'admin')),
  actif         INTEGER NOT NULL DEFAULT 1,
  disponible    INTEGER NOT NULL DEFAULT 0,
  lat           REAL,
  lng           REAL,
  position_maj  TEXT,
  cree_le       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS abonnements_push (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  utilisateur_id  INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  abonnement      TEXT NOT NULL,
  cree_le         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  client_nom        TEXT NOT NULL,
  client_tel        TEXT NOT NULL,
  suivi_token       TEXT NOT NULL UNIQUE,
  abonnement_push   TEXT,
  livreur_id        INTEGER REFERENCES utilisateurs(id),
  type              TEXT NOT NULL DEFAULT 'colis' CHECK (type IN ('colis', 'achat')),
  description       TEXT NOT NULL,
  montant_achat     INTEGER NOT NULL DEFAULT 0,
  depart_lat        REAL NOT NULL,
  depart_lng        REAL NOT NULL,
  depart_repere     TEXT NOT NULL,
  arrivee_lat       REAL NOT NULL,
  arrivee_lng       REAL NOT NULL,
  arrivee_repere    TEXT NOT NULL,
  destinataire_nom  TEXT,
  destinataire_tel  TEXT,
  distance_km       REAL NOT NULL,
  prix              INTEGER NOT NULL,
  paiement          TEXT NOT NULL DEFAULT 'especes' CHECK (paiement IN ('especes', 'wave', 'orange_money')),
  paiement_statut   TEXT NOT NULL DEFAULT 'a_la_livraison'
                    CHECK (paiement_statut IN ('a_la_livraison', 'en_attente', 'paye', 'expire', 'annule')),
  nangu_id          TEXT UNIQUE,
  montant_du        INTEGER,
  paiement_infos    TEXT,
  paye_le           TEXT,
  statut            TEXT NOT NULL DEFAULT 'en_attente'
                    CHECK (statut IN ('attente_paiement', 'en_attente', 'acceptee', 'recuperee', 'livree', 'annulee')),
  note              INTEGER CHECK (note BETWEEN 1 AND 5),
  cree_le           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  acceptee_le       TEXT,
  recuperee_le      TEXT,
  livree_le         TEXT,
  annulee_le        TEXT
);

CREATE INDEX IF NOT EXISTS idx_courses_statut  ON courses(statut);
CREATE INDEX IF NOT EXISTS idx_courses_client  ON courses(client_tel);
CREATE INDEX IF NOT EXISTS idx_courses_livreur ON courses(livreur_id);
-- Un livreur ne peut avoir qu'une seule course en cours à la fois
CREATE UNIQUE INDEX IF NOT EXISTS un_livreur_course_active
  ON courses(livreur_id) WHERE statut IN ('acceptee', 'recuperee');

CREATE TABLE IF NOT EXISTS evenements_nangu (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  recu_le   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS parametres (
  cle     TEXT PRIMARY KEY,
  valeur  TEXT NOT NULL
);

INSERT OR IGNORE INTO parametres (cle, valeur) VALUES
  ('prix_base', '300'),
  ('prix_km', '150'),
  ('prix_min', '500'),
  ('facteur_route', '1.3'),
  ('commission_pct', '10'),
  ('rayon_km', '10'),
  ('zone_km', '15');

CREATE TABLE IF NOT EXISTS lieux (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nom        TEXT NOT NULL,
  categorie  TEXT NOT NULL DEFAULT 'autre'
             CHECK (categorie IN ('village', 'quartier', 'rue', 'culte', 'ecole', 'sante', 'marche', 'commerce', 'autre')),
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  source     TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('osm', 'overture', 'admin', 'livraison')),
  osm_id     TEXT UNIQUE,
  valide     INTEGER NOT NULL DEFAULT 1,
  vu_fois    INTEGER NOT NULL DEFAULT 1,
  cree_le    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS demandes_position (
  code         TEXT PRIMARY KEY,
  demandeur    TEXT,
  lat          REAL,
  lng          REAL,
  precision_m  INTEGER,
  cree_le      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  recue_le     TEXT
);

-- Limites anti-abus (essais de PIN, commandes par adresse IP…), partagées entre toutes les instances
CREATE TABLE IF NOT EXISTS limites (
  cle     TEXT PRIMARY KEY,
  compte  INTEGER NOT NULL,
  debut   INTEGER NOT NULL      -- millisecondes depuis 1970
);
