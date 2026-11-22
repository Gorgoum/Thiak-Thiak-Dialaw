-- Commission de Yobalema sur les plats des restaurants partenaires (en %), et son montant figé sur chaque commande.
-- Le livreur remet au restaurant le prix des plats moins cette commission.
ALTER TABLE restaurants ADD COLUMN commission_pct INTEGER NOT NULL DEFAULT 10;
ALTER TABLE courses ADD COLUMN commission_resto INTEGER NOT NULL DEFAULT 0;
