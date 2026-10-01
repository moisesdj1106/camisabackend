import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import multer from 'multer';
import { initializeStore } from './data/store.js';
import { uploadDir } from './utils/storage.js';
import { authRouter } from './routes/auth.js';
import { productsRouter } from './routes/products.js';
import { ordersRouter } from './routes/orders.js';
import { adminRouter } from './routes/admin.js';
import { contentRouter } from './routes/content.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const normalizedOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    console.warn(`CORS bloqueado para origen: ${origin}. Orígenes permitidos: ${allowedOrigins.join(', ')}`);
    return callback(new Error('Origen no permitido por CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) return callback(null, true);
    callback(new Error('Solo se permiten imágenes o videos.'));
  }
});
app.locals.upload = upload;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'API de camisetas deportiva lista' });
});

app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/content', contentRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);

initializeStore()
  .then(() => {
    app.listen(port, () => {
      console.log(`Backend listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('No se pudo inicializar la base de datos local:', error.message);
    process.exit(1);
  });
