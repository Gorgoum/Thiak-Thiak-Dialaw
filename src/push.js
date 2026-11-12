const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { query } = require('./db');

// Clés VAPID : depuis .env, sinon depuis .vapid.json, sinon générées une fois pour toutes.
let cles = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
if (!cles.publicKey || !cles.privateKey) {
  const fichier = path.join(__dirname, '..', '.vapid.json');
  if (fs.existsSync(fichier)) {
    cles = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  } else {
    cles = webpush.generateVAPIDKeys();
    fs.writeFileSync(fichier, JSON.stringify(cles, null, 2));
    console.log('Clés VAPID générées dans .vapid.json (à conserver).');
  }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:contact@thiakthiak.sn', cles.publicKey, cles.privateKey);

/** Envoie une notification à un abonnement. Renvoie false si l'abonnement a expiré. */
async function envoyerA(abonnement, contenu) {
  try {
    await webpush.sendNotification(abonnement, JSON.stringify(contenu), { TTL: 600, urgency: 'high' });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) return false;
    console.error('Échec push :', e.statusCode || e.message);
    return true;
  }
}

/** Envoie une notification aux comptes donnés (livreurs, admin). Les abonnements expirés sont supprimés. */
async function envoyer(userIds, contenu) {
  if (!userIds.length) return;
  const r = await query('SELECT id, abonnement FROM abonnements_push WHERE utilisateur_id = ANY($1::int[])', [userIds.map(Number)]);
  await Promise.all(r.rows.map(async (ligne) => {
    if (!(await envoyerA(ligne.abonnement, contenu))) {
      await query('DELETE FROM abonnements_push WHERE id = $1', [ligne.id]);
    }
  }));
}

module.exports = { clePublique: () => cles.publicKey, envoyer, envoyerA };
