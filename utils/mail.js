import nodemailer from 'nodemailer';

const getTransporter = () => {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpSecure = process.env.SMTP_SECURE === 'true' || (Number(process.env.SMTP_PORT || 587) === 465);

  if (!smtpHost || !smtpUser || !smtpPass) {
    return null;
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });
};

export const sendOrderApprovedEmail = async ({ to, userName, orderId }) => {
  if (!to) {
    return { success: false, reason: 'missing-recipient' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.warn('Correo no enviado: faltan variables SMTP. Define SMTP_HOST, SMTP_USER y SMTP_PASS.');
    return { success: false, reason: 'mail-not-configured' };
  }

  try {
    await transporter.verify();
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@mdjsoccer.com',
      to,
      subject: 'Tu pedido ha sido aprobado en MDJ SOCCER',
      html: `
        <div style="font-family: Arial, sans-serif; color: #0f172a;">
          <h2 style="margin-bottom: 8px;">Pedido aprobado ✅</h2>
          <p>Hola ${userName || 'cliente'},</p>
          <p>Tu pedido <strong>#${orderId}</strong> ya fue aprobado por el administrador de MDJ SOCCER.</p>
          <p>Pronto recibirás más información sobre el proceso de entrega o confirmación.</p>
          <p style="margin-top: 16px;">Gracias por tu compra.</p>
        </div>
      `
    });
    return { success: true };
  } catch (error) {
    console.error('No se pudo enviar el correo de aprobación:', error.message);
    return { success: false, reason: error.message };
  }
};
