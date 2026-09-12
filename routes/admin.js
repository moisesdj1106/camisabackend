import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addAuditLog, createClub, createSalesClosure, createStoreContent, createUser, deleteClub, deleteOrder, deleteStoreContent, deleteUserAdmin, getAuditLogs, getDashboardStats, getExchangeRate, getOrdersAdmin, getSalesClosureSummary, getUserById, getUsersAdmin, listClubs, listStoreContent, resetRevenueMetrics, setExchangeRate, updateClub, updateOrderStatus, updateStoreContent, updateUserAdmin } from '../data/store.js';
import { authMiddleware, adminOnly } from '../middleware/auth.js';
import { hashPassword } from '../utils/auth.js';
import { createInvoicePdf } from '../utils/pdf.js';
import { uploadProductImage, uploadStoreContent } from '../utils/cloudinary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const adminRouter = express.Router();

adminRouter.post('/content/upload', authMiddleware, adminOnly, (req, res) => {
  req.app.locals.upload.single('file')(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.message || 'No se pudo procesar el archivo.' });
    if (!req.file) return res.status(400).json({ error: 'Debes seleccionar un archivo.' });
    uploadStoreContent(req.file.path, req.file.originalname)
      .then((mediaUrl) => {
        if (mediaUrl) {
          fs.unlink(req.file.path, () => {});
          return res.status(201).json({ media_url: mediaUrl, storage: 'cloudinary' });
        }
        if (process.env.NODE_ENV === 'production') {
          fs.unlink(req.file.path, () => {});
          return res.status(503).json({ error: 'Cloudinary no está configurado. Configura CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET en el backend.' });
        }
        res.status(201).json({ media_url: `/uploads/${req.file.filename}`, storage: 'local' });
      })
      .catch((uploadError) => {
        console.error('Error subiendo contenido a Cloudinary:', uploadError.message);
        res.status(502).json({ error: 'No se pudo guardar el archivo en la nube.' });
      });
  });
});

adminRouter.post('/products/upload-images', authMiddleware, adminOnly, (req, res) => {
  req.app.locals.upload.array('files', 10)(req, res, async (error) => {
    if (error) return res.status(400).json({ error: error.message || 'No se pudieron procesar las imágenes.' });
    if (!req.files?.length) return res.status(400).json({ error: 'Debes seleccionar al menos una imagen.' });

    try {
      const urls = [];
      for (const file of req.files) {
        const url = await uploadProductImage(file.path, file.originalname);
        if (!url) {
          if (process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Cloudinary no está configurado en el backend.' });
          urls.push(`/uploads/${file.filename}`);
        } else {
          urls.push(url);
          fs.unlink(file.path, () => {});
        }
      }
      res.status(201).json({ image_urls: urls });
    } catch (uploadError) {
      req.files.forEach((file) => fs.unlink(file.path, () => {}));
      console.error('Error subiendo imágenes del producto:', uploadError.message);
      res.status(502).json({ error: 'No se pudieron guardar las imágenes en la nube.' });
    }
  });
});

adminRouter.get('/content', authMiddleware, adminOnly, async (_req, res) => {
  res.json(await listStoreContent(false));
});

adminRouter.post('/content', authMiddleware, adminOnly, async (req, res) => {
  res.status(201).json(await createStoreContent(req.body || {}));
});

adminRouter.put('/content/:id', authMiddleware, adminOnly, async (req, res) => {
  const content = await updateStoreContent(Number(req.params.id), req.body || {});
  if (!content) return res.status(404).json({ error: 'Contenido no encontrado' });
  res.json(content);
});

adminRouter.delete('/content/:id', authMiddleware, adminOnly, async (req, res) => {
  await deleteStoreContent(Number(req.params.id));
  res.json({ success: true });
});

adminRouter.get('/dashboard', authMiddleware, adminOnly, async (req, res) => {
  const summary = await getDashboardStats();
  res.json(summary);
});

adminRouter.post('/metrics/reset', authMiddleware, adminOnly, async (req, res) => {
  const resetAt = await resetRevenueMetrics();
  await addAuditLog(req.user.id, 'RESET_REVENUE_METRICS', 'system_settings', null, { resetAt });
  res.json({ resetAt });
});

adminRouter.get('/exchange-rate', async (req, res) => {
  const rate = await getExchangeRate();
  res.json({ exchangeRate: rate });
});

adminRouter.get('/closures', authMiddleware, adminOnly, async (req, res) => {
  const summary = await getSalesClosureSummary(req.query.period || 'day', req.query.date || new Date().toISOString());
  res.json(summary);
});

adminRouter.post('/closures', authMiddleware, adminOnly, async (req, res) => {
  const summary = await createSalesClosure(req.body?.periodType || 'day', req.body?.referenceDate || new Date().toISOString());
  res.json(summary);
});

adminRouter.put('/exchange-rate', authMiddleware, adminOnly, async (req, res) => {
  const rate = await setExchangeRate(req.body?.rate);
  res.json({ exchangeRate: rate });
});

adminRouter.get('/orders', authMiddleware, adminOnly, async (req, res) => {
  const orders = await getOrdersAdmin();
  const ordersWithClient = await Promise.all(orders.map(async (order) => ({
    ...order,
    client: await getUserById(order.client_id)
  })));
  res.json(ordersWithClient);
});

adminRouter.put('/orders/:id/status', authMiddleware, adminOnly, async (req, res) => {
  const order = await updateOrderStatus(Number(req.params.id), req.body.status, req.user.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json(order);
});

adminRouter.delete('/orders/:id', authMiddleware, adminOnly, async (req, res) => {
  const deleted = await deleteOrder(Number(req.params.id), req.user.id);
  if (!deleted) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ success: true, id: Number(req.params.id) });
});

adminRouter.get('/users', authMiddleware, adminOnly, async (_req, res) => {
  res.json(await getUsersAdmin());
});

adminRouter.post('/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body || {};
    if (!String(name || '').trim() || !String(email || '').trim() || String(password || '').length < 6) {
      return res.status(400).json({ error: 'Nombre, correo y una contraseña de al menos 6 caracteres son obligatorios.' });
    }
    const user = await createUser({
      name: String(name).trim(),
      email: String(email).trim(),
      phone: String(phone || '').trim(),
      password: await hashPassword(password),
      role: role === 'admin' ? 'admin' : 'client'
    });
    await addAuditLog(req.user.id, 'CREATE_USER', 'users', user.id, { name: user.name, email: user.email, role: user.role });
    res.status(201).json(await getUserById(user.id));
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Ese correo ya está registrado.' });
    res.status(500).json({ error: 'No se pudo crear el usuario.' });
  }
});

adminRouter.put('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await updateUserAdmin(Number(req.params.id), req.body);
    if (!user) return res.status(400).json({ error: 'Datos de usuario inválidos.' });
    await addAuditLog(req.user.id, 'UPDATE_USER', 'users', user.id, { name: user.name, email: user.email, phone: user.phone, role: user.role });
    res.json(user);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Ese correo ya está registrado.' });
    res.status(500).json({ error: 'No se pudo actualizar el usuario.' });
  }
});

adminRouter.delete('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const result = await deleteUserAdmin(Number(req.params.id), req.user.id);
  if (result.error) return res.status(400).json(result);
  await addAuditLog(req.user.id, 'DELETE_USER', 'users', Number(req.params.id), {});
  res.json(result);
});

adminRouter.get('/audit-logs', authMiddleware, adminOnly, async (req, res) => {
  const logs = await getAuditLogs();
  res.json(logs);
});

adminRouter.get('/clubs', authMiddleware, adminOnly, async (req, res) => {
  const clubs = await listClubs();
  res.json(clubs);
});

adminRouter.get('/orders/:id/invoice', authMiddleware, adminOnly, async (req, res) => {
  const { getOrderDetailById } = await import('../data/store.js');
  const detail = await getOrderDetailById(Number(req.params.id), null, true);
  if (!detail) return res.status(404).json({ error: 'Pedido no encontrado' });
  const invoiceBuffer = await createInvoicePdf(detail.order, detail.items, detail.client, { exchangeRate: detail.order.exchange_rate || await getExchangeRate() });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="factura-pedido-${detail.order.id}.pdf"`);
  res.send(invoiceBuffer);
});

adminRouter.post('/clubs', authMiddleware, adminOnly, async (req, res) => {
  const club = await createClub(req.body);
  await addAuditLog(req.user.id, 'CREATE_CLUB', 'clubs', club.id, { club });
  res.status(201).json(club);
});

adminRouter.put('/clubs/:id', authMiddleware, adminOnly, async (req, res) => {
  const club = await updateClub(Number(req.params.id), req.body);
  if (!club) return res.status(404).json({ error: 'Club no encontrado' });
  await addAuditLog(req.user.id, 'UPDATE_CLUB', 'clubs', club.id, { club });
  res.json(club);
});

adminRouter.delete('/clubs/:id', authMiddleware, adminOnly, async (req, res) => {
  await deleteClub(Number(req.params.id));
  res.json({ success: true });
});
