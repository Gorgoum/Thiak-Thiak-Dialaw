-- Remboursement d'une course payée en ligne puis annulée (fait à la main dans Wave Business / Orange Money).
ALTER TABLE courses ADD COLUMN rembourse_le TEXT;
ALTER TABLE courses ADD COLUMN rembourse_montant INTEGER;
ALTER TABLE courses ADD COLUMN rembourse_ref TEXT;
