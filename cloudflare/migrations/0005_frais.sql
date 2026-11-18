-- Frais gardés par la plateforme et partage de chaque course.
-- prix (courses) = ce que paie le client = prix de la course + frais de service + frais d'achat.
ALTER TABLE courses ADD COLUMN frais_service INTEGER NOT NULL DEFAULT 0; -- fixe, par commande
ALTER TABLE courses ADD COLUMN frais_achat INTEGER NOT NULL DEFAULT 0;   -- « Acheter pour moi » : % des achats
-- Registre : pour chaque course, qui a gagné quoi (après les frais Wave / Orange Money)
ALTER TABLE mouvements ADD COLUMN frais_plateforme INTEGER;  -- frais de service + frais d'achat
ALTER TABLE mouvements ADD COLUMN frais_paiement INTEGER;    -- prélevés par Wave / Orange Money
ALTER TABLE mouvements ADD COLUMN part_livreur INTEGER;      -- ce que gagne le chauffeur
ALTER TABLE mouvements ADD COLUMN gain_plateforme INTEGER;   -- commission + frais − frais de paiement
-- anciennes courses : pas de frais de service ; frais de paiement estimés à 1 %
UPDATE mouvements SET frais_plateforme = 0,
  frais_paiement = CASE WHEN paiement IN ('wave', 'orange_money') THEN CAST(round(prix * 0.01) AS INTEGER) ELSE 0 END,
  part_livreur = prix - commission
WHERE type = 'course' AND part_livreur IS NULL;
UPDATE mouvements SET gain_plateforme = commission - frais_paiement WHERE type = 'course' AND gain_plateforme IS NULL;
INSERT INTO parametres (cle, valeur) VALUES ('frais_service', '100') ON CONFLICT (cle) DO NOTHING;
INSERT INTO parametres (cle, valeur) VALUES ('frais_achat_pct', '5') ON CONFLICT (cle) DO NOTHING;
INSERT INTO parametres (cle, valeur) VALUES ('frais_achat_min', '200') ON CONFLICT (cle) DO NOTHING;
INSERT INTO parametres (cle, valeur) VALUES ('frais_wave_pct', '1') ON CONFLICT (cle) DO NOTHING;
INSERT INTO parametres (cle, valeur) VALUES ('frais_om_pct', '1') ON CONFLICT (cle) DO NOTHING;
