import { v2 as cloudinary } from 'cloudinary';

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
