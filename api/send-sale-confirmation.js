import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const requiredEnvironment = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SALE_EMAIL_WEBHOOK_SECRET',
  'SMTP_PASSWORD',
];

const SMTP_HOST = process.env.SMTP_HOST || 'imap.zitomedia.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USERNAME = process.env.SMTP_USERNAME || 'zitod2dfiber@zitomedia.com';
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'zitod2dfiber@zitomedia.com';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Zito Media';
const SMTP_REPLY_TO = process.env.SMTP_REPLY_TO || 'zitod2dfiber@zitomedia.com';

function respond(response, status, body) {
  response.status(status).json(body);
}

function clean(value) {
  return String(value ?? '').trim();
}

function html(value) {
  return clean(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
}

function money(value) {
  if (value === null || value === undefined || value === '') return '';
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
    : clean(value);
}

function formatDate(value) {
  if (!value) return '';
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? clean(value)
    : parsed.toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
}

function first(...values) {
  return values.map(clean).find(Boolean) || '';
}

function addressLabel(address) {
  if (!address) return '';
  const street = first(address.address, address.full_address, address.service_address, address.street_address);
  const locality = [first(address.city), first(address.state), first(address.zip, address.zip_code)]
    .filter(Boolean)
    .join(', ')
    .replace(/, ([^,]+)$/, ' $1');
  return [street, locality].filter(Boolean).join(', ');
}

function buildEmail(sale, address) {
  const customerName = first(sale.customer_name, sale.name, 'Customer');
  const firstName = customerName.split(/\s+/)[0] || 'there';
  const packageName = first(sale.package_name, sale.package_key, 'Zito Internet service');
  const serviceAddress = first(addressLabel(address), sale.address, sale.service_address);
  const installation = [formatDate(sale.install_date), first(sale.install_time)].filter(Boolean).join(' at ');
  const monthlyTotal = money(sale.monthly_total);
  const promo = first(sale.promo_price, sale.offer_promo);
  const promoTerm = first(sale.promo_term);
  const repName = first(sale.rep_name, 'your Zito Media representative');

  const rows = [
    ['Service address', serviceAddress],
    ['Package', packageName],
    ['Promotional price', promo],
    ['Promotional term', promoTerm],
    ['Estimated monthly total', monthlyTotal],
    ['Installation appointment', installation],
    ['Sales representative', repName],
  ].filter(([, value]) => value);

  const detailRows = rows
    .map(([label, value]) => `<tr><td style="padding:8px 14px 8px 0;color:#64748b;vertical-align:top;">${html(label)}</td><td style="padding:8px 0;color:#0f172a;font-weight:600;">${html(value)}</td></tr>`)
    .join('');

  const textDetails = rows.map(([label, value]) => `${label}: ${value}`).join('\n');

  return {
    subject: `Your Zito Media order confirmation – ${packageName}`,
    text: `Hi ${firstName},\n\nThank you for choosing Zito Media. Your order has been submitted successfully.\n\n${textDetails}\n\nOur team will contact you if any additional information is needed. If you have questions, reply to this email.\n\nThank you,\nZito Media`,
    html: `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a;"><div style="max-width:640px;margin:0 auto;padding:28px 16px;"><div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;"><div style="background:#0b3261;padding:24px 28px;color:#ffffff;"><div style="font-size:24px;font-weight:700;">Zito Media</div><div style="margin-top:5px;color:#dbeafe;">Order confirmation</div></div><div style="padding:28px;"><p style="margin-top:0;font-size:17px;">Hi ${html(firstName)},</p><p style="line-height:1.6;">Thank you for choosing Zito Media. Your order has been submitted successfully.</p><table style="width:100%;border-collapse:collapse;margin:20px 0;">${detailRows}</table><p style="line-height:1.6;">Our team will contact you if any additional information is needed. If you have questions, simply reply to this email.</p><p style="margin-bottom:0;line-height:1.6;">Thank you,<br><strong>Zito Media</strong></p></div></div><div style="padding:14px;text-align:center;color:#64748b;font-size:12px;">This is a transactional confirmation for a service order submitted to Zito Media.</div></div></body></html>`,
  };
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return respond(response, 405, { error: 'Method not allowed' });
  }

  const missing = requiredEnvironment.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    return respond(response, 500, { error: 'Email service is not configured' });
  }

  const suppliedSecret = clean(request.headers['x-fieldos-webhook-secret']);
  if (!suppliedSecret || suppliedSecret !== process.env.SALE_EMAIL_WEBHOOK_SECRET) {
    return respond(response, 401, { error: 'Unauthorized' });
  }

  const event = request.body || {};
  const sale = event.record || event.new || {};
  if (clean(event.type).toUpperCase() !== 'INSERT' || clean(event.table) !== 'sales_orders' || !sale.id) {
    return respond(response, 400, { error: 'Expected an INSERT webhook for sales_orders' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const recipient = clean(sale.email || sale.customer_email).toLowerCase();
  if (!looksLikeEmail(recipient)) {
    await supabase
      .from('sales_orders')
      .update({
        customer_confirmation_status: 'skipped',
        customer_confirmation_error: recipient ? 'Customer email is invalid' : 'Customer email is blank',
      })
      .eq('id', sale.id)
      .eq('customer_confirmation_status', 'pending');
    return respond(response, 200, { status: 'skipped' });
  }

  // Reserve the row before contacting SMTP. A duplicate webhook cannot reserve it twice.
  const { data: reserved, error: reserveError } = await supabase
    .from('sales_orders')
    .update({
      customer_confirmation_status: 'sending',
      customer_confirmation_error: null,
    })
    .eq('id', sale.id)
    .eq('customer_confirmation_status', 'pending')
    .select('id')
    .maybeSingle();

  if (reserveError) {
    console.error('Could not reserve sale confirmation:', reserveError);
    return respond(response, 500, { error: 'Could not reserve confirmation' });
  }
  if (!reserved) {
    return respond(response, 200, { status: 'already_processed' });
  }

  let address = null;
  if (sale.address_id) {
    const addressResult = await supabase.from('addresses').select('*').eq('id', sale.address_id).maybeSingle();
    if (!addressResult.error) address = addressResult.data;
  }

  const message = buildEmail(sale, address);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    requireTLS: true,
    auth: {
      user: SMTP_USERNAME,
      pass: process.env.SMTP_PASSWORD,
    },
    tls: {
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });

  try {
    const result = await transporter.sendMail({
      from: { name: SMTP_FROM_NAME, address: SMTP_FROM_EMAIL },
      replyTo: SMTP_REPLY_TO,
      to: recipient,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: {
        'X-FieldOS-Sale-ID': clean(sale.id),
        'Auto-Submitted': 'auto-generated',
      },
    });

    const { error: updateError } = await supabase
      .from('sales_orders')
      .update({
        customer_confirmation_status: 'sent',
        customer_confirmation_sent_at: new Date().toISOString(),
        customer_confirmation_message_id: clean(result.messageId),
        customer_confirmation_error: null,
      })
      .eq('id', sale.id)
      .eq('customer_confirmation_status', 'sending');

    if (updateError) console.error('Email sent, but status update failed:', updateError);
    return respond(response, 200, { status: 'sent', message_id: clean(result.messageId) });
  } catch (error) {
    const safeError = clean(error?.message || 'SMTP delivery failed').slice(0, 1000);
    console.error('SMTP delivery failed:', safeError);
    await supabase
      .from('sales_orders')
      .update({
        customer_confirmation_status: 'failed',
        customer_confirmation_error: safeError,
      })
      .eq('id', sale.id)
      .eq('customer_confirmation_status', 'sending');
    return respond(response, 502, { error: 'SMTP delivery failed' });
  }
}
