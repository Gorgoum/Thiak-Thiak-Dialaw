-- Schéma Thiak Thiak Dialaw (idempotent : peut être relancé sans risque)

CREATE TABLE IF NOT EXISTS utilisateurs (
  id            SERIAL PRIMARY KEY,
  nom           TEXT NOT NULL,
  telephone     TEXT NOT NULL UNIQUE,          -- 9 chiffres, ex : 771234567
  pin_hash      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('livreur', 'admin')), -- les clients n'ont pas de compte
  actif         BOOLEAN NOT NULL DEFAULT TRUE, -- un livreur doit être validé par l'admin
  disponible    BOOLEAN NOT NULL DEFAULT FALSE,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  position_maj  TIMESTAMPTZ,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abonnements_push (
  id              SERIAL PRIMARY KEY,
  utilisateur_id  INT NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  abonnement      JSONB NOT NULL,
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id                SERIAL PRIMARY KEY,
  client_nom        TEXT NOT NULL,                -- le client commande sans compte
  client_tel        TEXT NOT NULL,
  suivi_token       TEXT NOT NULL UNIQUE,         -- code secret pour suivre / annuler / noter
  abonnement_push   JSONB,                        -- notifications du client (facultatif)
  livreur_id        INT REFERENCES utilisateurs(id),
  type              TEXT NOT NULL DEFAULT 'colis' CHECK (type IN ('colis', 'achat')),
  description       TEXT NOT NULL,
  montant_achat     INT NOT NULL DEFAULT 0,     -- pour "acheter pour moi" : remboursé au livreur
  depart_lat        DOUBLE PRECISION NOT NULL,
  depart_lng        DOUBLE PRECISION NOT NULL,
  depart_repere     TEXT NOT NULL,
  arrivee_lat       DOUBLE PRECISION NOT NULL,
  arrivee_lng       DOUBLE PRECISION NOT NULL,
  arrivee_repere    TEXT NOT NULL,
  destinataire_nom  TEXT,
  destinataire_tel  TEXT,
  distance_km       NUMERIC(6, 2) NOT NULL,
  prix              INT NOT NULL,               -- FCFA
  -- Moyen de paiement : espèces à la livraison, ou en ligne avec Nangu (Wave / Orange Money)
  paiement          TEXT NOT NULL DEFAULT 'especes' CHECK (paiement IN ('especes', 'wave', 'orange_money')),
  paiement_statut   TEXT NOT NULL DEFAULT 'a_la_livraison'
                    CHECK (paiement_statut IN ('a_la_livraison', 'en_attente', 'paye', 'expire', 'annule')),
  nangu_id          TEXT UNIQUE,                  -- identifiant pay_… chez Nangu
  montant_du        INT,                          -- montant exact à payer (amount_due de Nangu)
  paiement_infos    JSONB,                        -- lien Wave, QR code, code marchand Orange…
  paye_le           TIMESTAMPTZ,
  -- attente_paiement : payée en ligne mais pas encore confirmée ; les livreurs ne la voient pas
  statut            TEXT NOT NULL DEFAULT 'en_attente'
                    CHECK (statut IN ('attente_paiement', 'en_attente', 'acceptee', 'recuperee', 'livree', 'annulee')),
  note              SMALLINT CHECK (note BETWEEN 1 AND 5),
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT now(),
  acceptee_le       TIMESTAMPTZ,
  recuperee_le      TIMESTAMPTZ,
  livree_le         TIMESTAMPTZ,
  annulee_le        TIMESTAMPTZ
);

-- Événements Nangu déjà traités (un webhook peut arriver deux fois)
CREATE TABLE IF NOT EXISTS evenements_nangu (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  recu_le   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_courses_statut  ON courses(statut);
CREATE INDEX IF NOT EXISTS idx_courses_client  ON courses(client_tel);
CREATE INDEX IF NOT EXISTS idx_courses_livreur ON courses(livreur_id);
-- Un livreur ne peut avoir qu'une seule course en cours à la fois
CREATE UNIQUE INDEX IF NOT EXISTS un_livreur_course_active
  ON courses(livreur_id) WHERE statut IN ('acceptee', 'recuperee');

CREATE TABLE IF NOT EXISTS parametres (
  cle     TEXT PRIMARY KEY,
  valeur  TEXT NOT NULL
);

INSERT INTO parametres (cle, valeur) VALUES
  ('prix_base', '300'),       -- FCFA, prise en charge
  ('prix_km', '150'),         -- FCFA par km
  ('prix_min', '500'),        -- FCFA, prix minimum d'une course
  ('facteur_route', '1.3'),   -- distance à vol d'oiseau × facteur ≈ distance par la route
  ('commission_pct', '10'),   -- % gardé par la plateforme
  ('rayon_km', '10'),         -- rayon de notification des livreurs autour du départ
  ('zone_km', '15')           -- zone de service : départ et arrivée à moins de X km du centre de Yène
ON CONFLICT (cle) DO NOTHING;

-- Lieux recherchables sur la carte.
-- Sources : OpenStreetMap, Overture Maps, ajout de l'admin, ou appris d'une livraison réussie.
-- Un lieu appris d'une livraison n'est visible qu'après validation de l'admin (vie privée).
CREATE TABLE IF NOT EXISTS lieux (
  id         SERIAL PRIMARY KEY,
  nom        TEXT NOT NULL,
  categorie  TEXT NOT NULL DEFAULT 'autre'
             CHECK (categorie IN ('village', 'quartier', 'rue', 'culte', 'ecole', 'sante', 'marche', 'commerce', 'autre')),
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  source     TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('osm', 'overture', 'admin', 'livraison')),
  osm_id     TEXT UNIQUE,              -- identifiant externe (osm/… ou overture/…)
  valide     BOOLEAN NOT NULL DEFAULT TRUE,
  vu_fois    INT NOT NULL DEFAULT 1,   -- nombre de livraisons qui ont confirmé ce lieu
  cree_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Demandes de position : le client envoie un lien au destinataire, qui renvoie sa position GPS
CREATE TABLE IF NOT EXISTS demandes_position (
  code       TEXT PRIMARY KEY,
  demandeur  TEXT,                 -- prénom affiché au destinataire
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  precision_m INT,
  cree_le    TIMESTAMPTZ NOT NULL DEFAULT now(),
  recue_le   TIMESTAMPTZ
);
