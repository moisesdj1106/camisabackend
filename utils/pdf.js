import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { uploadDir } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const findLogoPath = () => {
  const candidates = [
    path.join(__dirname, 'logosinfondo.png'),
    path.join(__dirname, '../../frontend/public/logosinfondo.png'),
    path.join(__dirname, '../../frontend/public/loguito.png'),
    path.join(process.cwd(), '../frontend/public/logosinfondo.png'),
    path.join(process.cwd(), '../frontend/public/loguito.png')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
};

const paymentMethodLabels = {
  pago_movil: 'Pago Móvil',
  efectivo: 'Efectivo',
  binance: 'Binance'
};

const orderStatusLabels = {
  pending: 'Pendiente',
  approved: 'Aprobado',
  requires_info: 'Requiere información',
  preparing: 'En preparación',
  ready_pickup: 'Listo para retirar',
  shipped: 'Enviado',
  delivered: 'Entregado',
  rejected: 'Rechazado',
  cancelled: 'Cancelado'
};

const productTypeLabels = {
  local: 'Local',
  visitante: 'Visitante',
  tercera: 'Alterna'
};

const productTypeLabel = (type, title = '') => {
  const normalizedType = String(type || '').trim().toLowerCase();
  if (productTypeLabels[normalizedType]) return productTypeLabels[normalizedType];
  const normalizedTitle = String(title).toLowerCase();
  if (/\bvisitante\b/.test(normalizedTitle)) return 'Visitante';
  if (/\b(local|alterna|alternativa|tercera)\b/.test(normalizedTitle)) return normalizedTitle.includes('local') ? 'Local' : 'Alterna';
  return 'N/D';
};

const drawCell = (doc, x, y, width, height, text, options = {}) => {
  doc.rect(x, y, width, height).stroke();
  doc.fontSize(options.fontSize || 10);
  doc.fillColor(options.color || '#111827');
  doc.text(text, x + 8, y + 6, {
    width: width - 12,
    align: options.align || 'left'
  });
};

const drawInstagramIcon = (doc, x, y, size = 14) => {
  doc.save();
  doc.lineWidth(1.4).roundedRect(x, y, size, size, 3).stroke('#2563eb');
  doc.circle(x + size / 2, y + size / 2, size * 0.25).stroke('#2563eb');
  doc.circle(x + size * 0.74, y + size * 0.26, 1).fill('#2563eb');
  doc.restore();
};

const drawWhatsappIcon = (doc, x, y, size = 15) => {
  doc.save();
  doc.lineWidth(1.3).circle(x + size / 2, y + size / 2, size * 0.43).stroke('#16a34a');
  doc.moveTo(x + size * 0.2, y + size * 0.82)
    .lineTo(x + size * 0.12, y + size * 0.98)
    .lineTo(x + size * 0.38, y + size * 0.86)
    .stroke('#16a34a');
  doc.restore();
};

const drawInvoiceFooter = (doc, logoPath) => {
  const footerY = doc.page.height - 120;
  doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor('#dbe5f1').stroke();
  if (logoPath) {
    doc.rect(40, footerY + 4, 76, 60).fill('#ffffff');
    doc.image(logoPath, 44, footerY + 7, { fit: [68, 54], align: 'center', valign: 'center' });
  }
  doc.fontSize(8.5).fillColor('#475569').text('MDJ SOCCER · San Cristóbal, Táchira, Venezuela', 115, footerY + 18);
  doc.fontSize(8.5).fillColor('#475569').text('Teléfono: +58 0414-714-6602', 115, footerY + 34);

  drawInstagramIcon(doc, 325, footerY + 27);
  doc.fontSize(8.5).fillColor('#2563eb').text('@mdj_soccer', 344, footerY + 30);
  drawWhatsappIcon(doc, 420, footerY + 26);
  doc.fontSize(8.5).fillColor('#16a34a').text('+58 0414-714-6602', 445, footerY + 30);
};

export const createInvoicePdf = async (order, items, client, options = {}) => {
  const exchangeRate = Number(options.exchangeRate || 36);
  const doc = new PDFDocument({ size: 'A4', margin: 40, bottomMargin: 90 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const totalUsd = Number(order.total_amount || 0);
  const totalBs = totalUsd * exchangeRate;
  const isInstallmentOrder = order.payment_plan === 'installments';
  const firstPaymentAmount = Number(order.first_payment_amount || 0);
  const firstPaymentCurrency = order.first_payment_currency === 'BS' ? 'BS' : 'USD';
  const firstPaymentUsd = firstPaymentCurrency === 'BS' ? firstPaymentAmount / exchangeRate : firstPaymentAmount;
  const paymentComplete = Boolean(order.payment_proof_url && order.delivery_payment_proof_url);
  const remainingUsd = paymentComplete ? 0 : Math.max(0, totalUsd - firstPaymentUsd);
  const remainingBs = remainingUsd * exchangeRate;
  const invoiceNumber = order.invoice_number || `INV-${String(order.id).padStart(4, '0')}`;

  const accentBlue = '#0f2d52';
  const accentLight = '#eaf3ff';
  const accentMid = '#2563eb';
  const textStrong = '#0f172a';
  const textSoft = '#475569';
  const borderColor = '#dbeafe';
  const rowEven = '#f8fbff';
  const rowOdd = '#eef5ff';

  const drawSummaryCard = (x, y, width, height, title, lines, dark = false) => {
    const fillColor = dark ? accentBlue : '#ffffff';
    const titleColor = dark ? '#ffffff' : accentBlue;
    const textColor = dark ? '#dbeafe' : textStrong;
    doc.roundedRect(x, y, width, height, 12).fill(fillColor).strokeColor(borderColor).stroke();
    doc.roundedRect(x, y, width, 26, 12).fill(dark ? '#1d4ed8' : accentLight);
    doc.fillColor(titleColor).fontSize(9.5).text(title.toUpperCase(), x + 12, y + 8, { width: width - 24, align: 'left' });

    let lineY = y + 38;
    lines.forEach((line) => {
      doc.fillColor(textColor).fontSize(9.5).text(String(line), x + 12, lineY, { width: width - 24 });
      lineY += 16;
    });
  };

  const logoPath = findLogoPath();
  const logoImage = logoPath ? fs.readFileSync(logoPath) : null;

  doc.fillColor('#f4f8ff').rect(0, 0, doc.page.width, 700).fill();
  doc.roundedRect(38, 36, 516, 86, 18).fill(accentBlue);
  doc.fillColor('#ffffff').fontSize(24).text('MDJ SOCCER', 58, 56);

  
  doc.roundedRect(394, 46, 140, 46, 10).fill('#1d4ed8');
  doc.fillColor('#ffffff').fontSize(8.5).text('FACTURA', 422, 56, { width: 90, align: 'center' });
  doc.fillColor('#dbeafe').fontSize(11).text(invoiceNumber, 422, 70, { width: 90, align: 'center' });

  drawSummaryCard(40, 146, 245, 92, 'Cliente', [
    client?.name || 'Cliente',
    client?.email || 'Sin correo',
    client?.phone || 'Sin teléfono'
  ]);

  drawSummaryCard(295, 146, 259, 92, 'Pedido', [
    `#${order.id}`,
    `Estado: ${orderStatusLabels[order.status] || order.status || 'No indicado'}`,
    `Método: ${paymentMethodLabels[order.payment_method] || order.payment_method || 'No indicado'}`
  ], true);

  drawSummaryCard(40, 252, 245, 90, 'Empresa', [
    'MDJ SOCCER',
    'mdjsoccer26@gmail.com',
    '+58 0414-714-6602'
  ]);

  drawSummaryCard(295, 252, 259, 90, 'Resumen', [
    `Tipo de cambio: ${exchangeRate.toFixed(2)} BS/USD`,
    `Fecha: ${new Date(order.created_at || Date.now()).toLocaleDateString('es-VE')}`,
    `Entrega: ${order.delivery_method || 'No indicado'}`
  ]);

  doc.fontSize(14).fillColor(accentBlue).text('Detalle de compra', 40, 356);
  const tableTop = 380;
  doc.rect(40, tableTop, 514, 24).fill(accentBlue);
  const tableHeader = (x, width, text, align = 'left') => {
    doc.fillColor('#ffffff').fontSize(8.8).text(text, x + 8, tableTop + 7, { width: width - 12, align });
  };
  tableHeader(40, 26, 'Nº');
  tableHeader(66, 134, 'Producto');
  tableHeader(200, 58, 'Tipo');
  tableHeader(258, 44, 'Talla');
  tableHeader(302, 74, 'Dorsal');
  tableHeader(376, 42, 'Cant.');
  tableHeader(418, 52, 'USD', 'right');
  tableHeader(470, 84, 'BS', 'right');

  let currentY = tableTop + 24;
  items.forEach((item, index) => {
    const label = item.product_title || `Producto #${item.product_id}`;
    const type = productTypeLabel(item.product_type || item.type, label);
    const lineTotal = Number(item.unit_price || 0) * Number(item.quantity || 1);
    const lineBs = lineTotal * exchangeRate;
    const rowColor = index % 2 === 0 ? rowEven : rowOdd;
    doc.roundedRect(40, currentY, 514, 24, 5).fill(rowColor).strokeColor(borderColor).stroke();
    const dorsal = item.custom_name ? 'Personalizada' : item.no_dorsal ? 'Sin dorsal' : item.dorsal_number ? `#${item.dorsal_number}` : 'N/D';

    doc.fillColor(textStrong).fontSize(8.2).text(String(index + 1), 46, currentY + 7, { width: 14, align: 'center' });
    doc.fillColor(textStrong).fontSize(7.2).text(label, 72, currentY + 7, { width: 118, align: 'left' });
    doc.fillColor(textSoft).fontSize(7.2).text(type, 206, currentY + 7, { width: 42, align: 'left' });
    doc.fillColor(textStrong).fontSize(7.5).text(item.size || 'N/D', 264, currentY + 7, { width: 30, align: 'center' });
    doc.fillColor(textStrong).fontSize(7.2).text(dorsal, 308, currentY + 7, { width: 62, align: 'center' });
    doc.fillColor(textStrong).fontSize(7.6).text(String(item.quantity || 1), 382, currentY + 7, { width: 24, align: 'center' });
    doc.fillColor(textStrong).fontSize(7.8).text(`${lineTotal.toFixed(2)}`, 420, currentY + 7, { width: 46, align: 'right' });
    doc.fillColor(textStrong).fontSize(7.8).text(`${lineBs.toFixed(2)}`, 474, currentY + 7, { width: 68, align: 'right' });

    currentY += 24;
    if (item.dorsal_name || item.custom_name || item.no_dorsal) {
      const customization = item.no_dorsal
        ? 'Sin dorsal'
        : item.custom_name
          ? `Personalizada: ${item.custom_name}${item.custom_number ? ` · #${item.custom_number}` : ''}`
          : `Dorsal: ${item.dorsal_number || 'N/D'}${item.dorsal_name ? ` · ${item.dorsal_name}` : ''}`;
      doc.roundedRect(72, currentY, 482, 18, 4).fill('#ffffff').strokeColor(borderColor).stroke();
      doc.fillColor(textSoft).fontSize(7.2).text(customization, 78, currentY + 4, { width: 468 });
      currentY += 18;
    }
  });

  const totalsY = currentY + 12;
  doc.roundedRect(338, totalsY, 216, 66, 12).fill('#eaf3ff').strokeColor(borderColor).stroke();
  if (isInstallmentOrder) {
    const initialPaymentBs = firstPaymentCurrency === 'BS' ? firstPaymentAmount : firstPaymentUsd * exchangeRate;
    const initialPaymentLabel = `USD ${firstPaymentUsd.toFixed(2)} · BS ${initialPaymentBs.toFixed(2)}`;
    doc.roundedRect(350, totalsY + 7, 3, 9, 1).fill(accentMid);
    doc.fillColor(accentBlue).fontSize(7.5).text(`TOTAL: USD ${totalUsd.toFixed(2)} · BS ${totalBs.toFixed(2)}`, 358, totalsY + 7, { width: 184 });
    doc.roundedRect(350, totalsY + 20, 3, 9, 1).fill('#16a34a');
    doc.fillColor('#166534').fontSize(7.5).text(`ABONO INICIAL: ${initialPaymentLabel}`, 358, totalsY + 20, { width: 184 });
    doc.roundedRect(350, totalsY + 33, 3, 9, 1).fill('#d97706');
    doc.fillColor('#92400e').fontSize(7.5).text(`PENDIENTE: USD ${remainingUsd.toFixed(2)} · BS ${remainingBs.toFixed(2)}`, 358, totalsY + 33, { width: 184 });
    doc.fillColor(paymentComplete ? '#126653' : '#9a5b08').fontSize(7.5).text(paymentComplete ? 'PAGO COMPLETADO · 2 COMPROBANTES' : 'PAGO PARCIAL', 350, totalsY + 48, { width: 192 });
  } else {
    doc.fillColor(accentBlue).fontSize(8.7).text('TOTAL USD', 356, totalsY + 12, { width: 90 });
    doc.fillColor(accentBlue).fontSize(8.7).text('TOTAL BS', 356, totalsY + 36, { width: 90 });
    doc.fillColor(accentBlue).fontSize(17).text(`${totalUsd.toFixed(2)}`, 442, totalsY + 8, { width: 98, align: 'right' });
    doc.fillColor(accentBlue).fontSize(17).text(`${totalBs.toFixed(2)}`, 442, totalsY + 32, { width: 98, align: 'right' });
  }

  const footerY = doc.page.height - 116;
  doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor('#dbe5f1').stroke();
  if (logoImage) {
    doc.rect(40, footerY + 8, 72, 60).fill('#ffffff');
    doc.image(logoImage, 44, footerY + 12, { fit: [64, 48], align: 'center', valign: 'center' });
  }
  doc.fillColor(textSoft).fontSize(8.5).text('MDJ SOCCER · San Cristóbal, Táchira, Venezuela', 120, footerY + 20);
  doc.fillColor(textSoft).fontSize(8.5).text('Teléfono: +58 0414-714-6602', 120, footerY + 34);
  drawInstagramIcon(doc, 345, footerY + 20);
  doc.fillColor('#2563eb').fontSize(8.5).text('@mdj_soccer', 366, footerY + 22);
  drawWhatsappIcon(doc, 440, footerY + 19);
  doc.fillColor('#16a34a').fontSize(8.5).text('+58 0414-714-6602', 462, footerY + 22);
  const invoiceNote = isInstallmentOrder
    ? 'Factura con abono y saldo calculados según la tasa registrada en el pedido.'
    : 'Gracias por tu compra. Este documento confirma la transacción realizada en MDJ SOCCER.';
  doc.fillColor('#6b7280').fontSize(8.8).text(invoiceNote, 40, footerY + 54, { width: 515, align: 'center' });

  doc.end();

  return await new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};

export const createApprovedOrdersPdf = async (orders, dateRange = null) => {
  const doc = new PDFDocument({ size: 'A4', margin: 36, bottomMargin: 70, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const logoPath = findLogoPath();
  const logoImage = logoPath ? fs.readFileSync(logoPath) : null;
  const normalizedOrders = orders.map((entry) => {
    const order = entry.order || entry;
    return { ...order, items: entry.items || order.items || [], client: entry.client || order.client };
  });
  const contentX = 36;
  const contentWidth = 523;
  const footerY = 755;
  let pageNumber = 1;

  const totalItems = normalizedOrders.reduce((total, order) => total + (order.items || []).length, 0);

  const drawPageFooter = () => {
    doc.moveTo(contentX, footerY - 12).lineTo(contentX + contentWidth, footerY - 12).strokeColor('#dbe5f1').stroke();
    if (logoImage) {
      doc.image(logoImage, contentX, footerY - 2, { fit: [52, 36], align: 'center', valign: 'center' });
    }
    doc.fontSize(8).fillColor('#64748b').text('MDJ SOCCER · San Cristóbal, Táchira, Venezuela', contentX + 62, footerY + 5);
    doc.text('Teléfono: +58 0414-714-6602  ·  @mdj_soccer - Tienda Online', contentX + 62, footerY + 19);
    doc.text(`Pedidos aceptados · Página ${pageNumber}`, contentX, footerY + 19, { width: contentWidth, align: 'right' });
  };

  const drawPageHeader = () => {
    const headerY = 36;
    doc.y = headerY;
    doc.roundedRect(contentX, headerY, contentWidth, 52, 10).fill('#0f2d52');
    doc.fillColor('#ffffff').fontSize(17).text('PEDIDOS ACEPTADOS', contentX + 18, headerY + 11);
    const rangeLabel = dateRange ? ` · ${dateRange.from} al ${dateRange.to}` : '';
    doc.fillColor('#cfe4ff').fontSize(8).text(`Control de camisetas para preparación${rangeLabel}`, contentX + 18, headerY + 32, { width: 250 });
    doc.fillColor('#dbeafe').fontSize(8).text(`${normalizedOrders.length} pedido(s) · ${totalItems} camiseta(s) · ${new Date().toLocaleDateString('es-VE')}`, contentX + 285, headerY + 32, { width: 220, align: 'right' });
    doc.y = headerY + 52;
  };

  const ensureSpace = (height) => {
    if (doc.y + height <= footerY - 18) return;
    drawPageFooter();
    doc.addPage();
    pageNumber += 1;
    drawPageHeader();
  };

  const drawLabelValue = (label, value, x, y, width) => {
    doc.fillColor('#64748b').fontSize(7.5).text(label.toUpperCase(), x, y, { width });
    doc.fillColor('#172033').fontSize(10).text(String(value || 'N/D'), x, y + 11, { width });
  };

  const drawItem = (item, index) => {
    const personalization = item.custom_name
      ? `Sí · ${item.custom_name}`
      : 'No';
    const dorsal = item.no_dorsal
      ? 'Sin dorsal'
      : item.custom_name
        ? `#${item.custom_number || 'N/D'}`
        : item.dorsal_number
          ? `#${item.dorsal_number}${item.dorsal_name ? ` · ${item.dorsal_name}` : ''}`
          : 'N/D';
    const title = item.product_title || `Producto #${item.product_id}`;
    const displayTitle = title;
    const personalizationHeight = doc.heightOfString(personalization, { width: 118, fontSize: 9 });
    const cardHeight = Math.max(96, doc.heightOfString(displayTitle, { width: 220, fontSize: 11 }) + personalizationHeight + 58);
    ensureSpace(cardHeight);
    const cardY = doc.y;
    const background = index % 2 === 0 ? '#f8fbff' : '#f1f6fc';
    doc.roundedRect(contentX, cardY, contentWidth, cardHeight, 8).fill(background).strokeColor('#dbe5f1').stroke();
    doc.roundedRect(contentX, cardY, 7, cardHeight, 3).fill('#2563eb');
    drawLabelValue('Camiseta', displayTitle, contentX + 22, cardY + 14, 220);
    drawLabelValue('Tipo', productTypeLabel(item.product_type || item.type, title), contentX + 250, cardY + 14, 90);
    drawLabelValue('Equipo', item.club_name || 'Sin equipo', contentX + 365, cardY + 14, 132);
    drawLabelValue('Talla', item.size || 'N/D', contentX + 22, cardY + 52, 72);
    drawLabelValue('Dorsal', dorsal, contentX + 105, cardY + 52, 130);
    drawLabelValue('Cantidad', `${item.quantity || 1} unidad (es)`, contentX + 248, cardY + 52, 112);
    drawLabelValue('Personalizada', personalization, contentX + 372, cardY + 52, 125);
    doc.y = cardY + cardHeight + 8;
  };

  drawPageHeader();
  normalizedOrders.forEach((order) => {
    const orderHeaderHeight = 58;
    ensureSpace(orderHeaderHeight + 8);
    const orderY = doc.y;
    doc.roundedRect(contentX, orderY, contentWidth, orderHeaderHeight, 8).fill('#e8f1ff');
    doc.fillColor('#1e3a8a').fontSize(12).text(order.client?.name || 'Cliente', contentX + 16, orderY + 12);
    doc.fillColor('#64748b').fontSize(8.5).text(order.client?.email || 'Sin correo registrado', contentX + 16, orderY + 32);
    doc.fillColor('#0f2d52').fontSize(11).text(`PEDIDO #${order.id}`, contentX + 385, orderY + 15, { width: 122, align: 'right' });
    const orderDate = order.created_at ? new Date(order.created_at) : null;
    const formattedDate = orderDate && !Number.isNaN(orderDate.getTime()) ? orderDate.toLocaleDateString('es-VE') : 'Fecha no disponible';
    doc.fillColor('#64748b').fontSize(8).text(formattedDate, contentX + 385, orderY + 34, { width: 122, align: 'right' });
    doc.y = orderY + orderHeaderHeight + 8;
    (order.items || []).forEach(drawItem);
    doc.moveDown(0.25);
  });

  if (!normalizedOrders.length) {
    ensureSpace(70);
    doc.roundedRect(contentX, doc.y, contentWidth, 70, 8).fill('#f8fbff').strokeColor('#dbe5f1').stroke();
    doc.fillColor('#475569').fontSize(11).text('No hay pedidos aceptados para imprimir.', contentX + 20, doc.y + 27, { width: contentWidth - 40, align: 'center' });
    doc.y += 78;
  }

  drawPageFooter();
  doc.end();
  return await new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};

const loadStoredImage = async (imageUrl) => {
  if (!imageUrl) return null;
  try {
    if (/^https:\/\//i.test(imageUrl)) {
      const url = new URL(imageUrl);
      if (!['res.cloudinary.com', 'images.unsplash.com'].includes(url.hostname)) {
        throw new Error('La foto remota no pertenece a un almacenamiento permitido.');
      }
      if (url.hostname === 'res.cloudinary.com') {
        url.pathname = url.pathname.replace('/image/upload/', '/image/upload/f_png/');
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
        throw new Error(`No se pudo descargar la foto del modelo (HTTP ${response.status}).`);
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > 8 * 1024 * 1024) throw new Error('La foto del modelo supera el tamaño permitido para el PDF.');
      const image = Buffer.from(await response.arrayBuffer());
      if (image.length > 8 * 1024 * 1024) throw new Error('La foto del modelo supera el tamaño permitido para el PDF.');
      return image;
    }

    if (!/^\/?uploads\//.test(imageUrl)) throw new Error('La ruta de la foto local no es válida.');
    const relativePath = imageUrl.replace(/^\/?uploads\//, '');
    const imagePath = path.resolve(uploadDir, relativePath);
    const relativeToUploads = path.relative(uploadDir, imagePath);
    if (relativeToUploads.startsWith('..') || path.isAbsolute(relativeToUploads)) {
      throw new Error('La ruta de la foto local está fuera del directorio de imágenes.');
    }
    return fs.existsSync(imagePath) ? fs.readFileSync(imagePath) : null;
  } catch (error) {
    console.warn(`No se pudo incluir la foto en el PDF: ${error.message}`);
    return null;
  }
};

export const createInventoryPdf = async (products) => {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const logoPath = findLogoPath();
  const logoImage = logoPath ? fs.readFileSync(logoPath) : null;
  const photos = await Promise.all(products.map((product) =>
    loadStoredImage(product.image_urls?.[0] || product.image_url)
  ));
  const contentX = 36;
  const contentWidth = 523;
  const footerY = 755;
  let pageNumber = 1;
  let totalUnits = 0;

  const drawPageHeader = () => {
    doc.y = 36;
    doc.roundedRect(contentX, 36, contentWidth, 66, 10).fill('#0f2d52');
    doc.fillColor('#ffffff').fontSize(17).text('INVENTARIO DE CAMISETAS', contentX + 18, 49);
    doc.fillColor('#cfe4ff').fontSize(9).text(
      `Stock registrado · ${new Date().toLocaleDateString('es-VE')}`,
      contentX + 18, 76
    );
    doc.fillColor('#dbeafe').fontSize(8).text(
      `${products.length} modelo(s)`,
      contentX + 390, 77, { width: 115, align: 'right' }
    );
    doc.y = 114;
  };

  const drawPageFooter = () => {
    doc.moveTo(contentX, footerY - 12).lineTo(contentX + contentWidth, footerY - 12).strokeColor('#dbe5f1').stroke();
    if (logoImage) doc.image(logoImage, contentX, footerY - 2, { fit: [52, 36], align: 'center', valign: 'center' });
    doc.fontSize(8).fillColor('#64748b').text('MDJ SOCCER · Control interno de inventario', contentX + 62, footerY + 5);
    doc.text(`Página ${pageNumber}`, contentX, footerY + 19, { width: contentWidth, align: 'right' });
  };

  const ensureSpace = (height) => {
    if (doc.y + height <= footerY - 18) return;
    drawPageFooter();
    doc.addPage();
    pageNumber += 1;
    drawPageHeader();
  };

  drawPageHeader();
  products.forEach((product, index) => {
    const sizeEntries = Object.entries(product.stock_by_size || {})
      .filter(([, quantity]) => Number(quantity) > 0);
    const stockTotal = sizeEntries.length
      ? sizeEntries.reduce((sum, [, quantity]) => sum + Number(quantity), 0)
      : Math.max(0, Number(product.stock) || 0);
    totalUnits += stockTotal;
    const sizeSummary = sizeEntries.length
      ? sizeEntries.map(([size, quantity]) => `${size}: ${Number(quantity)}`).join('  ·  ')
      : 'Sin desglose por talla';
    const cardHeight = 94;
    ensureSpace(cardHeight + 8);
    const cardY = doc.y;
    doc.roundedRect(contentX, cardY, contentWidth, cardHeight, 8)
      .fill(index % 2 === 0 ? '#f8fbff' : '#f1f6fc')
      .strokeColor('#dbe5f1').stroke();
    doc.roundedRect(contentX, cardY, 7, cardHeight, 3).fill('#2563eb');
    const imageX = contentX + 16;
    const imageY = cardY + 14;
    if (photos[index]) {
      doc.image(photos[index], imageX, imageY, { fit: [66, 66], align: 'center', valign: 'center' });
    } else {
      doc.roundedRect(imageX, imageY, 66, 66, 5).fill('#e2e8f0');
      doc.fillColor('#64748b').fontSize(7.5).text('Sin foto', imageX, imageY + 29, { width: 66, align: 'center' });
    }
    const textX = contentX + 96;
    const textWidth = contentWidth - 116;
    doc.fillColor('#0f2d52').fontSize(11).text(String(product.title || 'Camiseta sin nombre'), textX, cardY + 13, { width: textWidth, height: 19, ellipsis: true });
    doc.fillColor('#475569').fontSize(8.5).text(
      `${productTypeLabel(product.type, product.title)}${product.club?.name ? ` · ${product.club.name}` : ''}`,
      textX, cardY + 37, { width: textWidth }
    );
    doc.fillColor('#172033').fontSize(8.5).text(`Tallas: ${sizeSummary}`, textX, cardY + 55, { width: textWidth, height: 14, ellipsis: true });
    doc.fillColor('#0f766e').fontSize(9.5).text(
      `Disponibles: ${stockTotal}`,
      textX, cardY + 74, { width: textWidth }
    );
    doc.y = cardY + cardHeight + 8;
  });

  ensureSpace(58);
  doc.roundedRect(contentX, doc.y, contentWidth, 50, 8).fill('#ecfdf5').strokeColor('#86efac').stroke();
  doc.fillColor('#166534').fontSize(10).text('TOTAL DE CAMISETAS DISPONIBLES', contentX + 16, doc.y + 10);
  doc.fillColor('#14532d').fontSize(17).text(`${totalUnits} unidades`, contentX + 16, doc.y + 25);
  doc.y += 60;
  drawPageFooter();
  doc.end();
  return await new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};

export const createStockRequestsPdf = async (requests, dateRange = {}) => {
  const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const logoPath = findLogoPath();
  const logoImage = logoPath ? fs.readFileSync(logoPath) : null;
  const photos = await Promise.all(requests.map((request) => loadStoredImage(request.image_url)));
  const contentX = 36;
  const contentWidth = 523;
  const footerY = 755;
  let pageNumber = 1;
  const drawPageHeader = () => {
    doc.y = 36;
    doc.roundedRect(contentX, 36, contentWidth, 62, 10).fill('#0f2d52');
    doc.fillColor('#ffffff').fontSize(16).text('PEDIDOS POR ENCARGO', contentX + 18, 48);
    doc.fillColor('#cfe4ff').fontSize(8.5).text(
      dateRange.from || dateRange.to
        ? `Solicitudes registradas${dateRange.from ? ` desde ${dateRange.from}` : ''}${dateRange.to ? ` hasta ${dateRange.to}` : ''}`
        : 'Todas las solicitudes registradas',
      contentX + 18, 73, { width: 300 }
    );
    doc.fillColor('#dbeafe').fontSize(8).text(
      `${requests.length} solicitud(es) · ${new Date().toLocaleDateString('es-VE')}`,
      contentX + 330, 74, { width: 175, align: 'right' }
    );
    doc.y = 110;
  };

  const drawPageFooter = () => {
    doc.moveTo(contentX, footerY - 12).lineTo(contentX + contentWidth, footerY - 12).strokeColor('#dbe5f1').stroke();
    if (logoImage) doc.image(logoImage, contentX, footerY - 2, { fit: [52, 36], align: 'center', valign: 'center' });
    doc.fontSize(8).fillColor('#64748b').text('MDJ SOCCER · San Cristóbal, Táchira, Venezuela', contentX + 62, footerY + 5);
    doc.text('Control interno de mercancía por encargo · Abonos registrados aparte', contentX + 62, footerY + 19);
    doc.text(`Página ${pageNumber}`, contentX, footerY + 19, { width: contentWidth, align: 'right' });
  };

  const ensureSpace = (height) => {
    if (doc.y + height <= footerY - 18) return;
    drawPageFooter();
    doc.addPage();
    pageNumber += 1;
    drawPageHeader();
  };

  const typeLabels = { local: 'Local', visitante: 'Visitante', alternativa: 'Alternativa' };
  drawPageHeader();
  requests.forEach((request, index) => {
    const notes = String(request.notes || '');
    const notesHeight = notes ? Math.min(30, doc.heightOfString(notes, { width: 390, fontSize: 8 })) : 0;
    const cardHeight = 112 + notesHeight;
    ensureSpace(cardHeight + 8);
    const cardY = doc.y;
    doc.roundedRect(contentX, cardY, contentWidth, cardHeight, 8)
      .fill(index % 2 === 0 ? '#f8fbff' : '#f1f6fc')
      .strokeColor('#dbe5f1').stroke();
    doc.roundedRect(contentX, cardY, 7, cardHeight, 3).fill('#2563eb');
    const imageX = contentX + 16;
    const imageY = cardY + 14;
    const photo = photos[index];
    if (photo) {
      doc.image(photo, imageX, imageY, { fit: [82, 82], align: 'center', valign: 'center' });
    } else {
      doc.roundedRect(imageX, imageY, 82, 82, 5).fill('#e2e8f0');
      doc.fillColor('#64748b').fontSize(8).text('Sin foto', imageX, imageY + 35, { width: 82, align: 'center' });
    }
    const textX = contentX + 112;
    const rightX = contentX + 404;
    doc.fillColor('#0f2d52').fontSize(11).text(request.client_name, textX, cardY + 13, { width: 220 });
    doc.fillColor('#64748b').fontSize(8.5).text(
      `${request.phone}${request.email ? ` · ${request.email}` : ''}`,
      textX, cardY + 30, { width: 270 }
    );
    doc.fillColor('#172033').fontSize(9).text(`Modelo: ${request.model}`, textX, cardY + 48, { width: 270 });
    const sizeSummary = Object.entries(request.size_quantities || { [request.size]: 1 })
      .map(([size, quantity]) => `${size}: ${quantity}`)
      .join(' · ');
    const printSummary = (request.printed_details || []).map((detail) =>
      `${detail.quantity} ${detail.size} · ${detail.printed_name} #${detail.dorsal}`
    ).join('; ');
    doc.fillColor('#475569').fontSize(8.5).text(
      `${typeLabels[request.shirt_type] || request.shirt_type} · ${sizeSummary} · ${printSummary || 'Sin estampar'}`,
      textX, cardY + 65, { width: 270, height: 30, ellipsis: true }
    );
    doc.fillColor('#0f766e').fontSize(9).text(
      `Abono: ${request.deposit_currency === 'BS' ? 'BS ' : '$'}${Number(request.deposit_amount || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      rightX, cardY + 13, { width: 107, align: 'right' }
    );
    const createdAt = request.created_at ? new Date(request.created_at) : null;
    doc.fillColor('#64748b').fontSize(8).text(
      createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleDateString('es-VE') : 'Fecha no disponible',
      rightX, cardY + 30, { width: 107, align: 'right' }
    );
    if (notes) {
      doc.fillColor('#64748b').fontSize(8).text(`Nota: ${notes}`, textX, cardY + 98, { width: 390, height: 30, ellipsis: true });
    }
    doc.y = cardY + cardHeight + 8;
  });

  if (!requests.length) {
    doc.roundedRect(contentX, doc.y, contentWidth, 60, 8).fill('#f8fbff').strokeColor('#dbe5f1').stroke();
    doc.fillColor('#475569').fontSize(11).text('No hay solicitudes registradas para este período.', contentX + 20, doc.y + 23, { width: contentWidth - 40, align: 'center' });
    doc.y += 68;
  }
  drawPageFooter();
  doc.end();
  return await new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};
