import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addAuditLog, createClub, createSalesClosure, deleteClub, deleteOrder, getAuditLogs, getDashboardStats, getExchangeRate, getOrdersAdmin, getSalesClosureSummary, getUserById, listClubs, resetRevenueMetrics, setExchangeRate, updateClub, updateOrderStatus } from '../data/store.js';
import { authMiddleware, adminOnly } from '../middleware/auth.js';
import { createInvoicePdf } from '../utils/pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const adminRouter = express.Router();

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
