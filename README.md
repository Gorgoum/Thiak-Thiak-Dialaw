# Thiak Thiak Dialaw

Plateforme de livraison à domicile pour la commune de Yène. Le client demande une course d'un point A à un point B sans se déplacer ; les livreurs thiak thiak disponibles autour du départ reçoivent une notification et le premier qui accepte prend la course.

## Les trois espaces

| Adresse | Pour qui | Ce qu'on y fait |
|---|---|---|
| `/` | Client, **sans compte** | Donne son nom et son téléphone, place A et B sur la carte, voit le prix, suit la course en direct, appelle le livreur, note |
| `/livreur.html` | Livreur | Se met disponible, reçoit les notifications, accepte, « récupéré » → « livré », gains du jour |
| `/admin.html` | Administrateur | Valide les livreurs, suit les courses, règle les tarifs et la commission |

Deux services : **livrer un colis** et **acheter pour moi** (le livreur avance l'achat et se fait rembourser à la livraison). Paiement en espèces à la livraison.

## 100 % libre et gratuit

| Élément | Outil | Licence | Coût |
|---|---|---|---|
| Serveur | Node.js, Express, Socket.io | MIT | 0 |
| Base de données | PostgreSQL | PostgreSQL (libre) | 0 |
| Carte | Leaflet (servi par notre serveur) + fonds OpenStreetMap | BSD-2 / ODbL | 0 |
| Notifications | Web Push standard (clés VAPID générées localement) | MPL-2.0 | 0, sans compte |
| Itinéraire | lien `geo:` : ouvre OsmAnd, Organic Maps ou toute appli de carte | standard | 0 |
| Connexion | numéro + PIN (pas de SMS) | – | 0 |

Aucune clé d'API, aucun compte chez un fournisseur. Les seuls coûts réels sont hors du logiciel : un ordinateur allumé qui fait serveur, l'électricité et la connexion internet.

## En ligne sur Cloudflare (plan gratuit)

Adresse : **https://thiak-thiak-dialaw.thiakthiakdialaw.workers.dev** (compte Cloudflare « Thiak Thiak Dialaw ») (client), `/livreur.html`, `/admin.html`.

| Élément | Service Cloudflare |
|---|---|
| API (mêmes routes que la version Node) | Worker `cloudflare/src/` |
| Base de données | D1 `thiak-thiak` (SQLite), schéma `cloudflare/migrations/` |
| Temps réel | Durable Object `Diffusion` + WebSocket (`/ws`) ; côté pages, `/socket.io/socket.io.js` est remplacé par un petit client de même interface |
| Pages, carte, police | fichiers statiques (`npm run cf:construire` → `cloudflare/public/`) |
| Paiements Nangu | appel de l'API publique Nangu + webhook + relève automatique toutes les minutes en secours |

Commandes :

```bash
npm run cf:dev        # version Cloudflare en local (D1 et Durable Object simulés)
npm run cf:deployer   # construire et publier
npm run cf:admin      # créer / mettre à jour le compte admin en ligne (ADMIN_TEL, ADMIN_PIN du .env)
cd cloudflare && npx wrangler secret put NANGU_SECRET_KEY   # changer un secret (ex. passer à sk_live_…)
```

Secrets du Worker : `JWT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NANGU_SECRET_KEY`, et plus tard `NANGU_WEBHOOK_SECRET`.

**Webhook Nangu** : déclarer `https://thiak-thiak-dialaw.thiakthiakdialaw.workers.dev/webhooks/nangu` dans la console Nangu et poser le secret `whsec_…` avec `wrangler secret put NANGU_WEBHOOK_SECRET`. En attendant, les paiements sont confirmés par la relève planifiée (toutes les minutes) et par l'écran de paiement du client.

## Démarrage

Prérequis : Node.js 18+ et PostgreSQL.

```bash
npm install
cp .env.example .env        # puis mettre le mot de passe PostgreSQL et un JWT_SECRET
npm run init-db             # crée la base thiak_thiak, les tables et le compte admin
npm start                   # http://localhost:3000
```

Le compte admin est celui de `ADMIN_TEL` / `ADMIN_PIN` dans `.env`.

## Tester sur un téléphone

Les notifications et le GPS exigent une adresse **https** (sauf `localhost`). Pour tester depuis un téléphone, exposez le serveur avec un tunnel :

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Ouvrez l'adresse `https://….trycloudflare.com/livreur.html` dans Chrome sur Android et touchez **Activer les notifications**. Tout se passe dans le navigateur : pas d'APK, pas de Play Store. « Ajouter à l'écran d'accueil » est facultatif (raccourci vers le site).

Sur iPhone, les notifications web demandent iOS 16.4 ou plus et le site ajouté à l'écran d'accueil depuis Safari.

## Fonctionnement

1. Le client place le départ et l'arrivée : le trajet par la route se dessine sur la carte, qui zoome automatiquement sur l'itinéraire. Le serveur calcule le prix : `max(minimum, base + km × prix_km)`, arrondi à la centaine, avec la **distance réelle par la route** (OSRM). Si le service d'itinéraire ne répond pas, estimation de secours : vol d'oiseau × facteur route (1,3), et le tracé devient une ligne pointillée.
2. La course est créée `en_attente`. Les livreurs **validés, disponibles et à moins de `rayon_km`** du départ reçoivent une notification push ; ceux dont la position est inconnue aussi.
3. Le premier qui accepte prend la course (garanti par la base : les autres reçoivent « trop tard »). Un livreur n'a qu'une course en cours à la fois.
4. `acceptee` → `recuperee` → `livree`. Le client est prévenu à chaque étape (temps réel + notification).
5. Le livreur peut se désister avant récupération : la course repart aux autres. Le client peut annuler tant que personne n'a accepté.

**Comptes** : seuls l'admin et les livreurs en ont un (numéro + PIN à 4 chiffres, bloqué 15 minutes après 5 erreurs). Un livreur qui s'inscrit attend la validation de l'admin.

**Clients sans compte** : chaque course reçoit un code de suivi secret, gardé sur le téléphone du client. Il sert à suivre, annuler et noter la course. Le bouton « Lien de suivi » permet de suivre la course depuis un autre téléphone. Anti-abus : 3 demandes en attente maximum par numéro, 10 demandes par heure maximum par connexion.

Le téléphone du client n'est montré au livreur qu'après acceptation.

## Carte et recherche de lieux

- **Recherche** : le client tape « marché », « mosquée yène guedj », « école nditakh »… (sans se soucier des accents) et le point se place sur le lieu.
- **Noms des villages** affichés sur la carte ; les mosquées, écoles, santé, commerces apparaissent en zoomant.
- **Vue satellite uniquement** : on voit les maisons, cours et ruelles (imagerie Esri World Imagery, nette jusqu'au zoom 17 à Yène, agrandie au-delà). Les noms des villages, quartiers, rues et lieux sont affichés par-dessus ; le bouton en bas à gauche permet de les masquer, ainsi que la **limite de la commune** (pointillés rouges). ⚠️ C'est le seul élément **gratuit mais non libre** : l'imagerie appartient à Esri, utilisée sans clé ni paiement, avec attribution. Pour un service commercial à grande échelle, vérifier les conditions d'Esri (un compte gratuit avec quota peut être demandé). L'image Maxar d'OpenAerialMap (CC BY-NC) a été écartée car elle interdit l'usage commercial.
- **Raccourcis** vers les villages proches (Yène, Tode, Nditakh, Nianghal, Toubab Dialaw…) et bouton **⛶ Agrandir** pour la carte en plein écran.
- Les lieux viennent d'**OpenStreetMap** (`npm run lieux` les met à jour dans `data/lieux-osm.json`, puis `npm run init-db` les charge). L'admin ajoute dans la section **Lieux** ceux qui manquent (Yène Kao, Yène Kel, boutiques connues…).

## D'où viennent les lieux de la recherche

| Source | Contenu | Mise à jour |
|---|---|---|
| OpenStreetMap (ODbL) | villages, quartiers, rues, écoles, mosquées, santé… | `npm run lieux` |
| Overture Maps (données ouvertes Meta / Microsoft / Amazon / TomTom) | commerces, hôtels, restaurants, services… | `npm run overture` (Python + `pip install duckdb`) |
| Admin | repères connus de tous (Yène Kao, boutiques…) | page admin, section Lieux |
| **Livraisons réussies** | chaque course livrée propose ses repères (ex. « Boulangerie Ndiaye, Yène Kao ») avec la position exacte | l'admin valide en un clic |

Puis `npm run init-db` charge les fichiers dans la base (sans doublon). Les lieux appris des livraisons restent **invisibles tant que l'admin ne les a pas validés** : un repère privé (« maison de … ») ne doit jamais devenir public. Plus un repère revient dans les livraisons, plus il monte dans la liste à valider.

Google Places n'est pas utilisé : service payant, et ses conditions interdisent d'afficher ses résultats sur une autre carte que Google Maps.

## Paiement Wave / Orange Money (Nangu)

À la confirmation, le client choisit **Wave**, **Orange Money** ou **espèces à la livraison**. Le paiement en ligne passe par l'API Nangu (`https://api.nangu-pay.workers.dev`) ; l'argent arrive directement sur le compte Wave Business / Orange Money déclaré dans la console Nangu.

1. Le serveur crée le paiement chez Nangu (`POST /v1/payments`, référence `TT-<course>`, numéro du client, 30 minutes pour payer, une clé d'idempotence par course). La course reste **« en attente de paiement »** et invisible des livreurs.
2. Le client voit le **montant exact** (`amount_due`, parfois quelques francs de plus pour reconnaître son paiement), le bouton « Ouvrir Wave » / « Ouvrir Max it », le `#144#` et le code marchand, ou le QR code sur ordinateur.
3. Dès la confirmation, la course passe « en attente d'un livreur » et les livreurs sont prévenus ; le livreur voit **« Déjà payé : rien à encaisser »** (sauf les achats).
   - Confirmation officielle : **webhook signé** `POST /webhooks/nangu` (HMAC-SHA256 vérifié, chaque événement traité une seule fois).
   - Secours (utile en local sans webhook) : pendant que le client attend, le serveur relit l'état chez Nangu avec sa clé.
4. Paiement expiré ou annulé : commande annulée ; un paiement confirmé en retard la fait reprendre. Le client peut annuler avant de payer (le paiement est aussi annulé chez Nangu).

Configuration dans `.env` : `NANGU_SECRET_KEY` (`sk_test_…` pour essayer, `sk_live_…` en production), `NANGU_WEBHOOK_SECRET` (`whsec_…` du webhook déclaré sur `https://<adresse>/webhooks/nangu`), `NANGU_PROVIDERS` (`wave,orange_money`). Sans clé, seules les espèces sont proposées. La clé ne quitte jamais le serveur.

## Guidage du livreur (comme un GPS)

Dans la course en cours, **« Guider jusqu'au départ / à l'arrivée »** ouvre la carte satellite en plein écran avec :
- le trajet tracé, la position du livreur en direct et la carte qui le suit ;
- la prochaine manœuvre en grand (« 150 m · Tournez à droite », « Au rond-point, prenez la 2e sortie ») ;
- les annonces **vocales en français** (voix du téléphone, coupable) à 200 m et 40 m de chaque virage ;
- le temps et la distance restants, l'heure d'arrivée, le **recalcul automatique** si le livreur quitte le trajet ;
- l'écran maintenu allumé ; à l'arrivée au départ, le guidage enchaîne vers l'arrivée dès que le colis est marqué récupéré.

Itinéraires : **OSRM** sur les routes OpenStreetMap, serveur public gratuit de la FOSSGIS (`routing.openstreetmap.de`, usage raisonnable). Pour un gros volume, OSRM s'installe gratuitement sur votre propre serveur. Les ruelles non cartographiées dans OpenStreetMap ne sont pas connues : pour les derniers mètres, la vue satellite et l'appel au client prennent le relais. Le lien « Ouvrir dans une autre application GPS » reste disponible.

## Placer l'arrivée facilement

- **📲 Demander la position** : le client envoie un lien par WhatsApp ou SMS au destinataire (directement à son numéro s'il est rempli). Le destinataire ouvre `/position.html`, touche « Envoyer ma position », et le point B se place tout seul chez le client, en direct. Fonctionne aussi pour le départ (ex. boutique qui remet le colis). Lien valable 24 h.
- **Coller une position** dans la recherche : lien de localisation WhatsApp / Google Maps (`?q=`, `@lat,lng`), lien OpenStreetMap, `geo:` ou simples coordonnées `14.6391, -17.1734`.
- **📍 Je suis au départ / à l'arrivée** : le GPS du téléphone place le point en cours (utile quand le client attend lui-même la livraison).
- **🕘 Adresses récentes** : les points déjà utilisés sur ce téléphone, réutilisables d'un toucher.

## Structure

```
src/
  server.js            Express + Socket.io
  schema.sql           tables (utilisateurs, courses, abonnements_push, parametres)
  init-db.js           création de la base et du compte admin
  tarifs.js            calcul du prix
  push.js              notifications Web Push (clés VAPID générées dans .vapid.json)
  courses-service.js   diffusion des changements aux clients / livreurs / admins
  routes/              auth, courses (client), livreur, admin
public/
  index.html, livreur.html, admin.html, js/, css/, sw.js, manifest*.json
```

## Pistes pour la suite

- Paiement Wave / Orange Money
- Commande par WhatsApp ou par appel pour les personnes peu à l'aise avec le numérique
- Tarifs fixes par village au lieu de la distance
- Suivi de la position du livreur sur la carte du client
