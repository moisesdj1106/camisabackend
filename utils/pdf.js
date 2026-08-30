import PDFDocument from 'pdfkit';

const drawCell = (doc, x, y, width, height, text, options = {}) => {
  doc.rect(x, y, width, height).stroke();
  doc.fontSize(options.fontSize || 10);
  doc.fillColor(options.color || '#111827');
  doc.text(text, x + 8, y + 6, {
    width: width - 12,
    align: options.align || 'left'
  });
};

export const createInvoicePdf = async (order, items, client, options = {}) => {
  const exchangeRate = Number(options.exchangeRate || 36);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const totalUsd = Number(order.total_amount || 0);
  const totalBs = totalUsd * exchangeRate;
  const invoiceNumber = order.invoice_number || `INV-${String(order.id).padStart(4, '0')}`;

  doc.fillColor('#111827');
  doc.fontSize(24).text('MDJ SOCCER', { align: 'left' });
  doc.fontSize(10).fillColor('#6b7280').text('Camisetas deportivas premium • Pagos seguros • Entregas rápidas', { align: 'left' });
  doc.moveDown(0.2);
  doc.fontSize(11).fillColor('#111827').text(`Factura Nº ${invoiceNumber}`);
  doc.text(`Pedido #${order.id}`);

  doc.moveTo(40, doc.y + 10).lineTo(520, doc.y + 10).strokeColor('#d1d5db').lineWidth(1).stroke();
  doc.moveDown(0.4);

  const headerY = doc.y;
  drawCell(doc, 40, headerY, 240, 30, 'Datos del cliente', { fontSize: 11, color: '#111827' });
  drawCell(doc, 280, headerY, 240, 30, 'Datos de la empresa', { fontSize: 11, color: '#111827' });

  drawCell(doc, 40, headerY + 30, 240, 42, `${client?.name || 'Cliente'}\n${client?.email || ''}`, { fontSize: 10 });
  drawCell(doc, 280, headerY + 30, 240, 42, 'MDJ SOCCER\ncontacto@mdjsoccer.com\n+58 0414-714-6602', { fontSize: 10 });

  drawCell(doc, 40, headerY + 72, 240, 30, `Método de pago: ${order.payment_method}`, { fontSize: 10 });
  drawCell(doc, 280, headerY + 72, 240, 30, `Tasa de cambio: ${exchangeRate.toFixed(2)} BS/USD`, { fontSize: 10 });
  drawCell(doc, 40, headerY + 102, 480, 26, `Estado del pedido: ${order.status}`, { fontSize: 10 });

  doc.moveDown(2.2);
  doc.fontSize(12).fillColor('#111827').text('Detalle de compra');
  const tableTop = doc.y + 5;
  drawCell(doc, 40, tableTop, 40, 24, 'Nº', { fontSize: 10, color: '#111827' });
  drawCell(doc, 80, tableTop, 220, 24, 'Producto', { fontSize: 10, color: '#111827' });
  drawCell(doc, 300, tableTop, 60, 24, 'Cant.', { fontSize: 10, color: '#111827' });
  drawCell(doc, 360, tableTop, 80, 24, 'USD', { fontSize: 10, color: '#111827' });
  drawCell(doc, 440, tableTop, 80, 24, 'BS', { fontSize: 10, color: '#111827' });

  let currentY = tableTop + 24;
  items.forEach((item, index) => {
    const label = item.product_title || `Producto #${item.product_id}`;
    const lineTotal = Number(item.unit_price || 0) * Number(item.quantity || 1);
    const lineBs = lineTotal * exchangeRate;
    drawCell(doc, 40, currentY, 40, 24, String(index + 1), { fontSize: 10 });
    drawCell(doc, 80, currentY, 220, 24, label, { fontSize: 9 });
    drawCell(doc, 300, currentY, 60, 24, String(item.quantity || 1), { fontSize: 10 });
    drawCell(doc, 360, currentY, 80, 24, `${lineTotal.toFixed(2)}`, { fontSize: 10, align: 'right' });
    drawCell(doc, 440, currentY, 80, 24, `${lineBs.toFixed(2)}`, { fontSize: 10, align: 'right' });
    currentY += 24;
    if (item.dorsal_name) {
      drawCell(doc, 80, currentY, 440, 20, `Dorsal: ${item.dorsal_number} - ${item.dorsal_name}`, { fontSize: 8 });
      currentY += 20;
    }
  });

  const totalsY = currentY + 10;
  drawCell(doc, 320, totalsY, 120, 24, 'Total USD', { fontSize: 10, color: '#111827' });
  drawCell(doc, 440, totalsY, 80, 24, `${totalUsd.toFixed(2)}`, { fontSize: 10, align: 'right' });
  drawCell(doc, 320, totalsY + 24, 120, 24, 'Total BS', { fontSize: 10, color: '#111827' });
  drawCell(doc, 440, totalsY + 24, 80, 24, `${totalBs.toFixed(2)}`, { fontSize: 10, align: 'right' });

  doc.moveDown(2.2);
  doc.fontSize(9).fillColor('#6b7280').text('Gracias por tu compra. Este documento confirma la transacción realizada en MDJ SOCCER.', { align: 'center' });
  doc.text('www.mdjsoccer.com', { align: 'center' });

  doc.end();

  return await new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};
