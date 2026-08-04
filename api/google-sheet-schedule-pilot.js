import { createClient } from '@supabase/supabase-js';

const PILOT_SPREADSHEET_ID = '16b2htgg29qEQ1eVcXjY9oPJ4JkK2xlgLR0LvuOCMYMA';
const PILOT_SHEET_ID = 1352848155;
const PILOT_SHEET_NAME = 'Pacific/ Mountain';
const PILOT_TERRITORY = 'battle_mountain_nv';
const MAX_APPOINTMENTS = 250;

const INACTIVE_BOOKING_STATUSES = new Set([
  'canceled',
  'cancelled',
  'void',
  'voided',
  'rejected',
  'deleted',
  'needs_rescheduled',
  'rescheduled',
]);

const INACTIVE_SALE_STATUSES = new Set([
  'canceled',
  'cancelled',
  'rejected',
  'void',
  'voided',
  'deleted',
  'needs_rescheduled',
  'rescheduled',
  'installed',
  'invoiced',
  'complete',
  'completed',
]);

function respond(response, status, body) {
  response.status(status).json(body);
}

export function clean(value) {
  return String(value ?? '').trim();
}

export function normalizeKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizePhone(value) {
  return clean(value).replace(/[^0-9]/g, '').slice(-10);
}

export function normalizeTime(value) {
  const raw = clean(value).toUpperCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  if (!raw) return '';

  const start = raw.split('-')[0].trim();
  const compact = start.replace(/\s+/g, '');
  const aliases = {
    '8': '8:00 AM',
    '8:00': '8:00 AM',
    '8AM': '8:00 AM',
    '8:00AM': '8:00 AM',
    '08:00': '8:00 AM',
    '10': '10:00 AM',
    '10:00': '10:00 AM',
    '10AM': '10:00 AM',
    '10:00AM': '10:00 AM',
    '1': '1:00 PM',
    '1:00': '1:00 PM',
    '1PM': '1:00 PM',
    '1:00PM': '1:00 PM',
    '13:00': '1:00 PM',
    '3': '3:00 PM',
    '3:00': '3:00 PM',
    '3PM': '3:00 PM',
    '3:00PM': '3:00 PM',
    '15:00': '3:00 PM',
  };
  return aliases[compact] || '';
}

export function isValidIsoDate(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

export function bookingIsActive(row) {
  return !INACTIVE_BOOKING_STATUSES.has(clean(row?.status || 'booked').toLowerCase().replace(/\s+/g, '_'));
}

export function saleIsActive(row) {
  const review = clean(row?.review_status || 'submitted').toLowerCase().replace(/\s+/g, '_');
  const outcome = clean(row?.install_outcome).toLowerCase().replace(/\s+/g, '_');
  if (INACTIVE_SALE_STATUSES.has(review) || INACTIVE_SALE_STATUSES.has(outcome)) return false;
  return !(row?.invoice_id || row?.invoice_batch_id || row?.invoiced_at);
}

function bookingMatchesSale(booking, sale) {
  if (booking.sales_order_id && booking.sales_order_id === sale.id) return true;
  if (booking.address_id && sale.address_id && booking.address_id === sale.address_id) return true;
  const bookingPhone = normalizePhone(booking.phone);
  const salePhone = normalizePhone(sale.phone);
  return Boolean(bookingPhone && salePhone && bookingPhone === salePhone);
}

function bookingMatchesAppointment(booking, addressId, accountNumber) {
  if (addressId && booking.address_id === addressId) return true;
  return Boolean(
    accountNumber &&
    clean(booking.external_account_number) &&
    clean(booking.external_account_number) === accountNumber
  );
}

function basePilotRow(appointment, runId) {
  return {
    source_key: clean(appointment.source_key),
    spreadsheet_id: PILOT_SPREADSHEET_ID,
    sheet_id: PILOT_SHEET_ID,
    sheet_name: PILOT_SHEET_NAME,
    source_cell: clean(appointment.source_cell),
    appointment_date: clean(appointment.appointment_date),
    time_range: clean(appointment.time_range),
    time_label: normalizeTime(appointment.time_label || appointment.time_range),
    territory: PILOT_TERRITORY,
    external_account_number: clean(appointment.external_account_number) || null,
    raw_value: clean(appointment.raw_value),
    parsed_address: clean(appointment.parsed_address) || null,
    audit_status: 'invalid',
    audit_reason: null,
    address_id: null,
    schedule_slot_id: null,
    existing_booking_id: null,
    slot_capacity: null,
    slot_booked_count: null,
    openings_before: null,
    is_present: true,
    last_seen_at: new Date().toISOString(),
    last_run_id: runId,
    source_payload: appointment,
  };
}

async function findAddress(supabase, accountNumber) {
  if (!accountNumber) return { status: 'address_not_found', address: null, reason: 'No account/location number was parsed.' };

  const { data, error } = await supabase
    .from('addresses')
    .select('id,external_location_id,territory,team,team_slug,address1,city,state,postal_code')
    .eq('external_location_id', accountNumber)
    .limit(5);

  if (error) throw error;
  const rows = data || [];
  if (!rows.length) {
    return { status: 'address_not_found', address: null, reason: `No FieldOS address matched ${accountNumber}.` };
  }

  const territoryMatches = rows.filter((row) => normalizeKey(row.territory) === PILOT_TERRITORY);
  if (territoryMatches.length === 1) return { status: 'matched', address: territoryMatches[0], reason: null };
  if (territoryMatches.length > 1) {
    return { status: 'address_ambiguous', address: null, reason: `${accountNumber} matched multiple Battle Mountain addresses.` };
  }
  if (rows.length === 1) {
    return {
      status: 'territory_mismatch',
      address: rows[0],
      reason: `${accountNumber} belongs to ${clean(rows[0].territory) || 'an unknown territory'}, not Battle Mountain.`,
    };
  }
  return { status: 'address_ambiguous', address: null, reason: `${accountNumber} matched multiple FieldOS addresses.` };
}

async function findSlot(supabase, appointmentDate, timeLabel) {
  const { data, error } = await supabase
    .from('schedule_slots')
    .select('id,territory,slot_date,time_label,capacity,booked_count,team,team_slug,is_active')
    .ilike('territory', PILOT_TERRITORY)
    .eq('slot_date', appointmentDate)
    .eq('is_active', true);

  if (error) throw error;
  const matches = (data || []).filter((row) => normalizeTime(row.time_label) === timeLabel);
  if (matches.length === 1) return matches[0];
  return null;
}

async function analyzeAppointment(supabase, appointment, runId) {
  const row = basePilotRow(appointment, runId);

  if (!row.source_key || row.source_key.length > 500) {
    row.audit_reason = 'The source key is missing or too long.';
    return row;
  }
  if (!row.source_cell || !row.raw_value) {
    row.audit_reason = 'The source cell or appointment value is blank.';
    return row;
  }
  if (!isValidIsoDate(row.appointment_date)) {
    row.audit_reason = 'The appointment date is invalid.';
    return row;
  }
  if (!row.time_label) {
    row.audit_reason = `Unsupported time range: ${row.time_range || '(blank)'}.`;
    return row;
  }
  if (appointment.duplicate_account_in_sheet === true) {
    row.audit_reason = `Account/location ${row.external_account_number || '(unknown)'} appears more than once in the current Sheet scan.`;
    return row;
  }

  const addressResult = await findAddress(supabase, row.external_account_number);
  if (addressResult.address) row.address_id = addressResult.address.id;

  const slot = await findSlot(supabase, row.appointment_date, row.time_label);
  if (!slot) {
    row.audit_status = 'slot_missing';
    row.audit_reason = `No active Battle Mountain ${row.time_label} slot exists for ${row.appointment_date}.`;
    return row;
  }

  row.schedule_slot_id = slot.id;
  row.slot_capacity = Math.max(Number(slot.capacity || 0), 0);

  const [bookingResult, trackedResult, salesResult] = await Promise.all([
    supabase
      .from('schedule_bookings')
      .select('id,schedule_slot_id,address_id,sales_order_id,phone,status,booking_source,google_sheet_source_key,external_account_number')
      .eq('schedule_slot_id', slot.id),
    supabase
      .from('schedule_bookings')
      .select('id,schedule_slot_id,address_id,sales_order_id,phone,status,booking_source,google_sheet_source_key,external_account_number')
      .eq('google_sheet_source_key', row.source_key)
      .limit(2),
    supabase
      .from('sales_orders')
      .select('id,address_id,phone,install_time,review_status,install_outcome,invoice_id,invoice_batch_id,invoiced_at')
      .ilike('territory', PILOT_TERRITORY)
      .eq('install_date', row.appointment_date),
  ]);

  if (bookingResult.error) throw bookingResult.error;
  if (trackedResult.error) throw trackedResult.error;
  if (salesResult.error) throw salesResult.error;

  const activeBookings = (bookingResult.data || []).filter(bookingIsActive);
  const scheduledSales = (salesResult.data || [])
    .filter(saleIsActive)
    .filter((sale) => normalizeTime(sale.install_time) === row.time_label);
  const orphanSales = scheduledSales.filter(
    (sale) => !activeBookings.some((booking) => bookingMatchesSale(booking, sale))
  );
  const claimed = Math.max(
    Math.max(Number(slot.booked_count || 0), 0),
    activeBookings.length + orphanSales.length
  );

  row.slot_booked_count = claimed;
  row.openings_before = Math.max(row.slot_capacity - claimed, 0);

  if (addressResult.status !== 'matched') {
    row.audit_status = addressResult.status;
    row.audit_reason = addressResult.reason;
    return row;
  }

  const tracked = (trackedResult.data || [])[0] || null;
  if (tracked) {
    row.existing_booking_id = tracked.id;
    if (tracked.schedule_slot_id === slot.id && bookingIsActive(tracked)) {
      row.audit_status = 'would_update_existing';
      row.audit_reason = 'This Sheet appointment is already connected to the matching active booking.';
      return row;
    }
    if (row.openings_before <= 0) {
      row.audit_status = 'would_overbook';
      row.audit_reason = 'Moving the tracked booking here would exceed this slot capacity.';
      return row;
    }
    row.audit_status = 'would_update_existing';
    row.audit_reason = 'The tracked Google Sheet booking would be moved to this slot.';
    return row;
  }

  const matchingBooking = activeBookings.find((booking) =>
    bookingMatchesAppointment(booking, row.address_id, row.external_account_number)
  );
  if (matchingBooking) {
    row.existing_booking_id = matchingBooking.id;
    row.audit_status = 'would_link_existing';
    row.audit_reason = 'The appointment matches an existing active FieldOS booking and would not consume capacity twice.';
    return row;
  }

  if (row.openings_before <= 0) {
    row.audit_status = 'would_overbook';
    row.audit_reason = 'The requested slot is already full.';
    return row;
  }

  row.audit_status = 'would_book';
  row.audit_reason = 'The appointment has a matching address and an available FieldOS slot.';
  return row;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return respond(response, 405, { error: 'Method not allowed' });
  }

  const requiredEnvironment = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_SHEET_PILOT_SECRET'];
  const missing = requiredEnvironment.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    return respond(response, 500, { error: 'Google Sheet pilot is not configured' });
  }

  const suppliedSecret = clean(request.headers['x-fieldos-sheet-secret']);
  if (!suppliedSecret || suppliedSecret !== process.env.GOOGLE_SHEET_PILOT_SECRET) {
    return respond(response, 401, { error: 'Unauthorized' });
  }

  const body = request.body || {};
  const appointments = Array.isArray(body.appointments) ? body.appointments : null;
  if (
    clean(body.mode) !== 'audit' ||
    clean(body.spreadsheet_id) !== PILOT_SPREADSHEET_ID ||
    Number(body.sheet_id) !== PILOT_SHEET_ID ||
    clean(body.sheet_name) !== PILOT_SHEET_NAME ||
    body.scan_complete !== true ||
    !appointments
  ) {
    return respond(response, 400, { error: 'Expected a complete Battle Mountain audit payload' });
  }
  if (appointments.length > MAX_APPOINTMENTS) {
    return respond(response, 413, { error: `Pilot payload exceeds ${MAX_APPOINTMENTS} appointments` });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const runId = crypto.randomUUID();
  const analyzed = [];

  for (const appointment of appointments) {
    let row;
    try {
      row = await analyzeAppointment(supabase, appointment || {}, runId);
    } catch (error) {
      console.error('Pilot appointment analysis failed:', clean(error?.message || error));
      row = basePilotRow(appointment || {}, runId);
      row.audit_status = 'invalid';
      row.audit_reason = clean(error?.message || 'Database analysis failed').slice(0, 1000);
    }

    const { error: upsertError } = await supabase
      .from('google_sheet_schedule_pilot')
      .upsert(row, { onConflict: 'source_key' });
    if (upsertError) {
      console.error('Pilot row could not be saved:', upsertError);
      return respond(response, 500, { error: 'A pilot audit row could not be saved' });
    }
    analyzed.push(row);
  }

  const { error: staleError } = await supabase
    .from('google_sheet_schedule_pilot')
    .update({ is_present: false })
    .eq('spreadsheet_id', PILOT_SPREADSHEET_ID)
    .eq('sheet_name', PILOT_SHEET_NAME)
    .eq('territory', PILOT_TERRITORY)
    .eq('is_present', true)
    .neq('last_run_id', runId);

  if (staleError) {
    console.error('Could not mark missing pilot rows:', staleError);
    return respond(response, 500, { error: 'Pilot completed, but stale rows could not be reconciled' });
  }

  const counts = analyzed.reduce((summary, row) => {
    summary[row.audit_status] = Number(summary[row.audit_status] || 0) + 1;
    return summary;
  }, {});

  return respond(response, 200, {
    ok: true,
    mode: 'audit',
    live_bookings_changed: false,
    run_id: runId,
    scanned_appointments: analyzed.length,
    counts,
  });
}
