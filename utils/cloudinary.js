import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

dotenv.config();

const isConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME
  && process.env.CLOUDINARY_API_KEY
  && process.env.CLOUDINARY_API_SECRET
);

if (isConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

export const uploadProof = async (filePath) => {
  if (!isConfigured) return null;

  const result = await cloudinary.uploader.upload(filePath, {
    folder: 'camisetas/comprobantes',
    resource_type: 'image'
  });
  return result.secure_url;
};

export const isCloudinaryConfigured = isConfigured;

export const uploadStoreContent = async (filePath, originalName = '') => {
  if (!isConfigured) return null;

  const result = await cloudinary.uploader.upload(filePath, {
    folder: 'camisetas/contenido',
    resource_type: 'auto',
    use_filename: true,
    unique_filename: true,
    filename_override: originalName || undefined
  });
  return result.secure_url;
};
