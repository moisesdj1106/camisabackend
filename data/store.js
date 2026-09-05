import fs from 'fs';
import pkg from 'pg';
import { sendOrderApprovedEmail } from '../utils/mail.js';
import { createNotification } from '../utils/notifications.js';
import { uploadDir } from '../utils/storage.js';

const { Pool } = pkg;

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'camisa',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const ensureAutoIncrementColumn = async (tableName, columnName) => {
  try {
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${tableName}_${columnName}_seq`);
    await pool.query(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT nextval('${tableName}_${columnName}_seq');`);
    await pool.query(`SELECT setval('${tableName}_${columnName}_seq', COALESCE((SELECT MAX(${columnName}) + 1 FROM ${tableName}), 1), false);`);
  } catch (error) {
    console.warn(`No se pudo ajustar la columna ${tableName}.${columnName}:`, error.message);
  }
};

const mapUser = (row) => (row ? {
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  password: row.password,
  role: row.role,
  created_at: row.created_at
} : null);

const parseImageUrls = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (error) {
      // Ignore invalid JSON and fall back to comma-separated parsing
    }
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
};

const normalizeProductPayload = (payload = {}) => {
  const imageUrls = parseImageUrls(payload.image_urls ?? payload.images ?? []);
  const primaryImage = payload.image_url || imageUrls[0] || null;
  if (primaryImage && imageUrls.length === 0) imageUrls.push(primaryImage);
  return {
    ...payload,
    image_url: primaryImage,
    image_urls: imageUrls
  };
};

const PRODUCT_COLUMN_KEYS = new Set(['club_id', 'title', 'description', 'price', 'stock', 'type', 'is_active', 'image_url', 'image_urls']);

const getDefaultExchangeRate = () => {
  const configured = Number(process.env.DEFAULT_EXCHANGE_RATE || 36);
  return Number.isFinite(configured) && configured > 0 ? configured : 36;
};

const getProductFieldEntries = (payload) => {
  const normalizedPayload = normalizeProductPayload(payload);
  return Object.entries(normalizedPayload).reduce((acc, [key, value]) => {
    if (value === undefined || key === 'id' || !PRODUCT_COLUMN_KEYS.has(key)) return acc;
    acc.push([key, key === 'image_urls' ? JSON.stringify(value) : value]);
    return acc;
  }, []);
};

const mapProduct = (row) => (row ? {
  id: row.id,
  club_id: row.club_id,
  title: row.title,
  description: row.description,
  price: Number(row.price),
  stock: Number(row.stock),
  type: row.type,
  is_active: row.is_active,
  created_at: row.created_at,
  image_url: row.image_url || (parseImageUrls(row.image_urls)[0] || null),
  image_urls: parseImageUrls(row.image_urls)
} : null);

const mapDorsal = (row) => (row ? {
  id: row.id,
  product_id: row.product_id,
  dorsal_number: row.dorsal_number,
  player_name: row.player_name,
  is_available: row.is_available
} : null);

const mapOrder = (row) => (row ? {
  id: row.id,
  client_id: row.client_id,
  total_amount: Number(row.total_amount),
  payment_method: row.payment_method,
  payment_proof_url: row.payment_proof_url,
  status: row.status,
  exchange_rate: row.exchange_rate ? Number(row.exchange_rate) : null,
  invoice_path: row.invoice_path || null,
  invoice_number: row.invoice_number || null,
  created_at: row.created_at
} : null);

const mapOrderItem = (row) => (row ? {
  id: row.id,
  order_id: row.order_id,
  product_id: row.product_id,
  product_title: row.product_title,
  dorsal_number: row.dorsal_number,
  dorsal_name: row.dorsal_name,
  quantity: Number(row.quantity),
  unit_price: Number(row.unit_price)
} : null);

export const getExchangeRate = async () => {
  const result = await pool.query("SELECT value FROM system_settings WHERE key = 'usd_to_ves'");
  if (result.rows.length > 0) {
    const rate = Number(result.rows[0].value);
    return Number.isFinite(rate) && rate > 0 ? rate : getDefaultExchangeRate();
  }
  return getDefaultExchangeRate();
};

export const setExchangeRate = async (rate) => {
  const normalizedRate = Number(rate);
  const safeRate = Number.isFinite(normalizedRate) && normalizedRate > 0 ? normalizedRate : getDefaultExchangeRate();
  await pool.query(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('usd_to_ves', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [String(safeRate)]);
  return safeRate;
};

export const getMetricsResetAt = async () => {
  const result = await pool.query("SELECT value FROM system_settings WHERE key = 'metrics_reset_at'");
  return result.rows[0]?.value || null;
};

export const resetRevenueMetrics = async () => {
  const resetAt = new Date().toISOString();
  await pool.query(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('metrics_reset_at', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [resetAt]);
  return resetAt;
};

export const listClubs = async () => {
  const result = await pool.query('SELECT * FROM clubs ORDER BY id ASC');
  return result.rows.map((row) => ({ id: Number(row.id), name: row.name, country: row.country, logo_url: row.logo_url }));
};

export const createClub = async (payload) => {
  const idResult = await pool.query('SELECT COALESCE(MAX(id), 0)::int AS max_id FROM clubs');
  const nextId = Number(idResult.rows[0].max_id) + 1;
  const result = await pool.query(
    'INSERT INTO clubs (id, name, country, logo_url) VALUES ($1, $2, $3, $4) RETURNING *',
    [nextId, payload.name, payload.country || null, payload.logo_url || null]
  );
  return result.rows[0];
};

export const updateClub = async (id, payload) => {
  const fields = [];
  const values = [];
  Object.entries(payload).forEach(([key, value]) => {
    if (value === undefined || key === 'id') return;
    fields.push(`${key} = $${fields.length + 1}`);
    values.push(value);
  });
  values.push(id);
  const result = await pool.query(`UPDATE clubs SET ${fields.join(', ')} WHERE id = $${fields.length + 1} RETURNING *`, values);
  return result.rows[0];
};

export const deleteClub = async (id) => {
  await pool.query('UPDATE products SET club_id = NULL WHERE club_id = $1', [id]);
  await pool.query('DELETE FROM clubs WHERE id = $1', [id]);
};

export const initializeStore = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      phone VARCHAR(50),
      password TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'client',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clubs (
      id INTEGER PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      country VARCHAR(100),
      logo_url TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      club_id INTEGER REFERENCES clubs(id),
      title VARCHAR(200) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      type VARCHAR(20) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      image_url TEXT,
      image_urls JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_urls JSONB DEFAULT '[]'::jsonb;`);

  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS logo_url TEXT;`);

  await ensureAutoIncrementColumn('users', 'id');
  await ensureAutoIncrementColumn('products', 'id');
  await ensureAutoIncrementColumn('product_dorsals', 'id');
  await ensureAutoIncrementColumn('orders', 'id');
  await ensureAutoIncrementColumn('order_items', 'id');
  await ensureAutoIncrementColumn('audit_logs', 'id');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_dorsals (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id),
      dorsal_number INTEGER NOT NULL,
      player_name VARCHAR(150),
      is_available BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,2) DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_path TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES users(id),
      total_amount DECIMAL(10,2) NOT NULL,
      payment_method VARCHAR(30) NOT NULL,
      payment_proof_url TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id),
      product_id INTEGER REFERENCES products(id),
      dorsal_number INTEGER,
      dorsal_name VARCHAR(150),
      quantity INTEGER NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      action VARCHAR(100) NOT NULL,
      table_name VARCHAR(100) NOT NULL,
      record_id INTEGER,
      changes JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_closures (
      id SERIAL PRIMARY KEY,
      period_type VARCHAR(20) NOT NULL,
      period_label TEXT NOT NULL,
      start_date TIMESTAMP NOT NULL,
      end_date TIMESTAMP NOT NULL,
      total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      orders_count INTEGER NOT NULL DEFAULT 0,
      items_sold INTEGER NOT NULL DEFAULT 0,
      details JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`ALTER TABLE audit_logs ALTER COLUMN id SET DEFAULT nextval('audit_logs_id_seq');`);

  await seedDemoData();
};

export const seedDemoData = async () => {
  const clubsCount = await pool.query('SELECT COUNT(*)::int AS count FROM clubs');
  if (clubsCount.rows[0].count > 0) return;

  await pool.query(`
    INSERT INTO clubs (id, name, country, logo_url) VALUES
      (1, 'Barcelona', 'España', 'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=300&q=80'),
      (2, 'Real Madrid', 'España', 'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=300&q=80'),
      (3, 'Boca Juniors', 'Argentina', 'https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=300&q=80');
  `);

  await pool.query(`
    INSERT INTO products (id, club_id, title, description, price, stock, type, is_active, image_url) VALUES
      (1, 1, 'Camiseta Local Barça 2025', 'Modelo oficial de la temporada.', 89.99, 12, 'local', true, 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80'),
      (2, 2, 'Camiseta Visitante Madrid', 'Diseño premium con tecnología transpirable.', 94.50, 0, 'visitante', true, 'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=800&q=80'),
      (3, 3, 'Tercera Boca Juniors', 'Edición limitada con detalles premium.', 72.00, 7, 'tercera', true, 'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=800&q=80');
  `);

  await pool.query(`
    INSERT INTO product_dorsals (product_id, dorsal_number, player_name, is_available) VALUES
      (1, 10, 'Lewandowski', true),
      (1, 8, 'Pedri', true),
      (2, 7, 'Vinicius', false),
      (3, 11, 'Cavani', true);
  `);

  await pool.query(`
    INSERT INTO users (name, email, phone, password, role) VALUES
      ('Admin Demo', 'admin@camisetas.com', '+58 4120000000', '$2b$10$B2Txb3KUEpnmGppd.EJQvO.2W9tQ0.0hRmdrMsyxUJSrNqC/39ia6', 'admin');
  `);

  await setExchangeRate(Number(process.env.DEFAULT_EXCHANGE_RATE || 36));
};

export const findUserByEmail = async (email) => {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return mapUser(result.rows[0]);
};

export const createUser = async (payload) => {
  const result = await pool.query(
    'INSERT INTO users (name, email, phone, password, role) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [payload.name, payload.email, payload.phone, payload.password, payload.role || 'client']
  );
  return mapUser(result.rows[0]);
};

export const listProducts = async (filters = {}) => {
  let query = `
    SELECT p.*, c.id AS club_id_ref, c.name AS club_name, c.country AS club_country, c.logo_url AS club_logo_url
    FROM products p
    LEFT JOIN clubs c ON c.id = p.club_id
    WHERE 1 = 1
  `;
  const values = [];

  if (filters.q) {
    values.push(`%${filters.q}%`);
    query += ` AND p.title ILIKE $${values.length}`;
  }
  if (filters.club) {
    values.push(Number(filters.club));
    query += ` AND p.club_id = $${values.length}`;
  }
  if (filters.type) {
    values.push(filters.type);
    query += ` AND p.type = $${values.length}`;
  }
  if (filters.minPrice !== undefined) {
    values.push(Number(filters.minPrice));
    query += ` AND p.price >= $${values.length}`;
  }
  if (filters.maxPrice !== undefined) {
    values.push(Number(filters.maxPrice));
    query += ` AND p.price <= $${values.length}`;
  }

  query += ' ORDER BY p.id ASC';
  const result = await pool.query(query, values);
  return result.rows.map((row) => ({
    ...mapProduct(row),
    club: row.club_name ? { id: row.club_id_ref, name: row.club_name, country: row.club_country, logo_url: row.club_logo_url } : null
  }));
};

export const getProductById = async (id) => {
  const productRes = await pool.query(`
    SELECT p.*, c.id AS club_id_ref, c.name AS club_name, c.country AS club_country, c.logo_url AS club_logo_url
    FROM products p
    LEFT JOIN clubs c ON c.id = p.club_id
    WHERE p.id = $1
  `, [id]);
  if (productRes.rows.length === 0) return null;
  const dorsalsRes = await pool.query('SELECT * FROM product_dorsals WHERE product_id = $1 ORDER BY dorsal_number ASC', [id]);
  const product = productRes.rows[0];
  return {
    ...mapProduct(product),
    club: product.club_name ? { id: product.club_id_ref, name: product.club_name, country: product.club_country, logo_url: product.club_logo_url } : null,
    dorsals: dorsalsRes.rows.map(mapDorsal)
  };
};

const parseDorsalOptions = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
};

export const syncProductDorsals = async (productId, dorsalOptions = []) => {
  await pool.query('DELETE FROM product_dorsals WHERE product_id = $1', [productId]);
  const options = parseDorsalOptions(dorsalOptions).map((item) => String(item));
  for (const option of options) {
    const dorsalNumber = Number(option);
    if (Number.isNaN(dorsalNumber)) continue;
    await pool.query(
      'INSERT INTO product_dorsals (product_id, dorsal_number, player_name, is_available) VALUES ($1, $2, $3, $4)',
      [productId, dorsalNumber, '', true]
    );
  }
};

export const createProduct = async (payload) => {
  const normalizedPayload = normalizeProductPayload(payload);
  const idResult = await pool.query('SELECT COALESCE(MAX(id), 0)::int AS max_id FROM products');
  const nextId = Number(idResult.rows[0].max_id) + 1;

  const result = await pool.query(
    'INSERT INTO products (id, club_id, title, description, price, stock, type, is_active, image_url, image_urls) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
    [nextId, normalizedPayload.club_id, normalizedPayload.title, normalizedPayload.description || '', normalizedPayload.price, normalizedPayload.stock, normalizedPayload.type, normalizedPayload.is_active !== false, normalizedPayload.image_url || null, JSON.stringify(normalizedPayload.image_urls || [])]
  );
  const product = mapProduct(result.rows[0]);
  await syncProductDorsals(product.id, payload.dorsal_options || payload.dorsals || []);
  return product;
};

export const updateProduct = async (id, payload) => {
  const fieldEntries = getProductFieldEntries(payload);
  if (fieldEntries.length === 0) {
    return null;
  }

  const fields = [];
  const values = [];
  fieldEntries.forEach(([key, value]) => {
    fields.push(`${key} = $${fields.length + 1}`);
    values.push(value);
  });
  values.push(id);
  const result = await pool.query(`UPDATE products SET ${fields.join(', ')} WHERE id = $${fields.length + 1} RETURNING *`, values);
  const product = mapProduct(result.rows[0]);
  if (product) await syncProductDorsals(product.id, payload.dorsal_options || payload.dorsals || []);
  return product;
};

export const deleteProduct = async (id) => {
  await pool.query('DELETE FROM product_dorsals WHERE product_id = $1', [id]);
  await pool.query('DELETE FROM products WHERE id = $1', [id]);
};

export const createOrder = async ({ userId, items, paymentMethod, paymentProofUrl }) => {
  const totalAmount = items.reduce((sum, item) => sum + Number(item.unit_price) * Number(item.quantity), 0);
  const exchangeRate = await getExchangeRate();
  const orderRes = await pool.query(
    'INSERT INTO orders (client_id, total_amount, payment_method, payment_proof_url, status, exchange_rate) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [userId, Number(totalAmount).toFixed(2), paymentMethod, paymentProofUrl || null, 'pending', Number(exchangeRate).toFixed(2)]
  );
  const order = mapOrder(orderRes.rows[0]);
  for (const item of items) {
    await pool.query(
      'INSERT INTO order_items (order_id, product_id, dorsal_number, dorsal_name, quantity, unit_price) VALUES ($1, $2, $3, $4, $5, $6)',
      [order.id, item.product_id, item.dorsal_number || null, item.dorsal_name || null, item.quantity, item.unit_price]
    );
  }
  return { order, items };
};

export const getOrdersForUser = async (userId) => {
  const result = await pool.query('SELECT * FROM orders WHERE client_id = $1 ORDER BY id DESC', [userId]);
  const orders = await Promise.all(result.rows.map(async (row) => {
    const order = mapOrder(row);
    const itemsResult = await pool.query(`
      SELECT oi.*, p.title AS product_title
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
    `, [order.id]);
    return {
      ...order,
      items: itemsResult.rows.map(mapOrderItem)
    };
  }));
  return orders;
};

export const getOrdersAdmin = async () => {
  const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
  return result.rows.map(mapOrder);
};

export const getOrderItemsByOrderId = async (orderId) => {
  const result = await pool.query(`
    SELECT oi.*, p.title AS product_title
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = $1
    ORDER BY oi.id ASC
  `, [orderId]);
  return result.rows.map(mapOrderItem);
};

export const updateOrderInvoice = async (orderId, invoicePath, invoiceNumber) => {
  await pool.query('UPDATE orders SET invoice_path = $1, invoice_number = $2 WHERE id = $3', [invoicePath, invoiceNumber, orderId]);
};

export const getOrderDetailById = async (orderId, userId = null, isAdmin = false) => {
  const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (orderResult.rows.length === 0) return null;
  const order = mapOrder(orderResult.rows[0]);
  if (!isAdmin && userId !== null && order.client_id !== userId) return null;
  const itemsResult = await pool.query(`
    SELECT oi.*, p.title AS product_title
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = $1
  `, [orderId]);
  const clientResult = await pool.query('SELECT * FROM users WHERE id = $1', [order.client_id]);
  return {
    order,
    items: itemsResult.rows.map(mapOrderItem),
    client: mapUser(clientResult.rows[0])
  };
};

export const updateOrderStatus = async (orderId, status, userId) => {
  const previousOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const previousStatus = previousOrder.rows[0]?.status;
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
  if (status === 'approved') {
    const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    for (const item of itemsRes.rows) {
      await pool.query('UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2', [item.quantity, item.product_id]);
    }
  }
  await pool.query('INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)', [userId, 'UPDATE_ORDER', 'orders', orderId, JSON.stringify({ status })]);
  const result = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const updatedOrder = mapOrder(result.rows[0]);

  if (status === 'approved' && previousStatus !== 'approved') {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [updatedOrder.client_id]);
    const client = userRes.rows[0];
    if (client?.email) {
      await sendOrderApprovedEmail({
        to: client.email,
        userName: client.name,
        orderId: updatedOrder.id
      });
    }

    createNotification({
      userId: updatedOrder.client_id,
      title: 'Pedido aprobado',
      message: `Tu pedido #${updatedOrder.id} ya fue aprobado por el administrador.`,
      type: 'success'
    });
  }

  return updatedOrder;
};

const normalizeClosurePeriod = (periodType = 'day') => {
  const safePeriod = String(periodType || 'day').toLowerCase();
  return safePeriod === 'month' || safePeriod === 'year' ? safePeriod : 'day';
};

const getClosureWindow = (periodType = 'day', referenceDate = new Date()) => {
  const date = referenceDate instanceof Date ? new Date(referenceDate) : new Date(referenceDate);
  const start = new Date(date);
  const end = new Date(date);

  if (periodType === 'month') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(end.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
  } else if (periodType === 'year') {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(11, 31);
    end.setHours(23, 59, 59, 999);
  } else {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  }

  const label = periodType === 'month'
    ? `${start.toLocaleDateString('es-VE', { month: 'long', year: 'numeric' })}`
    : periodType === 'year'
      ? `${start.getFullYear()}`
      : `${start.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;

  return { start, end, label };
};

export const getSalesClosureSummary = async (periodType = 'day', referenceDate = new Date()) => {
  const safePeriod = normalizeClosurePeriod(periodType);
  const { start, end, label } = getClosureWindow(safePeriod, referenceDate);

  const ordersRes = await pool.query(`
    SELECT id, total_amount, created_at
    FROM orders
    WHERE status = 'approved' AND created_at >= $1 AND created_at <= $2
    ORDER BY created_at DESC
  `, [start, end]);

  const itemsRes = await pool.query(`
    SELECT oi.order_id, oi.quantity, oi.unit_price, p.title
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.status = 'approved' AND o.created_at >= $1 AND o.created_at <= $2
    ORDER BY oi.order_id, oi.id
  `, [start, end]);

  const orders = ordersRes.rows.map((row) => ({
    id: row.id,
    totalAmount: Number(row.total_amount),
    createdAt: row.created_at
  }));

  const itemsByOrder = itemsRes.rows.reduce((acc, row) => {
    if (!acc[row.order_id]) acc[row.order_id] = [];
    acc[row.order_id].push({
      title: row.title || 'Producto',
      quantity: Number(row.quantity),
      unitPrice: Number(row.unit_price)
    });
    return acc;
  }, {});

  const totalAmount = orders.reduce((sum, order) => sum + Number(order.totalAmount), 0);
  const itemsSold = itemsRes.rows.reduce((sum, row) => sum + Number(row.quantity), 0);

  return {
    periodType: safePeriod,
    periodLabel: label,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    totalAmount,
    ordersCount: orders.length,
    itemsSold,
    orders,
    itemsByOrder
  };
};

export const createSalesClosure = async (periodType = 'day', referenceDate = new Date()) => {
  const summary = await getSalesClosureSummary(periodType, referenceDate);
  await pool.query(`
    INSERT INTO daily_closures (period_type, period_label, start_date, end_date, total_amount, orders_count, items_sold, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [summary.periodType, summary.periodLabel, summary.startDate, summary.endDate, Number(summary.totalAmount).toFixed(2), summary.ordersCount, summary.itemsSold, JSON.stringify(summary.orders)]);
  return summary;
};

export const getDashboardStats = async () => {
  const metricsResetAt = await getMetricsResetAt();
  const metricsParams = [metricsResetAt];
  const productsRes = await pool.query('SELECT COUNT(*)::int AS count FROM products');
  const stockRes = await pool.query('SELECT COALESCE(SUM(stock), 0)::int AS stock FROM products');
  const soldItemsRes = await pool.query(`
    SELECT COALESCE(SUM(oi.quantity), 0)::int AS count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'approved' AND ($1::timestamp IS NULL OR o.created_at >= $1::timestamp)
  `, metricsParams);
  const revenueRes = await pool.query(`
    SELECT COALESCE(SUM(total_amount), 0)::numeric(12,2) AS usd
    FROM orders
    WHERE status = 'approved' AND ($1::timestamp IS NULL OR created_at >= $1::timestamp)
  `, metricsParams);
  const lowStockRes = await pool.query('SELECT * FROM products WHERE stock = 0');
  const bestSellerRes = await pool.query(`
    SELECT p.title, SUM(oi.quantity) AS qty
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'approved' AND ($1::timestamp IS NULL OR o.created_at >= $1::timestamp)
    GROUP BY p.title
    ORDER BY qty DESC
    LIMIT 1
  `, metricsParams);
  const statusRes = await pool.query(`
    SELECT status, COUNT(*)::int AS count
    FROM orders
    GROUP BY status
    ORDER BY status
  `);
  const trendRes = await pool.query(`
    SELECT to_char(created_at, 'YYYY-MM') AS month, COALESCE(SUM(total_amount), 0)::numeric(12,2) AS usd
    FROM orders
    WHERE status = 'approved' AND created_at >= NOW() - INTERVAL '6 months'
      AND ($1::timestamp IS NULL OR created_at >= $1::timestamp)
    GROUP BY 1
    ORDER BY 1
  `, metricsParams);
  const topProductsRes = await pool.query(`
    SELECT p.title, SUM(oi.quantity)::int AS qty, COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric(12,2) AS revenue
    FROM order_items oi
    LEFT JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.status = 'approved' AND ($1::timestamp IS NULL OR o.created_at >= $1::timestamp)
    GROUP BY p.title
    ORDER BY revenue DESC, qty DESC
    LIMIT 4
  `, metricsParams);
  const exchangeRate = await getExchangeRate();

  const trend = trendRes.rows.map((row) => ({
    month: row.month,
    usd: Number(row.usd)
  }));

  const counts = Object.fromEntries((statusRes.rows || []).map((row) => [row.status, Number(row.count)]));

  return {
    totalProducts: productsRes.rows[0].count,
    totalStock: stockRes.rows[0].stock,
    soldItems: soldItemsRes.rows[0].count,
    lowStock: lowStockRes.rows.map(mapProduct),
    bestSeller: bestSellerRes.rows[0] ? { name: bestSellerRes.rows[0].title, qty: Number(bestSellerRes.rows[0].qty) } : null,
    revenueUsd: Number(revenueRes.rows[0].usd),
    revenueBs: Number(revenueRes.rows[0].usd) * exchangeRate,
    exchangeRate,
    pendingOrders: Number(counts.pending || 0),
    approvedOrders: Number(counts.approved || 0),
    rejectedOrders: Number(counts.rejected || 0),
    revenueTrend: trend,
    metricsResetAt,
    topProducts: topProductsRes.rows.map((row) => ({
      name: row.title,
      qty: Number(row.qty),
      revenue: Number(row.revenue)
    }))
  };
};

export const getAuditLogs = async () => {
  const result = await pool.query(`
    SELECT al.*, u.name AS user_name
    FROM audit_logs al
    LEFT JOIN users u ON u.id = al.user_id
    ORDER BY al.id DESC
  `);
  return result.rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    action: row.action,
    table_name: row.table_name,
    record_id: row.record_id,
    changes: row.changes,
    created_at: row.created_at,
    user: row.user_name ? { id: row.user_id, name: row.user_name } : null
  }));
};

export const getUserById = async (id) => {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return mapUser(result.rows[0]);
};

export const addAuditLog = async (userId, action, tableName, recordId, changes) => {
  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)',
      [userId, action, tableName, recordId, JSON.stringify(changes)]
    );
  } catch (error) {
    console.error('No se pudo registrar auditoría', error.message);
  }
};
