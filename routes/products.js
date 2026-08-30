import express from 'express';
import { createProduct, deleteProduct, getProductById, listProducts, updateProduct } from '../data/store.js';
import { authMiddleware, adminOnly, audit } from '../middleware/auth.js';

export const productsRouter = express.Router();

productsRouter.get('/', async (req, res) => {
  const { club, type, minPrice, maxPrice, q } = req.query;
  const products = await listProducts({ club, type, minPrice, maxPrice, q });
  res.json(products);
});

productsRouter.get('/:id', async (req, res) => {
  const product = await getProductById(Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(product);
});

productsRouter.post('/', authMiddleware, adminOnly, audit('CREATE_PRODUCT', 'products'), async (req, res) => {
  try {
    const product = await createProduct({
      ...req.body,
      price: Number(req.body.price),
      stock: Number(req.body.stock),
      club_id: Number(req.body.club_id),
      is_active: req.body.is_active !== false
    });
    res.status(201).json(product);
  } catch (error) {
    console.error('Error creando producto:', error.message);
    res.status(500).json({ error: 'No se pudo guardar la camiseta', details: error.message });
  }
});

productsRouter.put('/:id', authMiddleware, adminOnly, audit('UPDATE_PRODUCT', 'products'), async (req, res) => {
  const product = await updateProduct(Number(req.params.id), {
    ...req.body,
    price: Number(req.body.price),
    stock: Number(req.body.stock)
  });
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(product);
});

productsRouter.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  await deleteProduct(Number(req.params.id));
  res.json({ success: true });
});
