import express from 'express';
import path from 'path';
import fs from 'fs';
import { addAuditLog, createOrder, getOrderDetailById, getOrdersForUser, getUserById, getExchangeRate, getProductById, updateOrderInvoice } from '../data/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { createInvoicePdf } from '../utils/pdf.js';
import { uploadDir } from '../utils/storage.js';
import { uploadProof } from '../utils/cloudinary.js';

export const ordersRouter = express.Router();

ordersRouter.post('/', authMiddleware, (req, res) => {
  const upload = req.app.locals.upload.single('proof');
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: 'No se pudo procesar la imagen del comprobante.' });
    }

    let { items, payment_method, payment_proof_url } = req.body;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch (error) {
        items = [];
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío.' });
    }

    if (!payment_method) {
      return res.status(400).json({ error: 'Debes seleccionar un método de pago.' });
    }

    let proofUrl = payment_proof_url || null;
    if (req.file) {
      try {
        const cloudinaryUrl = await uploadProof(req.file.path);
        proofUrl = cloudinaryUrl || `/uploads/${req.file.filename}`;
      } catch (error) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'No se pudo guardar el comprobante en el almacenamiento.' });
      }
      if (proofUrl.startsWith('https://res.cloudinary.com')) {
        fs.unlink(req.file.path, () => {});
      }
    }

    const result = await createOrder({
      userId: req.user.id,
      items,
      paymentMethod: payment_method,
      paymentProofUrl: proofUrl
    });

    const invoiceItems = await Promise.all((items || []).map(async (item) => {
      const product = await getProductById(Number(item.product_id));
      return {
        ...item,
        product_title: product?.title || item.product_title || null
      };
    }));

    await addAuditLog(req.user.id, 'CREATE_ORDER', 'orders', result.order.id, { order: result.order });
    const user = await getUserById(req.user.id);
    const exchangeRate = await getExchangeRate();
    const invoiceBuffer = await createInvoicePdf(result.order, invoiceItems, user, { exchangeRate });
    const invoicePath = path.join(uploadDir, `invoice-${result.order.id}.pdf`);
    fs.writeFileSync(invoicePath, invoiceBuffer);
    await updateOrderInvoice(result.order.id, invoicePath, `INV-${String(result.order.id).padStart(4, '0')}`);
    res.status(201).json({ order: result.order, invoiceBuffer: invoiceBuffer.toString('base64') });
  });
});

ordersRouter.get('/mine', authMiddleware, async (req, res) => {
  const orders = await getOrdersForUser(req.user.id);
  res.json(orders);
});

ordersRouter.get('/:id', authMiddleware, async (req, res) => {
  const detail = await getOrderDetailById(Number(req.params.id), req.user.id, req.user.role === 'admin');
  if (!detail) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json(detail);
});

ordersRouter.get('/:id/invoice', authMiddleware, async (req, res) => {
  const detail = await getOrderDetailById(Number(req.params.id), req.user.id, req.user.role === 'admin');
  if (!detail) return res.status(404).json({ error: 'Pedido no encontrado' });
  const exchangeRate = detail.order.exchange_rate || await getExchangeRate();
  const invoiceBuffer = await createInvoicePdf(detail.order, detail.items, detail.client, { exchangeRate });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="factura-pedido-${detail.order.id}.pdf"`);
  res.send(invoiceBuffer);
});
