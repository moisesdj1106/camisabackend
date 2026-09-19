import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  whatsapp: 'WhatsApp',
  pago_movil: 'Pago Móvil',
  efectivo: 'Efectivo'
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
  doc.fontSize(size * 0.52).fillColor('#16a34a').text('W', x + size * 0.32, y + size * 0.25, { width: size * 0.4, align: 'center' });
  doc.restore();
};

const drawInvoiceFooter = (doc, logoPath) => {
  const footerY = doc.page.height - 120;
  doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor('#dbe5f1').stroke();
  if (logoPath) {
    doc.rect(40, footerY + 4, 76, 60).fill('#ffffff');
    doc.image(logoPath, 44, footerY + 7, { fit: [68, 54], align: 'center', valign: 'center' });
  }
  doc.fontSize(8.5).fillColor('#475569').text('MDJ SOCCER · San Cristóbal, Táchira, Venezuela', 115, footerY + 12);
  doc.fontSize(8.5).fillColor('#475569').text('Teléfono: +58 0414-714-6602', 115, footerY + 27);

  drawInstagramIcon(doc, 325, footerY + 11);
  doc.fontSize(8.5).fillColor('#2563eb').text('@mdj_soccer', 344, footerY + 14);
  drawWhatsappIcon(doc, 421, footerY + 10);
  doc.fontSize(8.5).fillColor('#16a34a').text('+58 0414-714-6602', 445, footerY + 14);
};

export const createInvoicePdf = async (order, items, client, options = {}) => {
  const exchangeRate = Number(options.exchangeRate || 36);
  const doc = new PDFDocument({ size: 'A4', margin: 40, bottomMargin: 90 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const totalUsd = Number(order.total_amount || 0);
  const totalBs = totalUsd * exchangeRate;
  const invoiceNumber = order.invoice_number || `INV-${String(order.id).padStart(4, '0')}`;

  const logoPath = findLogoPath();
  const logoImage = logoPath ? fs.readFileSync(logoPath) : null;
  doc.roundedRect(40, 40, 480, 92, 12).fill('#0f2d52');
  doc.fillColor('#ffffff').fontSize(23).text('MDJ SOCCER', 60, 58);
  doc.fontSize(9).fillColor('#cfe4ff').text('Camisetas deportivas Triple A', 60, 88);
  doc.fontSize(10).fillColor('#ffffff').text(`FACTURA Nº ${invoiceNumber}`, 270, 62, { width: 145, align: 'right' });
  doc.fontSize(10).fillColor('#cfe4ff').text(`Pedido #${order.id}`, 270, 82, { width: 145, align: 'right' });
  doc.y = 150;

  const headerY = doc.y;
  drawCell(doc, 40, headerY, 240, 30, 'DATOS DEL CLIENTE', { fontSize: 10, color: '#ffffff' });
  doc.rect(40, headerY, 240, 30).fill('#2563eb');
  doc.fillColor('#ffffff').fontSize(10).text('DATOS DEL CLIENTE', 48, headerY + 8);
  doc.rect(280, headerY, 240, 30).fill('#2563eb');
  doc.fillColor('#ffffff').fontSize(10).text('DATOS DE LA EMPRESA', 288, headerY + 8);

  drawCell(doc, 40, headerY + 30, 240, 42, `${client?.name || 'Cliente'}\n${client?.email || ''}`, { fontSize: 10 });
  drawCell(doc, 280, headerY + 30, 240, 42, 'MDJ SOCCER\nmdjsoccer@gmail.com\n+58 0414-714-6602', { fontSize: 10 });

  drawCell(doc, 40, headerY + 72, 240, 30, `Método de pago: ${paymentMethodLabels[order.payment_method] || order.payment_method || 'No indicado'}`, { fontSize: 9 });
  drawCell(doc, 280, headerY + 72, 240, 30, `Tasa de cambio: ${exchangeRate.toFixed(2)} BS/USD`, { fontSize: 9 });
  doc.roundedRect(40, headerY + 102, 480, 26, 5).fill('#e8f1ff');
  doc.fillColor('#1e3a8a').fontSize(10).text(`Estado del pedido: ${orderStatusLabels[order.status] || order.status || 'No indicado'}`, 48, headerY + 110);

  doc.moveDown(2.2);
  doc.fontSize(13).fillColor('#0f2d52').text('Detalle de compra');
  const tableTop = doc.y + 5;
  const tableHeader = (x, width, text, align = 'left') => {
    doc.rect(x, tableTop, width, 24).fill('#0f2d52');
    doc.fillColor('#ffffff').fontSize(9).text(text, x + 8, tableTop + 7, { width: width - 12, align });
  };
  tableHeader(40, 40, 'Nº');
  tableHeader(80, 220, 'Producto');
  tableHeader(300, 60, 'Cant.', 'center');
  tableHeader(360, 80, 'USD', 'right');
  tableHeader(440, 80, 'BS', 'right');

  let currentY = tableTop + 24;
  items.forEach((item, index) => {
    const label = item.product_title || `Producto #${item.product_id}`;
    const lineTotal = Number(item.unit_price || 0) * Number(item.quantity || 1);
    const lineBs = lineTotal * exchangeRate;
    const rowColor = index % 2 === 0 ? '#f8fbff' : '#eef5ff';
    doc.rect(40, currentY, 480, 24).fill(rowColor);
    drawCell(doc, 40, currentY, 40, 24, String(index + 1), { fontSize: 9 });
    drawCell(doc, 80, currentY, 220, 24, `${label} · Talla ${item.size || 'N/D'}`, { fontSize: 8 });
    drawCell(doc, 300, currentY, 60, 24, String(item.quantity || 1), { fontSize: 10 });
    drawCell(doc, 360, currentY, 80, 24, `${lineTotal.toFixed(2)}`, { fontSize: 10, align: 'right' });
    drawCell(doc, 440, currentY, 80, 24, `${lineBs.toFixed(2)}`, { fontSize: 10, align: 'right' });
    currentY += 24;
    if (item.dorsal_name || item.custom_name || item.no_dorsal) {
      const customization = item.no_dorsal
        ? 'Sin dorsal'
        : item.custom_name ? `Personalizada: ${item.custom_name} Dorsal # ${item.custom_number || ''}` : `Dorsal: ${item.dorsal_number} - ${item.dorsal_name}`;
      drawCell(doc, 80, currentY, 440, 20, customization, { fontSize: 8, color: '#475569' });
      currentY += 20;
    }
  });

  const totalsY = currentY + 10;
  doc.roundedRect(320, totalsY, 200, 48, 6).fill('#e8f1ff');
  doc.fillColor('#1e3a8a').fontSize(10).text('TOTAL USD', 330, totalsY + 7);
  doc.fillColor('#0f2d52').fontSize(12).text(`${totalUsd.toFixed(2)}`, 440, totalsY + 6, { width: 70, align: 'right' });
  doc.fillColor('#1e3a8a').fontSize(10).text('TOTAL BS', 330, totalsY + 30);
  doc.fillColor('#0f2d52').fontSize(11).text(`${totalBs.toFixed(2)}`, 440, totalsY + 29, { width: 70, align: 'right' });

  doc.moveDown(2.2);
  doc.fontSize(9).fillColor('#6b7280').text('Gracias por tu compra. Este documento confirma la transacción realizada en MDJ SOCCER.', { align: 'center' });
  doc.text('www.mdjsoccer.com', { align: 'center' });
  const currentPage = doc.bufferedPageRange().count - 1;
  doc.switchToPage(currentPage);
  drawInvoiceFooter(doc, logoImage);

  doc.end();

  return await new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};
