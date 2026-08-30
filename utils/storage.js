import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configuredUploadDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

const ensureWritableDirectory = (directory) => {
	try {
		fs.mkdirSync(directory, { recursive: true });
		fs.accessSync(directory, fs.constants.W_OK);
		return directory;
	} catch (error) {
		const fallbackDir = path.join('/tmp', 'camisetas-uploads');
		fs.mkdirSync(fallbackDir, { recursive: true });
		console.warn(`No se puede escribir en ${directory}; usando ${fallbackDir}. Configura el Persistent Disk de Render para conservar archivos.`);
		return fallbackDir;
	}
};

export const uploadDir = ensureWritableDirectory(configuredUploadDir);
