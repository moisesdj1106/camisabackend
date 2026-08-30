import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const notificationsFile = path.join(__dirname, '..', 'uploads', 'notifications.json');

const ensureFile = () => {
  const dir = path.dirname(notificationsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(notificationsFile)) {
    fs.writeFileSync(notificationsFile, '[]');
  }
};

const readNotifications = () => {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(notificationsFile, 'utf8'));
  } catch (error) {
    return [];
  }
};

const writeNotifications = (data) => {
  ensureFile();
  fs.writeFileSync(notificationsFile, JSON.stringify(data, null, 2));
};

export const createNotification = ({ userId, title, message, type = 'info' }) => {
  const notifications = readNotifications();
  const next = {
    id: `${Date.now()}-${Math.round(Math.random() * 100000)}`,
    userId,
    title,
    message,
    type,
    read: false,
    createdAt: new Date().toISOString()
  };
  notifications.unshift(next);
  writeNotifications(notifications);
  return next;
};

export const getNotificationsForUser = (userId) => {
  return readNotifications().filter((item) => String(item.userId) === String(userId));
};

export const markNotificationAsRead = (notificationId, userId) => {
  const notifications = readNotifications();
  const updated = notifications.map((item) => {
    if (String(item.id) === String(notificationId) && String(item.userId) === String(userId)) {
      return { ...item, read: true };
    }
    return item;
  });
  writeNotifications(updated);
  return updated.find((item) => String(item.id) === String(notificationId));
};

export const clearNotifications = (userId) => {
  const notifications = readNotifications().filter((item) => String(item.userId) !== String(userId));
  writeNotifications(notifications);
};
