const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-a-changer';
if (!process.env.JWT_SECRET) console.warn('⚠ JWT_SECRET absent : secret de développement utilisé.');

/** Ramène un numéro sénégalais à 9 chiffres (771234567), ou null s'il est invalide. */
function normaliserTel(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (d.startsWith('00221')) d = d.slice(5);
  else if (d.startsWith('221') && d.length === 12) d = d.slice(3);
  return /^7\d{8}$/.test(d) ? d : null;
}

function signer(u) {
  return jwt.sign({ id: u.id, role: u.role, nom: u.nom }, SECRET, { expiresIn: '30d' });
}

function verifier(token) {
  return jwt.verify(token, SECRET);
}

/** Middleware : exige un jeton valide, et éventuellement un des rôles donnés. */
function exiger(...roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ erreur: 'Connexion requise' });
    try {
      req.user = verifier(token);
    } catch {
      return res.status(401).json({ erreur: 'Session expirée, reconnectez-vous' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ erreur: 'Accès refusé' });
    }
    next();
  };
}

/** Enveloppe une route async pour que les erreurs aillent au gestionnaire d'erreurs Express. */
const a = (fn) => (req, res, next) => fn(req, res, next).catch(next);

module.exports = { normaliserTel, signer, verifier, exiger, a };
