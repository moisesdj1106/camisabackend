import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

export const hashPassword = async (password) => bcrypt.hash(password, 10);
export const comparePassword = async (password, hash) => bcrypt.compare(password, hash);

export const signToken = (payload) => jwt.sign(payload, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '8h' });
export const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
