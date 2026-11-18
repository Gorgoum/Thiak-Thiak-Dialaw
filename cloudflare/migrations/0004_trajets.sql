-- Transport de personnes (comme un service de VTC) en plus des livraisons de colis.
-- service : 'livraison' (colis) ou 'trajet' (passager) ; vehicule : 'moto' ou 'voiture'.
ALTER TABLE courses ADD COLUMN service TEXT NOT NULL DEFAULT 'livraison';
ALTER TABLE courses ADD COLUMN vehicule TEXT NOT NULL DEFAULT 'moto';
ALTER TABLE courses ADD COLUMN arrive_le TEXT;  -- chauffeur arrivé au point de départ
-- véhicule du chauffeur / livreur (renseigné par l'admin)
ALTER TABLE utilisateurs ADD COLUMN vehicule TEXT NOT NULL DEFAULT 'moto';
ALTER TABLE utilisateurs ADD COLUMN plaque TEXT;
ALTER TABLE utilisateurs ADD COLUMN modele TEXT;
-- prix d'un trajet en voiture = prix moto × ce coefficient
INSERT INTO parametres (cle, valeur) VALUES ('coef_voiture', '2') ON CONFLICT (cle) DO NOTHING;
