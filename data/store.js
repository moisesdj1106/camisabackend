import fs from 'fs';
import pkg from 'pg';
import { hashPassword } from '../utils/auth.js';
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

const parseStockBySize = (value) => {
  if (!value) return {};
  const parsed = typeof value === 'string' ? (() => {
    try { return JSON.parse(value); } catch (error) { return {}; }
  })() : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(['XS', 'S', 'M', 'L', 'XL', 'XXL']
    .map((size) => [size, Math.max(0, Number(parsed[size]) || 0)])
    .filter(([, quantity]) => quantity > 0));
};

const normalizeProductPayload = (payload = {}) => {
  const imageUrls = parseImageUrls(payload.image_urls ?? payload.images ?? []);
  const primaryImage = payload.image_url || imageUrls[0] || null;
  if (primaryImage && imageUrls.length === 0) imageUrls.push(primaryImage);
  const stockBySize = parseStockBySize(payload.stock_by_size);
  return {
    ...payload,
    image_url: primaryImage,
    image_urls: imageUrls,
    stock_by_size: stockBySize,
    ...(Object.keys(stockBySize).length ? { stock: Object.values(stockBySize).reduce((sum, quantity) => sum + quantity, 0) } : {})
  };
};

const PRODUCT_COLUMN_KEYS = new Set(['club_id', 'title', 'description', 'price', 'discount_percent', 'stock', 'stock_by_size', 'type', 'is_active', 'image_url', 'image_urls', 'allow_no_dorsal', 'allow_catalog_dorsal', 'allow_custom_dorsal']);

const getDefaultExchangeRate = () => {
  const configured = Number(process.env.DEFAULT_EXCHANGE_RATE || 36);
  return Number.isFinite(configured) && configured > 0 ? configured : 36;
};

const getProductFieldEntries = (payload) => {
  const normalizedPayload = normalizeProductPayload(payload);
  return Object.entries(normalizedPayload).reduce((acc, [key, value]) => {
    if (value === undefined || key === 'id' || !PRODUCT_COLUMN_KEYS.has(key)) return acc;
    acc.push([key, key === 'image_urls' || key === 'stock_by_size' ? JSON.stringify(value) : value]);
    return acc;
  }, []);
};

const validateProductDorsalOption = (product, item) => {
  if (!product) throw new Error('El producto seleccionado no está disponible.');
  const hasCustomDorsal = Boolean(item.custom_name || item.custom_number);
  if (item.no_dorsal !== true && !item.dorsal_number && !hasCustomDorsal) {
    throw new Error('Selecciona un dorsal o indica que la camiseta va sin dorsal.');
  }
  if (hasCustomDorsal && (!item.custom_name || !item.custom_number)) {
    throw new Error('Completa el nombre y número de la personalización.');
  }
  if (item.no_dorsal === true && product.allow_no_dorsal === false) {
    throw new Error(`La camiseta ${product.title} no se vende sin dorsal.`);
  }
  if (item.custom_name && product.allow_custom_dorsal === false) {
    throw new Error(`La camiseta ${product.title} no permite personalización.`);
  }
  if (item.dorsal_number && product.allow_catalog_dorsal === false) {
    throw new Error(`La camiseta ${product.title} no permite dorsales de jugador.`);
  }
};

const mapProduct = (row) => (row ? {
  id: row.id,
  club_id: row.club_id,
  title: row.title,
  description: row.description,
  price: Number(row.price),
  discount_percent: Number(row.discount_percent || 0),
  final_price: Number(row.price) * (1 - Math.min(100, Math.max(0, Number(row.discount_percent || 0))) / 100),
  stock: Number(row.stock),
  stock_by_size: parseStockBySize(row.stock_by_size),
  type: row.type,
  allow_no_dorsal: row.allow_no_dorsal !== false,
  allow_catalog_dorsal: row.allow_catalog_dorsal !== false,
  allow_custom_dorsal: row.allow_custom_dorsal !== false,
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
  subtotal_amount: Number(row.subtotal_amount ?? row.total_amount),
  discount_percent: Number(row.discount_percent || 0),
  payment_method: row.payment_method,
  payment_plan: row.payment_plan || 'full',
  first_payment_amount: Number(row.first_payment_amount || 0),
  first_payment_currency: row.first_payment_currency || 'USD',
  full_payment_amount: Number(row.full_payment_amount || 0),
  delivery_payment_amount: Number(row.delivery_payment_amount || 0),
  delivery_payment_currency: row.delivery_payment_currency || null,
  payment_proof_url: row.payment_proof_url,
  delivery_payment_proof_url: row.delivery_payment_proof_url || null,
  payment_received_at: row.payment_received_at || null,
  delivery_payment_received_at: row.delivery_payment_received_at || null,
  delivery_method: row.delivery_method || 'personal',
  shipping_details: row.shipping_details || null,
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
  product_type: row.product_type || row.type,
  club_name: row.club_name,
  size: row.size,
  no_dorsal: row.no_dorsal,
  dorsal_number: row.dorsal_number,
  dorsal_name: row.dorsal_name,
  custom_name: row.custom_name,
  custom_number: row.custom_number,
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
  return result.rows.map((row) => ({ id: Number(row.id), name: row.name, country: row.country, logo_url: row.logo_url, category: row.category || 'club' }));
};

export const createClub = async (payload) => {
  const idResult = await pool.query('SELECT COALESCE(MAX(id), 0)::int AS max_id FROM clubs');
  const nextId = Number(idResult.rows[0].max_id) + 1;
  const result = await pool.query(
    'INSERT INTO clubs (id, name, country, logo_url, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [nextId, payload.name, payload.country || null, payload.logo_url || null, payload.category === 'selection' ? 'selection' : 'club']
  );
  return result.rows[0];
};

export const updateClub = async (id, payload) => {
  const fields = [];
  const values = [];
  ['name', 'country', 'logo_url'].forEach((key) => {
    const value = payload[key];
    if (value === undefined) return;
    fields.push(`${key} = $${fields.length + 1}`);
    values.push(value);
  });
  if (payload.category !== undefined) {
    fields.push(`category = $${fields.length + 1}`);
    values.push(payload.category === 'selection' ? 'selection' : 'club');
  }
  if (!fields.length) return (await pool.query('SELECT * FROM clubs WHERE id = $1', [id])).rows[0];
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
      logo_url TEXT,
      category VARCHAR(20) NOT NULL DEFAULT 'club'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      club_id INTEGER REFERENCES clubs(id),
      title VARCHAR(200) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      type VARCHAR(20) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      image_url TEXT,
      image_urls JSONB DEFAULT '[]'::jsonb,
      stock_by_size JSONB NOT NULL DEFAULT '{}'::jsonb,
      allow_no_dorsal BOOLEAN NOT NULL DEFAULT TRUE,
      allow_catalog_dorsal BOOLEAN NOT NULL DEFAULT TRUE,
      allow_custom_dorsal BOOLEAN NOT NULL DEFAULT TRUE,
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
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_by_size JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_no_dorsal BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_catalog_dorsal BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_custom_dorsal BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS logo_url TEXT;`);
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'club';`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_likes (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (product_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_content (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL CHECK (type IN ('image', 'video', 'banner')),
      slot VARCHAR(20) NOT NULL DEFAULT 'gallery',
      media_url TEXT NOT NULL,
      title VARCHAR(200),
      description TEXT,
      link_url TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`ALTER TABLE store_content ADD COLUMN IF NOT EXISTS slot VARCHAR(20) NOT NULL DEFAULT 'gallery';`);
  await pool.query(`UPDATE store_content SET slot = 'banner' WHERE type = 'banner' AND slot = 'gallery';`);
  await pool.query(`UPDATE store_content SET slot = 'video' WHERE type = 'video' AND slot = 'gallery';`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES users(id),
      subtotal_amount DECIMAL(10,2),
      total_amount DECIMAL(10,2) NOT NULL,
      discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      payment_method VARCHAR(30) NOT NULL,
      payment_plan VARCHAR(20) NOT NULL DEFAULT 'full',
      first_payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      first_payment_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
      full_payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      delivery_payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      delivery_payment_currency VARCHAR(3),
      payment_proof_url TEXT,
      delivery_payment_proof_url TEXT,
      payment_received_at TIMESTAMPTZ,
      delivery_payment_received_at TIMESTAMPTZ,
      delivery_method VARCHAR(20) NOT NULL DEFAULT 'personal',
      shipping_details JSONB,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      stock_reserved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_reserved BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`UPDATE orders SET stock_reserved = TRUE WHERE status IN ('approved', 'preparing', 'ready_pickup', 'shipped', 'delivered') AND stock_reserved = FALSE;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,2) DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_path TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20) DEFAULT 'personal';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_details JSONB;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_payment_proof_url TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_plan VARCHAR(20) NOT NULL DEFAULT 'full';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS first_payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS first_payment_currency VARCHAR(3) NOT NULL DEFAULT 'USD';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS full_payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_payment_currency VARCHAR(3);`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_payment_received_at TIMESTAMPTZ;`);
  await pool.query(`UPDATE orders SET delivery_payment_currency = CASE WHEN REGEXP_REPLACE(TRANSLATE(LOWER(payment_method), 'áéíóúü', 'aeiouu'), '[^a-z0-9]', '', 'g') = 'pagomovil' THEN 'BS' ELSE 'USD' END WHERE delivery_payment_currency IS NULL;`);
  await pool.query(`UPDATE orders SET payment_plan = 'installments' WHERE delivery_payment_proof_url IS NOT NULL AND payment_plan = 'full';`);

  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_amount DECIMAL(10,2);`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0;`);
  await pool.query(`UPDATE orders SET subtotal_amount = total_amount WHERE subtotal_amount IS NULL;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id),
      product_id INTEGER REFERENCES products(id),
      size VARCHAR(10),
      no_dorsal BOOLEAN NOT NULL DEFAULT FALSE,
      dorsal_number INTEGER,
      dorsal_name VARCHAR(150),
      custom_name VARCHAR(150),
      custom_number VARCHAR(20),
      quantity INTEGER NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL
    );
  `);
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS size VARCHAR(10);`);
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS no_dorsal BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS custom_name VARCHAR(150);`);
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS custom_number VARCHAR(20);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_shipping_details (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      full_name VARCHAR(150) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      cedula VARCHAR(30) NOT NULL,
      agency VARCHAR(120) NOT NULL,
      city VARCHAR(100) NOT NULL,
      state VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    INSERT INTO products (id, club_id, title, description, price, stock, stock_by_size, type, is_active, image_url) VALUES
      (1, 1, 'Camiseta Local Barça 2025', 'Modelo oficial de la temporada.', 89.99, 12, '{"S": 3, "M": 4, "L": 3, "XL": 2}', 'local', true, 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80'),
      (2, 2, 'Camiseta Visitante Madrid', 'Diseño premium con tecnología transpirable.', 94.50, 0, '{}', 'visitante', true, 'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=800&q=80'),
      (3, 3, 'Tercera Boca Juniors', 'Edición limitada con detalles premium.', 72.00, 7, '{"M": 2, "L": 3, "XXL": 2}', 'tercera', true, 'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=800&q=80');
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

export const updateUserPasswordByContact = async (email, phone, password) => {
  const result = await pool.query(
    'UPDATE users SET password = $1 WHERE email = $2 AND phone = $3 RETURNING *',
    [password, email, phone]
  );
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
    SELECT p.*, c.id AS club_id_ref, c.name AS club_name, c.country AS club_country, c.logo_url AS club_logo_url, c.category AS club_category,
      (SELECT COUNT(*)::int FROM product_likes pl WHERE pl.product_id = p.id) AS likes_count
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
    club: row.club_name ? { id: row.club_id_ref, name: row.club_name, country: row.club_country, logo_url: row.club_logo_url, category: row.club_category || 'club' } : null
  }));
};

export const getProductById = async (id) => {
  const productRes = await pool.query(`
    SELECT p.*, c.id AS club_id_ref, c.name AS club_name, c.country AS club_country, c.logo_url AS club_logo_url, c.category AS club_category,
      (SELECT COUNT(*)::int FROM product_likes pl WHERE pl.product_id = p.id) AS likes_count
    FROM products p
    LEFT JOIN clubs c ON c.id = p.club_id
    WHERE p.id = $1
  `, [id]);
  if (productRes.rows.length === 0) return null;
  const dorsalsRes = await pool.query('SELECT * FROM product_dorsals WHERE product_id = $1 ORDER BY dorsal_number ASC', [id]);
  const product = productRes.rows[0];
  return {
    ...mapProduct(product),
    club: product.club_name ? { id: product.club_id_ref, name: product.club_name, country: product.club_country, logo_url: product.club_logo_url, category: product.club_category || 'club' } : null,
    dorsals: dorsalsRes.rows.map(mapDorsal)
  };
};

export const toggleProductLike = async (productId, userId) => {
  const existing = await pool.query('SELECT 1 FROM product_likes WHERE product_id = $1 AND user_id = $2', [productId, userId]);
  if (existing.rows.length) {
    await pool.query('DELETE FROM product_likes WHERE product_id = $1 AND user_id = $2', [productId, userId]);
  } else {
    await pool.query('INSERT INTO product_likes (product_id, user_id) VALUES ($1, $2)', [productId, userId]);
  }
  const result = await pool.query('SELECT COUNT(*)::int AS likes_count FROM product_likes WHERE product_id = $1', [productId]);
  return { liked: !existing.rows.length, likes_count: result.rows[0].likes_count };
};

export const getProductLikeStatus = async (productId, userId) => {
  const result = await pool.query('SELECT 1 FROM product_likes WHERE product_id = $1 AND user_id = $2', [productId, userId]);
  return result.rows.length > 0;
};

export const listStoreContent = async (activeOnly = true) => {
  const result = await pool.query(`
    SELECT *, CASE WHEN type = 'banner' AND slot = 'gallery' THEN 'banner' WHEN type = 'video' AND slot = 'gallery' THEN 'video' ELSE slot END AS content_slot
    FROM store_content
    ${activeOnly ? 'WHERE is_active = TRUE' : ''}
    ORDER BY sort_order ASC, id DESC
  `);
  return result.rows.map(({ content_slot, ...row }) => ({ ...row, slot: content_slot }));
};

export const createStoreContent = async (payload) => {
  const result = await pool.query(
    'INSERT INTO store_content (type, slot, media_url, title, description, link_url, is_active, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
    [payload.type, payload.slot || 'gallery', payload.media_url, payload.title || '', payload.description || '', payload.link_url || null, payload.is_active !== false, Number(payload.sort_order) || 0]
  );
  return result.rows[0];
};

export const updateStoreContent = async (id, payload) => {
  const result = await pool.query(
    'UPDATE store_content SET type = $1, slot = $2, media_url = $3, title = $4, description = $5, link_url = $6, is_active = $7, sort_order = $8 WHERE id = $9 RETURNING *',
    [payload.type, payload.slot || 'gallery', payload.media_url, payload.title || '', payload.description || '', payload.link_url || null, payload.is_active !== false, Number(payload.sort_order) || 0, id]
  );
  return result.rows[0] || null;
};

export const deleteStoreContent = async (id) => {
  await pool.query('DELETE FROM store_content WHERE id = $1', [id]);
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
    'INSERT INTO products (id, club_id, title, description, price, discount_percent, stock, stock_by_size, type, is_active, image_url, image_urls, allow_no_dorsal, allow_catalog_dorsal, allow_custom_dorsal) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *',
    [nextId, normalizedPayload.club_id, normalizedPayload.title, normalizedPayload.description || '', normalizedPayload.price, Math.min(100, Math.max(0, Number(normalizedPayload.discount_percent) || 0)), normalizedPayload.stock, JSON.stringify(normalizedPayload.stock_by_size), normalizedPayload.type, normalizedPayload.is_active !== false, normalizedPayload.image_url || null, JSON.stringify(normalizedPayload.image_urls || []), normalizedPayload.allow_no_dorsal !== false, normalizedPayload.allow_catalog_dorsal !== false, normalizedPayload.allow_custom_dorsal !== false]
  );
  const product = mapProduct(result.rows[0]);
  await syncProductDorsals(product.id, payload.dorsal_options || payload.dorsals || []);
  return product;
};

export const updateAllProductDiscounts = async (discountPercent) => {
  const discount = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const result = await pool.query('UPDATE products SET discount_percent = $1 RETURNING *', [discount]);
  return result.rows.map(mapProduct);
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
  const hasDorsalOptions = Object.prototype.hasOwnProperty.call(payload, 'dorsal_options') || Object.prototype.hasOwnProperty.call(payload, 'dorsals');
  if (product && hasDorsalOptions) await syncProductDorsals(product.id, payload.dorsal_options ?? payload.dorsals);
  return product;
};

export const deleteProduct = async (id) => {
  await pool.query('DELETE FROM product_dorsals WHERE product_id = $1', [id]);
  await pool.query('DELETE FROM products WHERE id = $1', [id]);
};

export const createOrder = async ({ userId, items, paymentMethod, paymentPlan = 'full', firstPaymentAmount = 0, firstPaymentCurrency = 'USD', fullPaymentAmount = 0, deliveryPaymentAmount = 0, deliveryPaymentCurrency, paymentProofUrl, deliveryPaymentProofUrl, deliveryMethod, shippingDetails, status = 'pending' }) => {
  if (!Array.isArray(items) || items.length === 0) throw new Error('El carrito está vacío.');
  const allowedStatuses = new Set(['pending', 'approved', 'requires_info', 'preparing', 'ready_pickup', 'shipped', 'delivered', 'rejected', 'cancelled']);
  if (!allowedStatuses.has(status)) throw new Error('Estado de pedido inválido.');

  const normalizedItems = items.map((item) => {
    const productId = Number(item.product_id);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(productId) || productId < 1) throw new Error('Uno de los productos seleccionados no es válido.');
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('La cantidad de cada producto debe ser un entero mayor que cero.');
    if (!String(item.size || '').trim()) throw new Error('Selecciona una talla para cada camiseta.');
    return { ...item, product_id: productId, size: String(item.size).trim().toUpperCase(), quantity };
  });
  const exchangeRate = await getExchangeRate();
  const normalizedCurrency = paymentPlan === 'installments'
    ? String(firstPaymentCurrency || 'USD').toUpperCase()
    : 'USD';
  const normalizedDeliveryPaymentCurrency = paymentPlan === 'installments'
    ? String(deliveryPaymentCurrency || (paymentMethod === 'pago_movil' ? 'BS' : 'USD')).toUpperCase()
    : (paymentMethod === 'pago_movil' ? 'BS' : 'USD');
  const normalizedFirstPaymentAmount = paymentPlan === 'installments' ? Number(firstPaymentAmount) : 0;
  if (paymentPlan === 'installments') {
    if (!Number.isFinite(normalizedFirstPaymentAmount) || normalizedFirstPaymentAmount <= 0 || !['USD', 'BS'].includes(normalizedCurrency)) {
      throw new Error('Indica un monto válido para el primer pago y su moneda.');
    }
    if (!['USD', 'BS'].includes(normalizedDeliveryPaymentCurrency)) {
      throw new Error('Selecciona una moneda válida para el segundo pago.');
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const productIds = [...new Set(normalizedItems.map((item) => item.product_id))].sort((a, b) => a - b);
    const productsResult = await client.query('SELECT * FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [productIds]);
    const products = new Map(productsResult.rows.map((row) => [Number(row.id), mapProduct(row)]));
    if (products.size !== productIds.length) throw new Error('Uno de los productos seleccionados ya no está disponible.');

    const stockToReserve = new Map();
    for (const item of normalizedItems) {
      const product = products.get(item.product_id);
      validateProductDorsalOption(product, item);
      if (!product.is_active) throw new Error(`La camiseta ${product.title} no está disponible.`);
      const tracksSizes = Object.keys(product.stock_by_size).length > 0;
      const stockKey = `${product.id}:${tracksSizes ? item.size : 'all'}`;
      const requested = (stockToReserve.get(stockKey)?.quantity || 0) + item.quantity;
      stockToReserve.set(stockKey, { product, size: item.size, quantity: requested, tracksSizes });
    }
    for (const reservation of stockToReserve.values()) {
      const available = reservation.tracksSizes
        ? Number(reservation.product.stock_by_size[reservation.size] || 0)
        : Number(reservation.product.stock || 0);
      if (reservation.quantity > available) {
        throw new Error(`No hay suficiente stock para la talla ${reservation.size}. Disponibles: ${available}.`);
      }
      await adjustProductStock(client, reservation.product.id, reservation.size, -reservation.quantity);
    }

    const pricedItems = normalizedItems.map((item) => {
      const product = products.get(item.product_id);
      const discount = Math.min(100, Math.max(0, Number(product.discount_percent || 0)));
      return { ...item, unit_price: Number(product.price) * (1 - discount / 100) };
    });
    const subtotalAmount = pricedItems.reduce((sum, item) => sum + Number(item.unit_price) * item.quantity, 0);
    const totalAmount = subtotalAmount;
    if (paymentPlan === 'installments') {
      const paidUsd = normalizedCurrency === 'BS'
        ? normalizedFirstPaymentAmount / Number(exchangeRate)
        : normalizedFirstPaymentAmount;
      if (!Number.isFinite(paidUsd) || paidUsd >= totalAmount) {
        throw new Error('El primer abono debe ser menor que el total; si ya se pagó todo, selecciona pago completo.');
      }
    }
    const orderRes = await client.query(
      `INSERT INTO orders (client_id, subtotal_amount, total_amount, discount_percent, payment_method, payment_plan, first_payment_amount, first_payment_currency, full_payment_amount, delivery_payment_amount, delivery_payment_currency, payment_proof_url, delivery_payment_proof_url, delivery_method, shipping_details, status, stock_reserved, exchange_rate, payment_received_at, delivery_payment_received_at)
        VALUES ($1, $2, $3, $4, $5, $6::varchar, $7::numeric, $8::varchar, $9::numeric, $10::numeric, $11::varchar, $12, $13, $14, $15, $16, TRUE, $17,
          CASE WHEN $12::text IS NOT NULL OR $7 > 0 OR $9 > 0 THEN CURRENT_TIMESTAMP ELSE NULL END,
          CASE WHEN $13::text IS NOT NULL OR $10 > 0 THEN CURRENT_TIMESTAMP ELSE NULL END)
        RETURNING *`,
      [userId, Number(subtotalAmount).toFixed(2), Number(totalAmount).toFixed(2), 0, paymentMethod, paymentPlan, normalizedFirstPaymentAmount, paymentPlan === 'installments' ? normalizedCurrency : 'USD', paymentPlan === 'full' ? Number(fullPaymentAmount || totalAmount) : 0, paymentPlan === 'installments' ? Number(deliveryPaymentAmount || 0) : 0, normalizedDeliveryPaymentCurrency, paymentProofUrl || null, deliveryPaymentProofUrl || null, deliveryMethod, shippingDetails || null, status, Number(exchangeRate).toFixed(2)]
    );
    const order = mapOrder(orderRes.rows[0]);
    for (const item of pricedItems) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, size, no_dorsal, dorsal_number, dorsal_name, custom_name, custom_number, quantity, unit_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [order.id, item.product_id, item.size, Boolean(item.no_dorsal), item.dorsal_number || null, item.dorsal_name || null, item.custom_name || null, item.custom_number || null, item.quantity, item.unit_price]
      );
    }
    if (deliveryMethod === 'national') {
      await client.query(
        'INSERT INTO order_shipping_details (order_id, full_name, phone, cedula, agency, city, state) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [order.id, shippingDetails.name, shippingDetails.phone, shippingDetails.cedula, shippingDetails.agency, shippingDetails.city, shippingDetails.state]
      );
    }
    await client.query('COMMIT');
    return { order, items: pricedItems };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const createOrderManually = async ({ adminUserId, clientData, items, paymentMethod, paymentPlan = 'full', firstPaymentAmount = 0, firstPaymentCurrency = 'USD', fullPaymentAmount = 0, deliveryPaymentAmount = 0, deliveryPaymentCurrency, paymentProofUrl, deliveryPaymentProofUrl, deliveryMethod, shippingDetails, status = 'pending' }) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Debes agregar al menos un producto al pedido.');
  }
  if (!['pago_movil', 'efectivo', 'binance'].includes(paymentMethod)) {
    throw new Error('Debes seleccionar un método de pago válido.');
  }
  if (!['full', 'installments'].includes(paymentPlan)) {
    throw new Error('Selecciona pago completo o por partes.');
  }
  if (paymentPlan === 'installments' && (!Number.isFinite(Number(firstPaymentAmount)) || Number(firstPaymentAmount) <= 0 || !['USD', 'BS'].includes(String(firstPaymentCurrency).toUpperCase()))) {
    throw new Error('Indica un monto válido para el primer pago y su moneda.');
  }
  if (paymentPlan === 'full' && (!Number.isFinite(Number(fullPaymentAmount)) || Number(fullPaymentAmount) <= 0)) {
    throw new Error('Indica el monto recibido por el pago completo.');
  }
  if (paymentPlan === 'installments' && deliveryPaymentProofUrl && (!Number.isFinite(Number(deliveryPaymentAmount)) || Number(deliveryPaymentAmount) <= 0)) {
    throw new Error('Indica el monto del pago final junto con su comprobante.');
  }
  if (!paymentProofUrl) {
    throw new Error('Adjunta el comprobante del primer pago.');
  }
  if (!['personal', 'national'].includes(deliveryMethod)) {
    throw new Error('Debes seleccionar una modalidad de entrega válida.');
  }
  if (paymentMethod === 'efectivo' && deliveryMethod !== 'personal') {
    throw new Error('El pago en efectivo solo está disponible para entrega personal.');
  }
  if (deliveryMethod === 'national' && (!shippingDetails?.name || !shippingDetails?.phone || !shippingDetails?.cedula || !shippingDetails?.agency || !shippingDetails?.city || !shippingDetails?.state)) {
    throw new Error('Completa todos los datos del envío nacional.');
  }

  const normalizedName = String(clientData?.name || '').trim();
  const normalizedEmail = String(clientData?.email || '').trim().toLowerCase();
  const normalizedPhone = String(clientData?.phone || '').trim();

  if (!normalizedName || !normalizedEmail) {
    throw new Error('Nombre y correo del cliente son obligatorios.');
  }

  let user = null;
  if (clientData?.client_id) {
    user = await getUserById(Number(clientData.client_id));
  }
  if (!user) {
    user = await findUserByEmail(normalizedEmail);
  }
  if (!user) {
    const password = await hashPassword('Cliente123!');
    user = await createUser({
      name: normalizedName,
      email: normalizedEmail,
      phone: normalizedPhone,
      password,
      role: 'client'
    });
  }

  const finalItems = items.map((item) => ({
    product_id: Number(item.product_id),
    size: String(item.size || '').trim().toUpperCase(),
    quantity: Math.max(1, Number(item.quantity) || 1),
    no_dorsal: item.no_dorsal !== false,
    custom_name: item.custom_name || null,
    custom_number: item.custom_number || null,
    dorsal_number: item.dorsal_number || null,
    dorsal_name: item.dorsal_name || null
  }));

  const order = await createOrder({
    userId: user.id,
    items: finalItems,
    paymentMethod,
    paymentPlan,
    firstPaymentAmount,
    firstPaymentCurrency,
    fullPaymentAmount,
    deliveryPaymentAmount,
    deliveryPaymentCurrency,
    paymentProofUrl,
    deliveryPaymentProofUrl: paymentPlan === 'installments' ? deliveryPaymentProofUrl : null,
    deliveryMethod,
    shippingDetails,
    status
  });

  await pool.query(
    'INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)',
    [adminUserId, 'CREATE_ORDER_MANUAL', 'orders', order.order.id, JSON.stringify({ client_id: user.id, status, payment_method: paymentMethod, payment_plan: paymentPlan, first_payment_amount: firstPaymentAmount, first_payment_currency: firstPaymentCurrency, full_payment_amount: fullPaymentAmount, delivery_payment_amount: deliveryPaymentAmount, delivery_payment_currency: deliveryPaymentCurrency, delivery_method: deliveryMethod })]
  );

  return { ...order, client: user };
};

export const addItemToOrder = async (orderId, item, userId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!item.size || (item.no_dorsal !== true && !item.dorsal_number && !(item.custom_name && item.custom_number))) {
      throw new Error('La camiseta debe tener una talla y un dorsal o personalización válida.');
    }

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = orderResult.rows[0];
    if (!order) throw new Error('Pedido no encontrado.');
    if (['cancelled', 'rejected', 'delivered'].includes(order.status)) {
      throw new Error('No se puede modificar un pedido cerrado.');
    }

    const productResult = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [Number(item.product_id)]);
    const product = productResult.rows[0];
    if (!product || !product.is_active) throw new Error('El producto seleccionado no está disponible.');

    const quantity = Math.max(1, Number(item.quantity) || 1);
    const stockBySize = typeof product.stock_by_size === 'string' ? JSON.parse(product.stock_by_size || '{}') : (product.stock_by_size || {});
    const available = Object.keys(stockBySize).length ? Number(stockBySize[item.size] || 0) : Number(product.stock || 0);
    if (!item.size || available < quantity) {
      throw new Error(`No hay suficiente stock para la talla ${item.size || 'seleccionada'}. Disponibles: ${available}.`);
    }

    await client.query(
      'INSERT INTO order_items (order_id, product_id, size, no_dorsal, dorsal_number, dorsal_name, custom_name, custom_number, quantity, unit_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [orderId, product.id, item.size, Boolean(item.no_dorsal), item.dorsal_number || null, item.dorsal_name || null, item.custom_name || null, item.custom_number || null, quantity, Number(product.price) * (1 - Math.min(100, Math.max(0, Number(product.discount_percent || 0))) / 100)]
    );

    if (order.stock_reserved) {
      await client.query(`
        UPDATE products
        SET stock = GREATEST(0, stock - $1),
            stock_by_size = CASE
              WHEN stock_by_size ? $3 THEN jsonb_set(stock_by_size, ARRAY[$3], to_jsonb(GREATEST(0, COALESCE((stock_by_size ->> $3)::int, 0) - $1)), true)
              ELSE stock_by_size
            END
        WHERE id = $2
      `, [quantity, product.id, item.size]);
    }

    const discount = Math.min(100, Math.max(0, Number(product.discount_percent || 0)));
    const finalPrice = Number(product.price) * (1 - discount / 100);
    const nextSubtotal = Number(order.subtotal_amount ?? order.total_amount) + (finalPrice * quantity);
    const orderDiscount = Math.min(100, Math.max(0, Number(order.discount_percent || 0)));
    const nextTotal = nextSubtotal * (1 - orderDiscount / 100);
    const updatedOrder = await client.query('UPDATE orders SET subtotal_amount = $1, total_amount = $2 WHERE id = $3 RETURNING *', [nextSubtotal.toFixed(2), nextTotal.toFixed(2), orderId]);
    await client.query(
      'INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)',
      [userId, 'ADD_ORDER_ITEM', 'orders', orderId, JSON.stringify({ product_id: product.id, quantity, size: item.size, total_amount: nextTotal })]
    );
    await client.query('COMMIT');
    return mapOrder(updatedOrder.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const adjustProductStock = async (client, productId, size, amount) => {
  await client.query(`
    UPDATE products
    SET stock = GREATEST(0, stock + $1),
        stock_by_size = CASE
          WHEN stock_by_size ? $3 THEN jsonb_set(stock_by_size, ARRAY[$3], to_jsonb(GREATEST(0, COALESCE((stock_by_size ->> $3)::int, 0) + $1)), true)
          ELSE stock_by_size
        END
    WHERE id = $2
  `, [amount, productId, size]);
};

const reserveOrderStock = async (client, items) => {
  const productIds = [...new Set(items.map((item) => Number(item.product_id)))].sort((a, b) => a - b);
  const productsResult = await client.query('SELECT * FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [productIds]);
  const products = new Map(productsResult.rows.map((row) => [Number(row.id), mapProduct(row)]));
  if (products.size !== productIds.length) throw new Error('Uno de los productos del pedido ya no está disponible.');

  const reservations = new Map();
  for (const item of items) {
    const product = products.get(Number(item.product_id));
    const tracksSizes = Object.keys(product.stock_by_size).length > 0;
    const size = String(item.size || '').trim().toUpperCase();
    const key = `${product.id}:${tracksSizes ? size : 'all'}`;
    const reservation = reservations.get(key) || { product, size, quantity: 0, tracksSizes };
    reservation.quantity += Number(item.quantity);
    reservations.set(key, reservation);
  }
  for (const reservation of reservations.values()) {
    const available = reservation.tracksSizes
      ? Number(reservation.product.stock_by_size[reservation.size] || 0)
      : Number(reservation.product.stock || 0);
    if (reservation.quantity > available) {
      throw new Error(`No hay suficiente stock para la talla ${reservation.size}. Disponibles: ${available}.`);
    }
    await adjustProductStock(client, reservation.product.id, reservation.size, -reservation.quantity);
  }
};

const releaseOrderStock = async (client, items) => {
  for (const item of items) {
    await adjustProductStock(client, item.product_id, item.size, Number(item.quantity));
  }
};

const recalculateOrderTotal = async (client, orderId, discountPercent) => {
  const itemsResult = await client.query('SELECT quantity, unit_price FROM order_items WHERE order_id = $1', [orderId]);
  const subtotal = itemsResult.rows.reduce((sum, item) => sum + Number(item.unit_price) * Number(item.quantity), 0);
  const total = subtotal * (1 - Math.min(100, Math.max(0, Number(discountPercent || 0))) / 100);
  return client.query('UPDATE orders SET subtotal_amount = $1, total_amount = $2 WHERE id = $3 RETURNING *', [subtotal.toFixed(2), total.toFixed(2), orderId]);
};

export const updateOrderItem = async (orderId, itemId, item, userId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = orderResult.rows[0];
    if (!order) throw new Error('Pedido no encontrado.');
    if (['cancelled', 'rejected', 'delivered'].includes(order.status)) throw new Error('No se puede modificar un pedido cerrado.');

    const itemResult = await client.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [itemId, orderId]);
    const currentItem = itemResult.rows[0];
    if (!currentItem) throw new Error('Producto del pedido no encontrado.');
    if (!item.size || (item.no_dorsal !== true && !item.dorsal_number && !(item.custom_name && item.custom_number))) {
      throw new Error('La camiseta debe tener una talla y un dorsal o personalización válida.');
    }

    const oldProductResult = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [currentItem.product_id]);
    const oldProduct = oldProductResult.rows[0];
    const productId = Number(item.product_id || currentItem.product_id);
    const product = productId === Number(currentItem.product_id)
      ? oldProduct
      : (await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId])).rows[0];
    if (!product || !product.is_active) throw new Error('El producto seleccionado no está disponible.');

    const quantity = Math.max(1, Number(item.quantity) || 1);
    if (order.stock_reserved) {
      await adjustProductStock(client, oldProduct.id, currentItem.size, Number(currentItem.quantity));
      await reserveOrderStock(client, [{ product_id: product.id, size: item.size, quantity }]);
    }

    const discount = Math.min(100, Math.max(0, Number(product.discount_percent || 0)));
    const unitPrice = Number(product.price) * (1 - discount / 100);
    await client.query(`
      UPDATE order_items
      SET product_id = $1, size = $2, no_dorsal = $3, dorsal_number = $4, dorsal_name = $5,
          custom_name = $6, custom_number = $7, quantity = $8, unit_price = $9
      WHERE id = $10 AND order_id = $11
    `, [product.id, item.size, Boolean(item.no_dorsal), item.dorsal_number || null, item.dorsal_name || null, item.custom_name || null, item.custom_number || null, quantity, unitPrice, itemId, orderId]);
    const updatedOrder = await recalculateOrderTotal(client, orderId, order.discount_percent);
    await client.query('INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)', [userId, 'UPDATE_ORDER_ITEM', 'orders', orderId, JSON.stringify({ item_id: itemId, product_id: product.id, size: item.size, quantity })]);
    await client.query('COMMIT');
    return mapOrder(updatedOrder.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const deleteOrderItem = async (orderId, itemId, userId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = orderResult.rows[0];
    if (!order) throw new Error('Pedido no encontrado.');
    if (['cancelled', 'rejected', 'delivered'].includes(order.status)) throw new Error('No se puede modificar un pedido cerrado.');
    const itemResult = await client.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [itemId, orderId]);
    const item = itemResult.rows[0];
    if (!item) throw new Error('Producto del pedido no encontrado.');
    if (order.stock_reserved) await adjustProductStock(client, item.product_id, item.size, Number(item.quantity));
    await client.query('DELETE FROM order_items WHERE id = $1 AND order_id = $2', [itemId, orderId]);
    const updatedOrder = await recalculateOrderTotal(client, orderId, order.discount_percent);
    await client.query('INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)', [userId, 'DELETE_ORDER_ITEM', 'orders', orderId, JSON.stringify({ item_id: itemId, product_id: item.product_id, quantity: item.quantity })]);
    await client.query('COMMIT');
    return mapOrder(updatedOrder.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const updateOrderDiscount = async (orderId, discountPercent, userId) => {
  const discount = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const result = await pool.query('SELECT id, total_amount, subtotal_amount, discount_percent FROM orders WHERE id = $1', [orderId]);
  const order = result.rows[0];
  if (!order) return null;
  const subtotal = Number(order.subtotal_amount ?? order.total_amount);
  const total = subtotal * (1 - discount / 100);
  const updated = await pool.query('UPDATE orders SET subtotal_amount = $1, total_amount = $2, discount_percent = $3 WHERE id = $4 RETURNING *', [subtotal.toFixed(2), total.toFixed(2), discount, orderId]);
  await pool.query('INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)', [userId, 'UPDATE_ORDER_DISCOUNT', 'orders', orderId, JSON.stringify({ discount_percent: discount, total_amount: total })]);
  return mapOrder(updated.rows[0]);
};

export const updateOrderAdmin = async (orderId, payload, userId) => {
  const allowedPaymentMethods = new Set(['pago_movil', 'efectivo', 'binance']);
  const paymentPlan = payload.payment_plan || 'full';
  const allowedDeliveryMethods = new Set(['personal', 'national']);
  if (!allowedPaymentMethods.has(payload.payment_method) || !['full', 'installments'].includes(paymentPlan) || !allowedDeliveryMethods.has(payload.delivery_method)) {
    throw new Error('Método de pago o entrega inválido.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!existing.rows[0]) throw new Error('Pedido no encontrado.');
    const currentOrder = existing.rows[0];
    const firstPaymentCurrency = paymentPlan === 'installments'
      ? String(payload.first_payment_currency || currentOrder.first_payment_currency || 'USD').toUpperCase()
      : 'USD';
    const methodCurrency = payload.payment_method === 'pago_movil' ? 'BS' : 'USD';
    const deliveryPaymentCurrency = paymentPlan === 'installments'
      ? String(payload.delivery_payment_currency || currentOrder.delivery_payment_currency || methodCurrency).toUpperCase()
      : methodCurrency;
    const paymentProofUrl = payload.payment_proof_url || currentOrder.payment_proof_url || null;
    const firstPaymentAmount = paymentPlan === 'installments'
      ? Number(payload.first_payment_amount !== undefined && payload.first_payment_amount !== '' ? payload.first_payment_amount : currentOrder.first_payment_amount || 0)
      : 0;
    const fullPaymentAmount = paymentPlan === 'full'
      ? Number(payload.full_payment_amount !== undefined && payload.full_payment_amount !== '' ? payload.full_payment_amount : currentOrder.full_payment_amount || 0)
      : 0;
    const deliveryPaymentAmount = paymentPlan === 'installments'
      ? Number(payload.delivery_payment_amount !== undefined && payload.delivery_payment_amount !== '' ? payload.delivery_payment_amount : currentOrder.delivery_payment_amount || 0)
      : 0;
    const currentPrimaryPaymentAmount = currentOrder.payment_plan === 'installments'
      ? Number(currentOrder.first_payment_amount || 0)
      : Number(currentOrder.full_payment_amount || 0);
    const primaryPaymentAmount = paymentPlan === 'installments' ? firstPaymentAmount : fullPaymentAmount;
    const firstPaymentChanged = paymentPlan !== currentOrder.payment_plan
      || paymentProofUrl !== currentOrder.payment_proof_url
      || primaryPaymentAmount !== currentPrimaryPaymentAmount;
    const finalPaymentChanged = paymentPlan !== currentOrder.payment_plan
      || (payload.delivery_payment_proof_url || null) !== (currentOrder.delivery_payment_proof_url || null)
      || deliveryPaymentAmount !== Number(currentOrder.delivery_payment_amount || 0);
    if (![fullPaymentAmount, deliveryPaymentAmount].every((amount) => Number.isFinite(amount) && amount >= 0)) {
      throw new Error('Los montos recibidos deben ser números válidos y no negativos.');
    }
    if (paymentPlan === 'full' && ['approved', 'preparing', 'ready_pickup', 'shipped', 'delivered'].includes(payload.status) && fullPaymentAmount <= 0 && !Number(currentOrder.full_payment_amount)) {
      throw new Error('Indica el monto recibido por el pago completo.');
    }
    if (paymentPlan === 'installments') {
      if (!paymentProofUrl) throw new Error('Adjunta el comprobante del primer pago.');
      if (!Number.isFinite(firstPaymentAmount) || firstPaymentAmount <= 0 || !['USD', 'BS'].includes(firstPaymentCurrency)) {
        throw new Error('Indica un monto válido para el primer pago y su moneda.');
      }
      const rate = Number(currentOrder.exchange_rate || 0);
      const paidUsd = firstPaymentCurrency === 'BS' ? firstPaymentAmount / rate : firstPaymentAmount;
      if (!Number.isFinite(paidUsd) || paidUsd >= Number(currentOrder.total_amount)) {
        throw new Error('El primer abono debe ser menor que el total; si ya se pagó todo, selecciona pago completo.');
      }
      if (!['USD', 'BS'].includes(deliveryPaymentCurrency)) {
        throw new Error('Selecciona una moneda válida para el segundo pago.');
      }
    }
    if (payload.payment_method === 'efectivo' && payload.delivery_method !== 'personal' && (payload.payment_method !== currentOrder.payment_method || payload.delivery_method !== currentOrder.delivery_method)) {
      throw new Error('El pago en efectivo solo está disponible para entrega personal.');
    }
    if (payload.delivery_method === 'national' && (!payload.shipping_details?.name || !payload.shipping_details?.phone || !payload.shipping_details?.cedula || !payload.shipping_details?.agency || !payload.shipping_details?.city || !payload.shipping_details?.state) && payload.delivery_method !== currentOrder.delivery_method) {
      throw new Error('Completa todos los datos del envío nacional.');
    }
    const allowedStatuses = new Set(['pending', 'approved', 'requires_info', 'preparing', 'ready_pickup', 'shipped', 'delivered', 'rejected', 'cancelled']);
    if (!allowedStatuses.has(payload.status)) throw new Error('Estado de pedido inválido.');
    const orderItems = (await client.query('SELECT product_id, size, quantity FROM order_items WHERE order_id = $1 FOR UPDATE', [orderId])).rows;
    let stockReserved = Boolean(currentOrder.stock_reserved);
    if (['cancelled', 'rejected'].includes(payload.status) && stockReserved) {
      await releaseOrderStock(client, orderItems);
      stockReserved = false;
    } else if (!['cancelled', 'rejected'].includes(payload.status) && !stockReserved) {
      await reserveOrderStock(client, orderItems);
      stockReserved = true;
    }

    const updated = await client.query(`
      UPDATE orders
        SET payment_method = $1, payment_proof_url = $2, payment_plan = $3::varchar,
          delivery_payment_proof_url = CASE WHEN $3::varchar = 'installments' THEN COALESCE($4, delivery_payment_proof_url) ELSE NULL END,
            first_payment_amount = $9::numeric, first_payment_currency = $10::varchar,
            full_payment_amount = $11::numeric, delivery_payment_amount = $12::numeric,
            delivery_payment_currency = $13::varchar,
            payment_received_at = CASE
              WHEN $3::varchar = 'full' AND $2::text IS NULL AND $11::numeric = 0 THEN NULL
              WHEN $14::boolean OR (payment_received_at IS NULL AND (($3::varchar = 'installments' AND ($2::text IS NOT NULL OR $9::numeric > 0)) OR ($3::varchar = 'full' AND ($2::text IS NOT NULL OR $11::numeric > 0)))) THEN CURRENT_TIMESTAMP
              ELSE payment_received_at
            END,
            delivery_payment_received_at = CASE
              WHEN $3::varchar <> 'installments' THEN NULL
              WHEN $4::text IS NULL AND $12::numeric = 0 THEN NULL
              WHEN $15::boolean OR (delivery_payment_received_at IS NULL AND ($4::text IS NOT NULL OR $12::numeric > 0)) THEN CURRENT_TIMESTAMP
              ELSE delivery_payment_received_at
            END,
            delivery_method = $5, shipping_details = $6, status = $7, stock_reserved = $16
        WHERE id = $8
      RETURNING *
      `, [payload.payment_method, paymentProofUrl, paymentPlan, payload.delivery_payment_proof_url || null, payload.delivery_method, payload.delivery_method === 'national' ? payload.shipping_details : null, payload.status, orderId, firstPaymentAmount, firstPaymentCurrency, fullPaymentAmount, deliveryPaymentAmount, deliveryPaymentCurrency, firstPaymentChanged, finalPaymentChanged, stockReserved]);

    if (payload.delivery_method === 'national') {
      await client.query(`
        INSERT INTO order_shipping_details (order_id, full_name, phone, cedula, agency, city, state)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (order_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, cedula = EXCLUDED.cedula, agency = EXCLUDED.agency, city = EXCLUDED.city, state = EXCLUDED.state
      `, [orderId, payload.shipping_details.name, payload.shipping_details.phone, payload.shipping_details.cedula, payload.shipping_details.agency, payload.shipping_details.city, payload.shipping_details.state]);
    } else {
      await client.query('DELETE FROM order_shipping_details WHERE order_id = $1', [orderId]);
    }

    await client.query('INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)', [userId, 'UPDATE_ORDER_DETAILS', 'orders', orderId, JSON.stringify({ payment_method: payload.payment_method, payment_plan: paymentPlan, first_payment_amount: firstPaymentAmount, first_payment_currency: firstPaymentCurrency, full_payment_amount: fullPaymentAmount, delivery_payment_amount: deliveryPaymentAmount, delivery_payment_currency: deliveryPaymentCurrency, delivery_method: payload.delivery_method, status: payload.status })]);
    await client.query('COMMIT');
    return mapOrder(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getOrdersForUser = async (userId) => {
  const result = await pool.query('SELECT * FROM orders WHERE client_id = $1 ORDER BY id DESC', [userId]);
  const orders = await Promise.all(result.rows.map(async (row) => {
    const order = mapOrder(row);
    const itemsResult = await pool.query(`
      SELECT oi.*, p.title AS product_title, p.type AS product_type
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
    `, [order.id]);
    const shippingResult = await pool.query('SELECT full_name, phone, cedula, agency, city, state FROM order_shipping_details WHERE order_id = $1', [order.id]);
    if (shippingResult.rows[0]) {
      const shipping = shippingResult.rows[0];
      order.shipping_details = { name: shipping.full_name, phone: shipping.phone, cedula: shipping.cedula, agency: shipping.agency, city: shipping.city, state: shipping.state };
    }
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

export const getApprovedOrdersByDateRange = async (from, to) => {
  const result = await pool.query(`
    SELECT * FROM orders
    WHERE status = 'approved'
      AND created_at >= $1::date
      AND created_at < ($2::date + INTERVAL '1 day')
    ORDER BY id DESC
  `, [from, to]);
  return result.rows.map(mapOrder);
};

export const deleteOrder = async (orderId, userId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query('SELECT id, status, stock_reserved FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return false;
    }
    const items = (await client.query('SELECT product_id, size, quantity FROM order_items WHERE order_id = $1 FOR UPDATE', [orderId])).rows;
    if (order.stock_reserved) await releaseOrderStock(client, items);
    await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
    await client.query('DELETE FROM order_shipping_details WHERE order_id = $1', [orderId]);
    await client.query('DELETE FROM orders WHERE id = $1', [orderId]);
    await client.query(
      'INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)',
      [userId, 'DELETE_ORDER', 'orders', orderId, JSON.stringify({ status: order.status })]
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getOrderItemsByOrderId = async (orderId) => {
  const result = await pool.query(`
    SELECT oi.*, p.title AS product_title, p.type AS product_type, c.name AS club_name
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN clubs c ON c.id = p.club_id
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
    SELECT oi.*, p.title AS product_title, p.type AS product_type, c.name AS club_name
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN clubs c ON c.id = p.club_id
    WHERE oi.order_id = $1
  `, [orderId]);
  const shippingResult = await pool.query('SELECT full_name, phone, cedula, agency, city, state FROM order_shipping_details WHERE order_id = $1', [orderId]);
  if (shippingResult.rows[0]) {
    const shipping = shippingResult.rows[0];
    order.shipping_details = { name: shipping.full_name, phone: shipping.phone, cedula: shipping.cedula, agency: shipping.agency, city: shipping.city, state: shipping.state };
  }
  const clientResult = await pool.query('SELECT * FROM users WHERE id = $1', [order.client_id]);
  return {
    order,
    items: itemsResult.rows.map(mapOrderItem),
    client: mapUser(clientResult.rows[0])
  };
};

export const updateOrderStatus = async (orderId, status, userId) => {
  const allowedStatuses = new Set(['pending', 'approved', 'requires_info', 'preparing', 'ready_pickup', 'shipped', 'delivered', 'rejected', 'cancelled']);
  if (!allowedStatuses.has(status)) return null;
  const dbClient = await pool.connect();
  let previousStatus;
  let updatedOrder;
  try {
    await dbClient.query('BEGIN');
    const orderResult = await dbClient.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = orderResult.rows[0];
    if (!order) {
      await dbClient.query('ROLLBACK');
      return null;
    }
    previousStatus = order.status;
    const items = (await dbClient.query('SELECT product_id, size, quantity FROM order_items WHERE order_id = $1 FOR UPDATE', [orderId])).rows;
    let stockReserved = Boolean(order.stock_reserved);
    if (['cancelled', 'rejected'].includes(status) && stockReserved) {
      await releaseOrderStock(dbClient, items);
      stockReserved = false;
    } else if (!['cancelled', 'rejected'].includes(status) && !stockReserved) {
      await reserveOrderStock(dbClient, items);
      stockReserved = true;
    }
    const result = await dbClient.query(`
      UPDATE orders SET
        status = $1,
        stock_reserved = $4,
        payment_received_at = CASE
          WHEN $1 = ANY($3::varchar[]) AND payment_received_at IS NULL
            AND (payment_proof_url IS NOT NULL OR first_payment_amount > 0 OR full_payment_amount > 0)
          THEN CURRENT_TIMESTAMP ELSE payment_received_at
        END,
        delivery_payment_received_at = CASE
          WHEN $1 = ANY($3::varchar[]) AND payment_plan = 'installments' AND delivery_payment_received_at IS NULL
            AND (delivery_payment_proof_url IS NOT NULL OR delivery_payment_amount > 0)
          THEN CURRENT_TIMESTAMP ELSE delivery_payment_received_at
        END
      WHERE id = $2
      RETURNING *
    `, [status, orderId, ['approved', 'preparing', 'ready_pickup', 'shipped', 'delivered'], stockReserved]);
    await dbClient.query('INSERT INTO audit_logs (user_id, action, table_name, record_id, changes) VALUES ($1, $2, $3, $4, $5)', [userId, 'UPDATE_ORDER', 'orders', orderId, JSON.stringify({ status })]);
    await dbClient.query('COMMIT');
    updatedOrder = mapOrder(result.rows[0]);
  } catch (error) {
    await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    dbClient.release();
  }

  if (status !== previousStatus) {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [updatedOrder.client_id]);
    const client = userRes.rows[0];
    if (status === 'approved' && client?.email) {
      await sendOrderApprovedEmail({
        to: client.email,
        userName: client.name,
        orderId: updatedOrder.id
      });
    }

    createNotification({
      userId: updatedOrder.client_id,
      title: status === 'approved' ? 'Pedido aprobado' : 'Actualización de pedido',
      message: `Tu pedido #${updatedOrder.id} ahora está: ${status}.`,
      type: status === 'rejected' || status === 'cancelled' ? 'warning' : 'success'
    });
  }

  return updatedOrder;
};

const normalizeClosurePeriod = (periodType = 'day') => {
  const safePeriod = String(periodType || 'day').toLowerCase();
  return safePeriod === 'month' || safePeriod === 'year' ? safePeriod : 'day';
};

const getClosureWindow = (periodType = 'day', referenceDate = new Date()) => {
  const date = referenceDate instanceof Date
    ? new Date(referenceDate)
    : /^\d{4}-\d{2}-\d{2}$/.test(String(referenceDate))
      ? new Date(`${referenceDate}T12:00:00`)
      : new Date(referenceDate);
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

const formatClosureDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const saveSystemSetting = async (key, value) => {
  await pool.query(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [key, String(value)]);
};

const getClosurePaymentEvents = async ({ startDate, endDate, calendarDates }) => {
  const fallbackRate = Number(await getExchangeRate()) || 1;
  let localStart;
  let localEnd;
  if (calendarDates) {
    localStart = `${startDate}T00:00:00.000000`;
    localEnd = `${endDate}T23:59:59.999999`;
  } else {
    const bounds = await pool.query(`
      SELECT
        to_char($1::timestamp AT TIME ZONE current_setting('TIMEZONE') AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS local_start,
        to_char($2::timestamp AT TIME ZONE current_setting('TIMEZONE') AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS local_end
    `, [startDate, endDate]);
    localStart = bounds.rows[0].local_start;
    localEnd = bounds.rows[0].local_end;
  }

  const result = await pool.query(`
    SELECT id, total_amount, payment_method, payment_plan, exchange_rate,
      first_payment_amount, first_payment_currency, full_payment_amount,
      delivery_payment_amount, delivery_payment_currency,
      payment_proof_url, delivery_payment_proof_url,
      to_char(COALESCE(payment_received_at AT TIME ZONE 'America/Caracas', created_at AT TIME ZONE current_setting('TIMEZONE') AT TIME ZONE 'America/Caracas'), 'YYYY-MM-DD"T"HH24:MI:SS.US') AS first_payment_local,
      to_char(COALESCE(delivery_payment_received_at AT TIME ZONE 'America/Caracas', created_at AT TIME ZONE current_setting('TIMEZONE') AT TIME ZONE 'America/Caracas'), 'YYYY-MM-DD"T"HH24:MI:SS.US') AS final_payment_local
    FROM orders
    WHERE status IN ('approved', 'preparing', 'ready_pickup', 'shipped', 'delivered')
  `);

  const paymentTotals = { USD: 0, BS: 0, totalUsd: 0 };
  const payments = [];
  const toUsd = (amount, currency, rate) => currency === 'BS' ? amount / rate : amount;
  const isWithinPeriod = (date) => date >= localStart && date <= localEnd;

  result.rows.forEach((order) => {
    const totalUsd = Number(order.total_amount || 0);
    const storedRate = Number(order.exchange_rate || 0);
    const rate = storedRate > 0 ? storedRate : fallbackRate;
    const normalizedMethod = String(order.payment_method || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const methodCurrency = normalizedMethod === 'pagomovil' ? 'BS' : 'USD';
    const entries = [];
    let paidUsd = 0;

    if (order.payment_plan === 'installments') {
      const firstAmount = Number(order.first_payment_amount || 0);
      const firstCurrency = String(order.first_payment_currency || 'USD').toUpperCase() === 'BS' ? 'BS' : 'USD';
      const firstUsd = Math.max(0, toUsd(firstAmount, firstCurrency, rate));
      paidUsd += firstUsd;
      if (firstAmount > 0 && isWithinPeriod(order.first_payment_local)) {
        entries.push({ kind: 'Abono inicial', amount: firstAmount, currency: firstCurrency, amountUsd: firstUsd, receivedAt: order.first_payment_local });
      }

      const finalCurrency = String(order.delivery_payment_currency || methodCurrency).toUpperCase() === 'BS' ? 'BS' : 'USD';
      const storedFinalAmount = Number(order.delivery_payment_amount || 0);
      const finalAmount = storedFinalAmount > 0
        ? storedFinalAmount
        : order.delivery_payment_proof_url ? Math.max(0, totalUsd - firstUsd) * (finalCurrency === 'BS' ? rate : 1) : 0;
      const finalUsd = Math.max(0, toUsd(finalAmount, finalCurrency, rate));
      paidUsd += finalUsd;
      if (finalAmount > 0 && isWithinPeriod(order.final_payment_local)) {
        entries.push({ kind: 'Abono final', amount: finalAmount, currency: finalCurrency, amountUsd: finalUsd, receivedAt: order.final_payment_local });
      }
    } else {
      const storedAmount = Number(order.full_payment_amount || 0);
      const amount = storedAmount > 0 ? storedAmount : totalUsd * (methodCurrency === 'BS' ? rate : 1);
      const amountUsd = Math.max(0, toUsd(amount, methodCurrency, rate));
      paidUsd = amountUsd;
      if (amount > 0 && isWithinPeriod(order.first_payment_local)) {
        entries.push({ kind: 'Pago completo', amount, currency: methodCurrency, amountUsd, receivedAt: order.first_payment_local });
      }
    }

    const remainingUsd = Math.max(0, totalUsd - Math.min(totalUsd, paidUsd));
    entries.forEach((entry) => {
      const payment = {
        orderId: order.id,
        ...entry,
        remainingUsd,
        remainingBs: remainingUsd * rate
      };
      payments.push(payment);
      paymentTotals[entry.currency] += entry.amount;
      paymentTotals.totalUsd += entry.amountUsd;
    });
  });

  return {
    payments: payments.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt)),
    paymentTotals,
    paymentOrdersCount: new Set(payments.map((payment) => payment.orderId)).size
  };
};

const buildClosureSummary = async ({ periodType, periodLabel, startDate, endDate, calendarDates = false }) => {
  const datePredicate = (column) => calendarDates
    ? `(${column} AT TIME ZONE current_setting('TIMEZONE') AT TIME ZONE 'America/Caracas')::date >= $1::date AND (${column} AT TIME ZONE current_setting('TIMEZONE') AT TIME ZONE 'America/Caracas')::date <= $2::date`
    : `${column} >= $1::timestamp AND ${column} <= $2::timestamp`;
  const ordersRes = await pool.query(`
    SELECT id, total_amount,
      to_char(created_at AT TIME ZONE current_setting('TIMEZONE') AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at_local
    FROM orders
    WHERE status = 'approved' AND ${datePredicate('created_at')}
    ORDER BY created_at DESC
  `, [startDate, endDate]);
  const itemsRes = await pool.query(`
    SELECT oi.order_id, oi.quantity, oi.unit_price, p.title
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.status = 'approved' AND ${datePredicate('o.created_at')}
    ORDER BY oi.order_id, oi.id
  `, [startDate, endDate]);

  const orders = ordersRes.rows.map((row) => ({
    id: row.id,
    totalAmount: Number(row.total_amount),
    createdAt: row.created_at_local
  }));
  const itemsByOrder = itemsRes.rows.reduce((acc, row) => {
    if (!acc[row.order_id]) acc[row.order_id] = [];
    acc[row.order_id].push({ title: row.title || 'Producto', quantity: Number(row.quantity), unitPrice: Number(row.unit_price) });
    return acc;
  }, {});
  const paymentSummary = await getClosurePaymentEvents({ startDate, endDate, calendarDates });

  return {
    periodType,
    periodLabel,
    startDate,
    endDate,
    totalAmount: orders.reduce((sum, order) => sum + order.totalAmount, 0),
    ordersCount: orders.length,
    itemsSold: itemsRes.rows.reduce((sum, row) => sum + Number(row.quantity), 0),
    orders,
    itemsByOrder,
    ...paymentSummary
  };
};

const getDailyClosureState = async () => {
  const result = await pool.query(`
    SELECT
      (SELECT value FROM system_settings WHERE key = 'daily_closure_open') AS is_open,
      (SELECT value FROM system_settings WHERE key = 'daily_closure_started_at') AS started_at,
      LOCALTIMESTAMP::text AS now,
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date::text AS today,
      (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas') AT TIME ZONE 'America/Caracas' AT TIME ZONE current_setting('TIMEZONE'))::text AS today_start
  `);
  const row = result.rows[0];
  const isOpen = row.is_open === null ? true : row.is_open === 'true';
  let startedAt = row.started_at;

  if (!startedAt) {
    startedAt = row.today_start;
    await saveSystemSetting('daily_closure_started_at', startedAt);
    await saveSystemSetting('daily_closure_open', 'true');
  } else if (isOpen && startedAt.slice(0, 10) < row.today) {
    startedAt = row.today_start;
    await saveSystemSetting('daily_closure_started_at', startedAt);
  }

  return { isOpen, startedAt, now: row.now, today: row.today };
};

export const getDailyClosureReport = async () => {
  const state = await getDailyClosureState();
  if (state.isOpen) {
    const periodLabel = new Date(`${state.today}T12:00:00`).toLocaleDateString('es-VE');
    return {
      ...(await buildClosureSummary({ periodType: 'day', periodLabel, startDate: state.startedAt, endDate: state.now })),
      isOpen: true,
      countStartedAt: state.startedAt
    };
  }

  const result = await pool.query(`
    SELECT period_label, start_date, end_date, total_amount, orders_count, items_sold, details
    FROM daily_closures
    WHERE period_type = 'day'
    ORDER BY id DESC
    LIMIT 1
  `);
  const closure = result.rows[0];
  const details = closure ? (typeof closure.details === 'string' ? JSON.parse(closure.details) : closure.details || []) : [];
  const legacyOrders = Array.isArray(details) ? details : details.orders || [];
  return closure ? {
    periodType: 'day',
    periodLabel: closure.period_label,
    startDate: closure.start_date,
    endDate: closure.end_date,
    totalAmount: Number(closure.total_amount),
    ordersCount: Number(closure.orders_count),
    itemsSold: Number(closure.items_sold),
    orders: legacyOrders,
    payments: Array.isArray(details) ? [] : details.payments || [],
    paymentTotals: Array.isArray(details) ? { USD: 0, BS: 0, totalUsd: 0 } : details.paymentTotals || { USD: 0, BS: 0, totalUsd: 0 },
    paymentOrdersCount: Array.isArray(details) ? 0 : details.paymentOrdersCount || 0,
    itemsByOrder: {},
    isOpen: false,
    countStartedAt: null
  } : { periodType: 'day', periodLabel: '', totalAmount: 0, ordersCount: 0, itemsSold: 0, orders: [], payments: [], paymentTotals: { USD: 0, BS: 0, totalUsd: 0 }, paymentOrdersCount: 0, itemsByOrder: {}, isOpen: false, countStartedAt: null };
};

export const openDailyClosure = async () => {
  const state = await getDailyClosureState();
  if (state.isOpen) throw new Error('El conteo diario ya está abierto.');
  const result = await pool.query('SELECT LOCALTIMESTAMP::text AS started_at');
  await saveSystemSetting('daily_closure_started_at', result.rows[0].started_at);
  await saveSystemSetting('daily_closure_open', 'true');
  return getDailyClosureReport();
};

export const getSalesClosureSummary = async (periodType = 'day', referenceDate = new Date()) => {
  const safePeriod = normalizeClosurePeriod(periodType);
  const { start, end, label } = getClosureWindow(safePeriod, referenceDate);
  const startDate = formatClosureDate(start);
  const endDate = formatClosureDate(end);
  return buildClosureSummary({ periodType: safePeriod, periodLabel: label, startDate, endDate, calendarDates: true });
};

export const createSalesClosure = async (periodType = 'day', referenceDate = new Date()) => {
  const safePeriod = normalizeClosurePeriod(periodType);
  let summary;
  if (safePeriod === 'day') {
    const state = await getDailyClosureState();
    if (!state.isOpen) throw new Error('Abre el conteo del día antes de generar un cierre nuevo.');
    const periodLabel = new Date(`${state.today}T12:00:00`).toLocaleDateString('es-VE');
    summary = {
      ...(await buildClosureSummary({ periodType: 'day', periodLabel, startDate: state.startedAt, endDate: state.now })),
      isOpen: false,
      countStartedAt: state.startedAt
    };
  } else {
    summary = await getSalesClosureSummary(safePeriod, referenceDate);
  }
  await pool.query(`
    INSERT INTO daily_closures (period_type, period_label, start_date, end_date, total_amount, orders_count, items_sold, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [summary.periodType, summary.periodLabel, summary.startDate, summary.endDate, Number(summary.totalAmount).toFixed(2), summary.ordersCount, summary.itemsSold, JSON.stringify({ orders: summary.orders, payments: summary.payments || [], paymentTotals: summary.paymentTotals || { USD: 0, BS: 0, totalUsd: 0 }, paymentOrdersCount: summary.paymentOrdersCount || 0 })]);
  if (safePeriod === 'day') await saveSystemSetting('daily_closure_open', 'false');
  return summary;
};

export const getDashboardStats = async () => {
  const metricsResetAt = await getMetricsResetAt();
  const metricsParams = [metricsResetAt];
  const productsRes = await pool.query('SELECT COUNT(*)::int AS count FROM products');
  const stockRes = await pool.query('SELECT COALESCE(SUM(stock), 0)::int AS stock FROM products');
  const confirmedStatuses = ['approved', 'preparing', 'ready_pickup', 'shipped', 'delivered'];
  const soldItemsRes = await pool.query(`
    SELECT COALESCE(SUM(oi.quantity), 0)::int AS count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = ANY($1::varchar[]) AND ($2::timestamp IS NULL OR o.created_at >= $2::timestamp)
  `, [confirmedStatuses, metricsParams[0]]);
  const revenueRes = await pool.query(`
    SELECT COALESCE(SUM(total_amount), 0)::numeric(12,2) AS usd
    FROM orders
    WHERE status = ANY($1::varchar[]) AND ($2::timestamp IS NULL OR created_at >= $2::timestamp)
  `, [confirmedStatuses, metricsParams[0]]);
  const lowStockRes = await pool.query('SELECT * FROM products WHERE stock <= 5 ORDER BY stock ASC, title ASC');
  const bestSellerRes = await pool.query(`
    SELECT p.title, SUM(oi.quantity) AS qty
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE o.status = ANY($1::varchar[]) AND ($2::timestamp IS NULL OR o.created_at >= $2::timestamp)
    GROUP BY p.title
    ORDER BY qty DESC
    LIMIT 1
  `, [confirmedStatuses, metricsParams[0]]);
  const statusRes = await pool.query(`
    SELECT status, COUNT(*)::int AS count
    FROM orders
    GROUP BY status
    ORDER BY status
  `);
  const trendRes = await pool.query(`
    SELECT to_char(created_at, 'YYYY-MM') AS month, COALESCE(SUM(total_amount), 0)::numeric(12,2) AS usd
    FROM orders
    WHERE status = ANY($1::varchar[]) AND created_at >= NOW() - INTERVAL '6 months'
      AND ($2::timestamp IS NULL OR created_at >= $2::timestamp)
    GROUP BY 1
    ORDER BY 1
  `, [confirmedStatuses, metricsParams[0]]);
  const topProductsRes = await pool.query(`
    SELECT p.title, SUM(oi.quantity)::int AS qty, COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric(12,2) AS revenue
    FROM order_items oi
    LEFT JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.status = ANY($1::varchar[]) AND ($2::timestamp IS NULL OR o.created_at >= $2::timestamp)
    GROUP BY p.title
    ORDER BY revenue DESC, qty DESC
    LIMIT 4
  `, [confirmedStatuses, metricsParams[0]]);
  const exchangeRate = await getExchangeRate();
  const paymentLedgerRes = await pool.query(`
    WITH active_orders AS (
      SELECT
        REGEXP_REPLACE(TRANSLATE(LOWER(payment_method), 'áéíóúü', 'aeiouu'), '[^a-z0-9]', '', 'g') = 'pagomovil' AS method_is_bs,
        total_amount::numeric AS total_usd,
        CASE WHEN COALESCE(exchange_rate, 0) > 0 THEN exchange_rate ELSE $1::numeric END AS rate,
        payment_plan,
        first_payment_amount::numeric AS first_payment_amount,
        first_payment_currency,
        full_payment_amount::numeric AS full_payment_amount,
        delivery_payment_amount::numeric AS delivery_payment_amount,
        delivery_payment_currency,
        delivery_payment_proof_url,
        status IN ('approved', 'preparing', 'ready_pickup', 'shipped', 'delivered') AS is_confirmed
      FROM orders
      WHERE status NOT IN ('rejected', 'cancelled')
    ), payments_usd AS (
      SELECT *,
        CASE WHEN is_confirmed AND payment_plan = 'installments'
          THEN CASE WHEN first_payment_currency = 'BS' THEN first_payment_amount / rate ELSE first_payment_amount END
          ELSE 0
        END AS first_usd,
        CASE
          WHEN is_confirmed AND payment_plan = 'full' THEN
            CASE WHEN full_payment_amount > 0
              THEN CASE WHEN method_is_bs THEN full_payment_amount / rate ELSE full_payment_amount END
              ELSE total_usd
            END
          WHEN is_confirmed AND payment_plan = 'installments' THEN
            CASE
              WHEN delivery_payment_amount > 0 THEN
                CASE WHEN COALESCE(NULLIF(delivery_payment_currency, ''), CASE WHEN method_is_bs THEN 'BS' ELSE 'USD' END) = 'BS' THEN delivery_payment_amount / rate ELSE delivery_payment_amount END
              WHEN delivery_payment_proof_url IS NOT NULL THEN
                GREATEST(0, total_usd - CASE WHEN first_payment_currency = 'BS' THEN first_payment_amount / rate ELSE first_payment_amount END)
              ELSE 0
            END
          ELSE 0
        END AS other_usd,
        CASE WHEN payment_plan = 'installments'
          THEN COALESCE(NULLIF(delivery_payment_currency, ''), CASE WHEN method_is_bs THEN 'BS' ELSE 'USD' END) = 'BS'
          ELSE method_is_bs
        END AS other_is_bs
      FROM active_orders
    ), bounded_first_payments AS (
      SELECT *,
        LEAST(total_usd, GREATEST(0, first_usd)) AS capped_first_usd
      FROM payments_usd
    ), bounded_payments AS (
      SELECT *,
        LEAST(GREATEST(0, total_usd - capped_first_usd), GREATEST(0, other_usd)) AS capped_other_usd,
        capped_first_usd + LEAST(GREATEST(0, total_usd - capped_first_usd), GREATEST(0, other_usd)) AS received_usd
      FROM bounded_first_payments
    )
    SELECT
      COALESCE(SUM(total_usd), 0) AS usd_expected,
      COALESCE(SUM(total_usd * rate), 0) AS bs_expected,
      COALESCE(SUM(CASE WHEN UPPER(COALESCE(first_payment_currency, '')) = 'USD' THEN capped_first_usd ELSE 0 END), 0) AS first_received_usd,
      COALESCE(SUM(CASE WHEN UPPER(COALESCE(first_payment_currency, '')) = 'BS' THEN capped_first_usd * rate ELSE 0 END), 0) AS first_received_bs,
      COALESCE(SUM(CASE WHEN NOT other_is_bs THEN capped_other_usd ELSE 0 END), 0) AS other_received_usd,
      COALESCE(SUM(CASE WHEN other_is_bs THEN capped_other_usd * rate ELSE 0 END), 0) AS other_received_bs,
      COALESCE(SUM(CASE WHEN UPPER(COALESCE(first_payment_currency, '')) = 'USD' THEN capped_first_usd ELSE 0 END + CASE WHEN NOT other_is_bs THEN capped_other_usd ELSE 0 END), 0) AS usd_received,
      COALESCE(SUM(CASE WHEN UPPER(COALESCE(first_payment_currency, '')) = 'BS' THEN capped_first_usd * rate ELSE 0 END + CASE WHEN other_is_bs THEN capped_other_usd * rate ELSE 0 END), 0) AS bs_received,
      COALESCE(SUM(GREATEST(0, total_usd - received_usd)), 0) AS usd_pending,
      COALESCE(SUM(GREATEST(0, total_usd - received_usd) * rate), 0) AS bs_pending
    FROM bounded_payments
  `, [exchangeRate]);
  const ledgerRow = paymentLedgerRes.rows[0] || {};
  const paymentLedger = {
    USD: {
      expected: Number(ledgerRow.usd_expected || 0),
      first: Number(ledgerRow.first_received_usd || 0),
      other: Number(ledgerRow.other_received_usd || 0),
      received: Number(ledgerRow.usd_received || 0),
      pending: Number(ledgerRow.usd_pending || 0)
    },
    BS: {
      expected: Number(ledgerRow.bs_expected || 0),
      first: Number(ledgerRow.first_received_bs || 0),
      other: Number(ledgerRow.other_received_bs || 0),
      received: Number(ledgerRow.bs_received || 0),
      pending: Number(ledgerRow.bs_pending || 0)
    }
  };

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
    paymentLedger,
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

export const getUsersAdmin = async () => {
  const result = await pool.query(`
    SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at,
      COUNT(DISTINCT o.id)::int AS orders_count,
      COALESCE(SUM(CASE WHEN o.status = 'approved' THEN o.total_amount ELSE 0 END), 0)::numeric AS approved_total
    FROM users u
    LEFT JOIN orders o ON o.client_id = u.id
    GROUP BY u.id
    ORDER BY u.id DESC
  `);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    created_at: row.created_at,
    orders_count: Number(row.orders_count || 0),
    approved_total: Number(row.approved_total || 0)
  }));
};

export const updateUserAdmin = async (id, payload) => {
  const allowedRoles = new Set(['client', 'admin']);
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim();
  const phone = String(payload.phone || '').trim();
  const role = allowedRoles.has(payload.role) ? payload.role : 'client';
  if (!name || !email) return null;
  const result = await pool.query(
    'UPDATE users SET name = $1, email = $2, phone = $3, role = $4 WHERE id = $5 RETURNING id, name, email, phone, role, created_at',
    [name, email, phone || null, role, id]
  );
  return result.rows[0] || null;
};

export const deleteUserAdmin = async (id, currentUserId) => {
  if (Number(id) === Number(currentUserId)) return { error: 'No puedes eliminar tu propia cuenta.' };
  const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
  if (!userResult.rows[0]) return { error: 'Usuario no encontrado.' };
  await pool.query('UPDATE orders SET client_id = NULL WHERE client_id = $1', [id]);
  await pool.query('UPDATE audit_logs SET user_id = NULL WHERE user_id = $1', [id]);
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  return { success: true };
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
