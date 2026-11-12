require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { verifier } = require('./auth');
const push = require('./push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);

app.set('trust proxy', 'loopback'); // vraie IP du client derrière un tunnel local (cloudflared)
// Webhook Nangu : le corps BRUT est indispensable pour vérifier la signature (avant express.json)
app.post('/webhooks/nangu', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
  const nangu = require('./nangu');
  const brut = req.body ? req.body.toString('utf8') : '';
  if (!nangu.verifierSignature(brut, req.headers['x-signature'])) return res.status(400).json({ erreur: 'Signature invalide' });
  let evt;
  try { evt = JSON.parse(brut); } catch { return res.status(400).json({ erreur: 'Corps illisible' }); }
  try {
    await require('./paiements').traiterEvenement(io, evt);
    res.json({ ok: true }); // répondre vite : Nangu réessaie sinon
  } catch (e) {
    console.error('Webhook Nangu :', e.message);
    res.status(500).json({ erreur: 'Erreur de traitement' }); // Nangu renverra l'événement
  }
});

app.use(express.json({ limit: '100kb' }));

// Ce que la page client doit savoir (moyens de paiement en ligne disponibles)
app.get('/api/config', (req, res) => {
  const nangu = require('./nangu');
  res.json({ paiement_en_ligne: nangu.fournisseurs(), paiement_test: nangu.actif() && nangu.modeTest() });
});
app.use(express.static(path.join(__dirname, '..', 'public')));
// Leaflet (carte, BSD-2) servi par notre serveur : aucune dépendance à un CDN externe
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
// Police Inter (licence OFL) servie localement
app.use('/vendor/inter', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource-variable', 'inter', 'files'), { maxAge: '30d' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/livreur', require('./routes/livreur'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/positions', require('./routes/positions'));
app.get('/api/push/cle', (req, res) => res.json({ cle: push.clePublique() }));
app.get('/api/lieux', async (req, res, next) => {
  try {
    const r = await require('./db').query('SELECT id, nom, categorie, lat, lng, source FROM lieux WHERE valide ORDER BY nom');
    res.set('Cache-Control', 'no-cache').json(r.rows); // toujours à jour après une validation
  } catch (e) { next(e); }
});

app.use('/api', (req, res) => res.status(404).json({ erreur: 'Route inconnue' }));
app.use((err, req, res, next) => {
  // erreur prévue (ex. hors zone) : message clair pour l'utilisateur
  if (err.statut && err.statut < 500) return res.status(err.statut).json({ erreur: err.message });
  console.error(err);
  res.status(500).json({ erreur: 'Erreur serveur, réessayez' });
});

// Temps réel : chaque utilisateur rejoint sa salle, les livreurs et admins leur salle commune
// Les clients (sans compte) rejoignent la salle de suivi de chacune de leurs courses grâce au code secret.
io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  if (auth.token) {
    try { socket.user = verifier(auth.token); } catch { return next(new Error('non autorisé')); }
    return next();
  }
  if (Array.isArray(auth.suivi)) return next();
  next(new Error('non autorisé'));
});
io.on('connection', (socket) => {
  if (socket.user) {
    socket.join('user:' + socket.user.id);
    if (socket.user.role === 'livreur') socket.join('livreurs');
    if (socket.user.role === 'admin') socket.join('admins');
  }
  const codes = (socket.handshake.auth.suivi || []).filter((c) => typeof c === 'string').slice(0, 30);
  codes.forEach((c) => socket.join('suivi:' + c));
  socket.on('suivre', (c) => { if (typeof c === 'string') socket.join('suivi:' + c); });
  socket.on('attendre-position', (c) => { if (typeof c === 'string') socket.join('position:' + c); });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Thiak Thiak Dialaw démarré sur http://localhost:${PORT}`);
  console.log(`  Client  : http://localhost:${PORT}/`);
  console.log(`  Livreur : http://localhost:${PORT}/livreur.html`);
  console.log(`  Admin   : http://localhost:${PORT}/admin.html`);
});
