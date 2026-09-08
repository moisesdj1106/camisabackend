import express from 'express';
import { addAuditLog, createUser, findUserByEmail, updateUserPasswordByContact } from '../data/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { hashPassword, comparePassword, signToken } from '../utils/auth.js';
import { getNotificationsForUser, markNotificationAsRead, clearNotifications } from '../utils/notifications.js';

export const authRouter = express.Router();

authRouter.use('/me', authMiddleware);

authRouter.get('/me/notifications', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });
  res.json(getNotificationsForUser(userId));
});

authRouter.post('/me/notifications/:id/read', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });
  const notification = markNotificationAsRead(req.params.id, userId);
  res.json(notification || { success: false });
});

authRouter.delete('/me/notifications', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });
  clearNotifications(userId);
  res.json({ success: true });
});

authRouter.post('/register', async (req, res) => {
  const { name, email, phone, password } = req.body;

  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    return res.status(400).json({ error: 'El email ya existe' });
  }

  const newUser = await createUser({
    name,
    email,
    phone,
    password: await hashPassword(password),
    role: 'client'
  });

  await addAuditLog(newUser.id, 'REGISTER', 'users', newUser.id, { email });

  const token = signToken({ id: newUser.id, role: newUser.role });
  res.status(201).json({ token, user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role } });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await findUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

  const valid = await comparePassword(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

  const token = signToken({ id: user.id, role: user.role });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

authRouter.post('/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();
  const password = String(req.body.password || '');

  if (!email || !phone || password.length < 6) {
    return res.status(400).json({ error: 'Indica correo, teléfono y una contraseña de al menos 6 caracteres.' });
  }

  const user = await updateUserPasswordByContact(email, phone, await hashPassword(password));
  if (!user) {
    return res.status(400).json({ error: 'El correo y el teléfono no coinciden con una cuenta registrada.' });
  }

  await addAuditLog(user.id, 'RESET_PASSWORD', 'users', user.id, { email });
  res.json({ message: 'Contraseña actualizada correctamente.' });
});
