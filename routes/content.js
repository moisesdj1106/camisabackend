import express from 'express';
import { listStoreContent } from '../data/store.js';

export const contentRouter = express.Router();

contentRouter.get('/', async (_req, res) => {
  res.json(await listStoreContent(true));
});