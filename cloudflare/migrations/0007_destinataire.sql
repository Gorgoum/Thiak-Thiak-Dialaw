-- Le destinataire d'un colis peut recevoir ses propres notifications (sans prendre la place du client).
ALTER TABLE courses ADD COLUMN abonnement_dest TEXT;   -- abonnement aux notifications du destinataire
ALTER TABLE courses ADD COLUMN dest_prevenu_le TEXT;   -- « le livreur arrive dans 2 min » déjà envoyé
