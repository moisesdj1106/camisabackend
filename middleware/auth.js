import { verifyToken } from '../utils/auth.js';
import { addAuditLog } from '../data/store.js';

export const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

export const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  next();
};

export const audit = (action, tableName) => (req, res, next) => {
  res.on('finish', async () => {
    if (res.statusCode >= 200 && res.statusCode < 300 && req.user?.id) {
      await addAuditLog(req.user.id, action, tableName, req.body?.id || null, req.body);
    }
  });
  next();
};
