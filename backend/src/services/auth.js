import jwt from 'jsonwebtoken';
const SECRET = process.env.JWT_SECRET || 'ganti-secret-ini';

export function signToken(agent) {
  return jwt.sign({ id: agent.id, role: agent.role, name: agent.name }, SECRET, { expiresIn: '12h' });
}

// Verifikasi token mentah (dipakai socket auth). Mengembalikan payload atau null.
export function verifyToken(token) {
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

export function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Tidak ada token' });
  try {
    req.agent = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token tidak valid' });
  }
}

// Auth khusus webhook dari WA service (pakai shared secret)
export function webhookAuth(req, res, next) {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== (process.env.WEBHOOK_SECRET || 'webhook-secret')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}
