-- Argent entre livreurs et plateforme : registre de mouvements, un solde par livreur.
-- montant > 0 : la plateforme doit cet argent au livreur (sa part d'une course payée en ligne)
-- montant < 0 : le livreur doit cet argent à la plateforme (commission d'une course en espèces)
CREATE TABLE IF NOT EXISTS mouvements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  livreur_id  INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  course_id   INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  type        TEXT NOT NULL CHECK (type IN ('course', 'reglement', 'ajustement')),
  montant     INTEGER NOT NULL,
  prix        INTEGER,
  commission  INTEGER,
  paiement    TEXT,
  libelle     TEXT NOT NULL,
  reference   TEXT,
  admin_id    INTEGER,
  cree_le     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_mouvements_livreur ON mouvements(livreur_id);
CREATE UNIQUE INDEX IF NOT EXISTS un_mouvement_course ON mouvements(course_id) WHERE type = 'course';

-- Au-delà de ce montant dû à la plateforme, le livreur ne peut plus accepter de course (0 = pas de plafond)
INSERT INTO parametres (cle, valeur) VALUES ('plafond_dette', '5000') ON CONFLICT (cle) DO NOTHING;
