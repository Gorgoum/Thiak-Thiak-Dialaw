// =============================================================================
//  Resto OUMY DJIAMIL : informations du restaurant et menu
//  C'est le SEUL fichier à modifier pour changer les plats, les prix, le téléphone…
//  Les plats et les prix ci-dessous sont des EXEMPLES, à remplacer par les vrais.
// =============================================================================
window.RESTO = {
  nom: 'Resto OUMY DJIAMIL',
  slogan: 'La cuisine sénégalaise faite maison, comme à la maison',
  presentation: 'Thiéboudienne du jour, yassa, mafé et jus frais : chez Oumy Djiamil, tout est préparé le jour même avec des produits du marché de Yène.',

  // Coordonnées (À REMPLACER)
  telephone: '770000000',       // numéro à appeler, sans espaces
  whatsapp: '770000000',        // numéro WhatsApp qui reçoit les commandes à emporter
  adresse: 'Yène, Sénégal',     // repère connu : « Face à la mosquée de Yène Kao », etc.
  // Position exacte du restaurant (le livreur Yobalema vient la chercher ici)
  position: { lat: 14.6391, lng: -17.1734 },

  horaires: [
    ['Lundi – Samedi', '11 h – 22 h'],
    ['Dimanche', '12 h – 21 h'],
  ],

  // Adresse du site Yobalema Yène (livraison)
  yobalema: 'https://thiak-thiak-dialaw.thiakthiakdialaw.workers.dev',

  // Menu : une catégorie = un titre + des plats. Prix en FCFA.
  // « jour » : plat servi seulement certains jours (laisser vide si tous les jours).
  menu: [
    {
      categorie: 'Plats',
      plats: [
        { id: 'thieb', nom: 'Thiéboudienne', description: 'Riz au poisson, légumes et sauce tomate, le plat national.', prix: 2500 },
        { id: 'yassa', nom: 'Yassa poulet', description: 'Poulet mariné au citron et aux oignons confits, riz blanc.', prix: 2500 },
        { id: 'mafe', nom: 'Mafé', description: 'Viande mijotée dans une sauce d\'arachide, riz blanc.', prix: 2000 },
        { id: 'thiou', nom: 'Thiou poisson', description: 'Poisson en sauce tomate relevée, riz blanc.', prix: 2000 },
        { id: 'domoda', nom: 'Domoda', description: 'Ragoût de viande à la pâte d\'arachide et aux légumes.', prix: 2000, jour: 'Mercredi' },
        { id: 'kandja', nom: 'Soupou kandja', description: 'Sauce gombo à l\'huile de palme, poisson et fruits de mer.', prix: 2500, jour: 'Vendredi' },
      ],
    },
    {
      categorie: 'Grillades',
      plats: [
        { id: 'dibi', nom: 'Dibi mouton', description: 'Mouton grillé au feu de bois, oignons et moutarde.', prix: 3000 },
        { id: 'poulet', nom: 'Poulet braisé', description: 'Demi-poulet braisé, frites ou alloco.', prix: 3000 },
        { id: 'poisson', nom: 'Poisson braisé', description: 'Poisson du jour braisé, sauce oignon, attiéké.', prix: 3500 },
      ],
    },
    {
      categorie: 'Petites faims',
      plats: [
        { id: 'pastels', nom: 'Pastels (6)', description: 'Beignets farcis au poisson, sauce tomate pimentée.', prix: 1000 },
        { id: 'fataya', nom: 'Fataya (4)', description: 'Chaussons frits à la viande.', prix: 1000 },
        { id: 'accara', nom: 'Accara (10)', description: 'Beignets de niébé, sauce piquante.', prix: 500 },
      ],
    },
    {
      categorie: 'Boissons et desserts',
      plats: [
        { id: 'bissap', nom: 'Bissap', description: 'Jus de fleurs d\'hibiscus, menthe. 50 cl.', prix: 500 },
        { id: 'bouye', nom: 'Bouye', description: 'Jus de pain de singe (baobab). 50 cl.', prix: 700 },
        { id: 'gingembre', nom: 'Gingembre', description: 'Jus de gingembre frais, citron. 50 cl.', prix: 500 },
        { id: 'thiakry', nom: 'Thiakry', description: 'Couscous de mil au lait caillé sucré.', prix: 700 },
      ],
    },
  ],
};
