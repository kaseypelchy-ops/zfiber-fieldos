/* Zito FieldOS — application logic
 * Split from single-file build on 2026.02.24
 * To update: bump ?v= query string in index.html <script> tag
 */
var TEAM_LINK_ALIASES = {
  fiber: 'Fiber Sales Team, LLC',
  fibersales: 'Fiber Sales Team, LLC',
  fsi: 'Sales Focus Inc.',
  sfi: 'Sales Focus Inc.',
  salesfocus: 'Sales Focus Inc.',
  salesfocusinc: 'Sales Focus Inc.',
  lynxx: 'Lynxx Sales',
  lynxxsales: 'Lynxx Sales'
};

// ──────────────────────────────────────────────────────────
//  STATE
// ──────────────────────────────────────────────────────────
var APP_NAME    = 'Zito FieldOS';
var APP_TAGLINE = 'Field Operations & Sales Intelligence';
var APP_VERSION = '2.0.8';
var BUILD_ID    = '2026.07.07-team-write-fix';
var APP_ENV     = 'Production';

var addresses  = [];
var activeId   = null;
// Stable selection lock: keeps the exact house selected while GPS/route refreshes rebuild the address list.
var activeAddressKey = null;
var activeAddressSnapshot = null;
var selPkg     = null;
var selStatus  = null;
var selSlot    = null;
// ──────────────────────────────────────────────────────────
//  TEAM CONFIG — Supabase-backed sandbox
// ──────────────────────────────────────────────────────────
var TEAMS = {
  'Fiber Sales Team, LLC': { slug: 'fiber', source: 'supabase' },
  'Sales Focus Inc.': { slug: 'sfi', source: 'supabase' },
  'Lynxx Sales': { slug: 'lynxx', source: 'supabase' }
};

var SUPABASE_URL = window.FIELDOS_SUPABASE_URL || 'PASTE_YOUR_SUPABASE_URL_HERE';
var SUPABASE_ANON_KEY = window.FIELDOS_SUPABASE_ANON_KEY || 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE';
var supabaseClient = (window.supabase && typeof window.supabase.createClient === 'function' &&
  SUPABASE_URL.indexOf('PASTE_') !== 0 && SUPABASE_ANON_KEY.indexOf('PASTE_') !== 0)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

var scheduleRealtimeChannel = null;


// ──────────────────────────────────────────────────────────
//  PRICING / PROMO CONFIG — Supabase-backed offer engine
//  Source of truth: public.fieldos_pricing_offers
// ──────────────────────────────────────────────────────────
var FIELDOS_PRICING_TABLE = 'fieldos_pricing_offers';
var pricingOffersLoaded = false;
var pricingOffersByPackage = {};
var pricingOfferRows = [];
var pricingLoadError = '';

var DEFAULT_PRICING_OFFERS = {
  mega: {
    id: null,
    offer_code: 'fallback_mega',
    package_key: 'mega',
    package_name: 'Mega Speed Internet',
    speed_label: '400 Mbps',
    promo_display: '$39.95/mo for 24 months',
    promo_term_label: '24 months',
    standard_rate_label: '$87.39/mo after promo',
    standard_rate: 87.39,
    phases: [
      { label: 'Months 1–24', month_start: 1, month_end: 24, internet_price: 39.95 },
      { label: 'Month 25+', month_start: 25, month_end: null, internet_price: 87.39 }
    ],
    charges: [
      { key: 'modem', label: 'Modem Rental', amount: 0, recurring: true, required: true, prorate: true },
      { key: 'eero', label: 'eero WiFi Router', amount: 5, recurring: true, required: true, prorate: true },
      { key: 'processing', label: 'Payment Processing Fee', amount: 1, recurring: true, required: true, prorate: false }
    ],
    disclosure: 'Fallback pricing shown because no approved offer was loaded. Confirm current promo before quoting.'
  },
  gig: {
    id: null,
    offer_code: 'fallback_gig',
    package_key: 'gig',
    package_name: 'Gig Speed Internet',
    speed_label: '1,000 Mbps',
    promo_display: '$30.00/mo for 24 months',
    promo_term_label: '24 months',
    standard_rate_label: '$90.95/mo after promo',
    standard_rate: 90.95,
    phases: [
      { label: 'Months 1–24', month_start: 1, month_end: 24, internet_price: 30.00 },
      { label: 'Month 25+', month_start: 25, month_end: null, internet_price: 90.95 }
    ],
    charges: [
      { key: 'modem', label: 'Modem Rental', amount: 0, recurring: true, required: true, prorate: true },
      { key: 'eero', label: 'eero WiFi Router', amount: 5, recurring: true, required: true, prorate: true },
      { key: 'processing', label: 'Payment Processing Fee', amount: 1, recurring: true, required: true, prorate: false }
    ],
    disclosure: 'Fallback pricing shown because no approved offer was loaded. Confirm current promo before quoting.'
  }
};

function normalizePricingTerritory(value) {
  return String(value || '').toLowerCase().trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function money(n) {
  var val = Number(n || 0);
  return '$' + val.toFixed(2);
}

function parseJsonMaybe(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch(e) {}
  }
  return fallback;
}

function normalizeCharge(row) {
  row = row || {};
  return {
    key: String(row.key || row.charge_key || row.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    label: String(row.label || row.name || row.charge_label || 'Charge'),
    amount: Number(row.amount || row.monthly_fee || row.price || 0),
    recurring: row.recurring === false ? false : true,
    required: row.required === false ? false : true,
    prorate: row.prorate === false ? false : true
  };
}

function normalizePhase(row) {
  row = row || {};
  var price = row.internet_price;
  if (price === undefined || price === null) price = row.monthly_price;
  if (price === undefined || price === null) price = row.price;
  return {
    label: String(row.label || row.phase_label || ''),
    month_start: row.month_start === null || row.month_start === undefined ? 1 : Number(row.month_start),
    month_end: row.month_end === null || row.month_end === undefined || row.month_end === '' ? null : Number(row.month_end),
    internet_price: Number(price || 0),
    description: String(row.description || '')
  };
}

function normalizePricingOffer(row) {
  row = row || {};
  var key = String(row.package_key || row.package || '').toLowerCase().trim();
  var phases = parseJsonMaybe(row.phases, []);
  phases = Array.isArray(phases) ? phases.map(normalizePhase) : [];
  if (!phases.length) {
    var promoPrice = row.promo_price;
    if (promoPrice === undefined || promoPrice === null) promoPrice = row.price;
    phases = [{ label: row.promo_term_label || 'Promo term', month_start: 1, month_end: null, internet_price: Number(promoPrice || 0) }];
  }

  var charges = parseJsonMaybe(row.charges, []);
  charges = Array.isArray(charges) ? charges.map(normalizeCharge) : [];
  if (!charges.length) {
    charges = [
      { key: 'modem', label: 'Modem Rental', amount: Number(row.modem_fee || 0), recurring: true, required: true, prorate: true },
      { key: 'eero', label: row.eero_label || 'eero WiFi Router', amount: Number(row.eero_fee == null ? 5 : row.eero_fee), recurring: true, required: true, prorate: true },
      { key: 'processing', label: 'Payment Processing Fee', amount: Number(row.processing_fee == null ? 1 : row.processing_fee), recurring: true, required: true, prorate: false }
    ];
  }

  phases.sort(function(a,b){ return Number(a.month_start || 1) - Number(b.month_start || 1); });
  return {
    id: row.id || null,
    offer_code: row.offer_code || row.code || '',
    team_slug: row.team_slug || '',
    territory: row.territory || '',
    package_key: key,
    package_name: row.package_name || (key === 'gig' ? 'Gig Speed Internet' : 'Mega Speed Internet'),
    speed_label: row.speed_label || row.internet_speed || (key === 'gig' ? '1,000 Mbps' : '400 Mbps'),
    offer_title: row.offer_title || row.title || '',
    offer_badge: row.offer_badge || row.badge || '',
    promo_display: row.promo_display || derivePromoDisplayFromPhases(phases),
    promo_term_label: row.promo_term_label || derivePromoTermFromPhases(phases),
    standard_rate: Number(row.standard_rate || 0),
    standard_rate_label: row.standard_rate_label || (row.standard_rate ? (money(row.standard_rate) + '/mo after promo') : ''),
    active_start: row.active_start || row.effective_start || row.promo_effective_date || '',
    active_end: row.active_end || row.effective_end || '',
    priority: Number(row.priority || 100),
    sort_order: Number(row.sort_order || 100),
    phases: phases,
    charges: charges,
    disclosure: row.disclosure || row.legal_disclaimer || row.note || ''
  };
}

function derivePromoDisplayFromPhases(phases) {
  phases = phases || [];
  if (!phases.length) return 'Current offer';
  var p = phases[0];
  if (Number(p.internet_price || 0) === 0) {
    var end = p.month_end ? (' for ' + p.month_end + ' month' + (p.month_end === 1 ? '' : 's')) : '';
    return 'Internet FREE' + end;
  }
  return money(p.internet_price) + '/mo' + (p.month_end ? (' through month ' + p.month_end) : '');
}

function derivePromoTermFromPhases(phases) {
  phases = phases || [];
  if (!phases.length) return '';
  var lastFinite = null;
  phases.forEach(function(p){ if (p.month_end) lastFinite = p.month_end; });
  return lastFinite ? (lastFinite + ' months') : '';
}

function activeTeamSlug() {
  var team = TEAMS && activeTeam ? TEAMS[activeTeam] : null;
  return team && team.slug ? String(team.slug).trim() : '';
}

// FieldOS row ownership helpers.
// These values must be written with every disposition / sale so the vendor
// dashboards can filter correctly without relying only on territory names.
function getActiveTeamLabel() {
  return String(activeTeam || '').trim();
}

function getActiveTeamSlug() {
  return activeTeamSlug();
}

function getActiveTeamPayload() {
  return {
    team: getActiveTeamLabel(),
    team_slug: getActiveTeamSlug()
  };
}

function pricingDateIsActive(row) {
  var today = new Date();
  today.setHours(0,0,0,0);
  var start = row.active_start || row.effective_start;
  var end = row.active_end || row.effective_end;
  if (start) {
    var sd = new Date(String(start) + 'T00:00:00');
    if (!isNaN(sd.getTime()) && today < sd) return false;
  }
  if (end) {
    var ed = new Date(String(end) + 'T23:59:59');
    if (!isNaN(ed.getTime()) && today > ed) return false;
  }
  return true;
}

function pickBestPricingOffer(rows, pkgKey, territories) {
  var teamSlug = activeTeamSlug();
  var terrKeys = (territories || []).map(normalizePricingTerritory).filter(Boolean);
  var candidates = (rows || []).map(normalizePricingOffer).filter(function(o) {
    if (o.package_key !== pkgKey) return false;
    if (o.team_slug && o.team_slug !== 'all' && teamSlug && o.team_slug !== teamSlug) return false;
    if (!pricingDateIsActive(o)) return false;
    var ot = normalizePricingTerritory(o.territory);
    if (!ot || ot === 'all' || terrKeys.indexOf(ot) >= 0) return true;
    return false;
  });

  candidates.sort(function(a,b) {
    var at = normalizePricingTerritory(a.territory), bt = normalizePricingTerritory(b.territory);
    var aExact = terrKeys.indexOf(at) >= 0 ? 1 : 0;
    var bExact = terrKeys.indexOf(bt) >= 0 ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.sort_order - b.sort_order;
  });

  return candidates[0] || DEFAULT_PRICING_OFFERS[pkgKey];
}

function fetchPricingOffersForActiveTerritories(territories) {
  pricingOffersLoaded = false;
  pricingLoadError = '';
  pricingOffersByPackage = {
    mega: DEFAULT_PRICING_OFFERS.mega,
    gig: DEFAULT_PRICING_OFFERS.gig
  };

  if (!hasSupabase()) {
    renderPackageCards();
    return Promise.resolve(pricingOffersByPackage);
  }

  return supabaseClient
    .from(FIELDOS_PRICING_TABLE)
    .select('*')
    .eq('is_active', true)
    .order('priority', { ascending: true })
    .order('sort_order', { ascending: true })
    .then(function(res) {
      if (res.error) throw res.error;
      pricingOfferRows = res.data || [];
      pricingOffersByPackage = {
        mega: pickBestPricingOffer(pricingOfferRows, 'mega', territories),
        gig: pickBestPricingOffer(pricingOfferRows, 'gig', territories)
      };
      pricingOffersLoaded = true;
      renderPackageCards();
      return pricingOffersByPackage;
    })
    .catch(function(err) {
      console.error('Offer load failed:', err);
      pricingLoadError = String((err && err.message) || err || 'Could not load current offers');
      pricingOffersByPackage = {
        mega: DEFAULT_PRICING_OFFERS.mega,
        gig: DEFAULT_PRICING_OFFERS.gig
      };
      renderPackageCards();
      toast('⚠ Could not load current offers — using fallback', 't-err');
      return pricingOffersByPackage;
    });
}

function getCurrentOffer(pkgKey) {
  return (pricingOffersByPackage && pricingOffersByPackage[pkgKey]) || DEFAULT_PRICING_OFFERS[pkgKey] || null;
}

function requiredRecurringCharges(offer) {
  return (offer && offer.charges ? offer.charges : []).filter(function(c) {
    return c && c.recurring !== false && c.required !== false;
  });
}

function sumCharges(charges) {
  return (charges || []).reduce(function(s,c){ return s + Number(c.amount || 0); }, 0);
}

function getInternetPriceForMonth(offer, monthNumber) {
  monthNumber = Number(monthNumber || 1);
  var phases = offer && offer.phases ? offer.phases : [];
  for (var i = 0; i < phases.length; i++) {
    var p = phases[i];
    var start = Number(p.month_start || 1);
    var end = p.month_end === null || p.month_end === undefined ? 999999 : Number(p.month_end);
    if (monthNumber >= start && monthNumber <= end) return Number(p.internet_price || 0);
  }
  return phases.length ? Number(phases[0].internet_price || 0) : 0;
}

function phaseLabel(p) {
  if (!p) return 'Internet';
  if (p.label) return p.label;
  if (p.month_end === null || p.month_end === undefined || p.month_end === '') return 'Month ' + (p.month_start || 1) + '+';
  if (Number(p.month_start || 1) === Number(p.month_end || 1)) return 'Month ' + p.month_start;
  return 'Months ' + (p.month_start || 1) + '–' + p.month_end;
}

function offerPhaseSummary(offer) {
  var phases = offer && offer.phases ? offer.phases : [];
  return phases.map(function(p) {
    var price = Number(p.internet_price || 0) === 0 ? 'FREE' : money(p.internet_price) + '/mo';
    return phaseLabel(p) + ': ' + price;
  }).join(' | ');
}

function renderPackageCards() {
  ['mega', 'gig'].forEach(function(key) {
    var offer = getCurrentOffer(key);
    var card = document.getElementById('pkg-' + key);
    if (!card || !offer) return;
    var nameEl = card.querySelector('.pkg-name');
    var speedEl = card.querySelector('.pkg-speed');
    var priceEl = card.querySelector('.pkg-price');
    if (nameEl) nameEl.textContent = offer.package_name || (key === 'gig' ? 'Gig Speed' : 'Mega Speed');
    if (speedEl) speedEl.textContent = offer.speed_label || '';
    if (priceEl) priceEl.textContent = offer.promo_display || derivePromoDisplayFromPhases(offer.phases || []);
    card.title = (offer.offer_title ? offer.offer_title + ' — ' : '') + offerPhaseSummary(offer);
  });
}

function buildSelectedOfferSnapshot(pkgKey, installDate) {
  var offer = getCurrentOffer(pkgKey);
  if (!offer) return null;
  var charges = requiredRecurringCharges(offer);
  var chargeTotal = sumCharges(charges);
  var monthOneInternet = getInternetPriceForMonth(offer, 1);
  var monthOneTotal = monthOneInternet + chargeTotal;
  var firstBillEstimate = monthOneTotal;
  var prorationTotal = 0;

  if (installDate) {
    var install = new Date(installDate + 'T12:00:00');
    if (!isNaN(install.getTime())) {
      var nextFirst = new Date(install.getFullYear(), install.getMonth() + 1, 1);
      var diffDays = Math.max(0, Math.round((nextFirst - install) / (1000 * 60 * 60 * 24)));
      var daysInMonth = new Date(install.getFullYear(), install.getMonth() + 1, 0).getDate();
      var proratableCharges = charges.filter(function(c){ return c.prorate !== false; });
      prorationTotal = ((monthOneInternet + sumCharges(proratableCharges)) / daysInMonth) * diffDays;
      firstBillEstimate = monthOneTotal + prorationTotal;
    }
  }

  return {
    offer_id: offer.id || null,
    offer_code: offer.offer_code || '',
    package_key: pkgKey,
    package_name: offer.package_name,
    speed_label: offer.speed_label,
    promo_display: offer.promo_display,
    promo_term_label: offer.promo_term_label,
    standard_rate_label: offer.standard_rate_label,
    phases: offer.phases || [],
    charges: offer.charges || [],
    recurring_charges_total: Number(chargeTotal.toFixed(2)),
    month_one_internet: Number(monthOneInternet.toFixed(2)),
    month_one_total: Number(monthOneTotal.toFixed(2)),
    proration_estimate: Number(prorationTotal.toFixed(2)),
    first_bill_estimate: Number(firstBillEstimate.toFixed(2)),
    disclosure: offer.disclosure || ''
  };
}

function pricingSummaryText(snapshot) {
  if (!snapshot) return '';
  var parts = [
    snapshot.package_name,
    snapshot.speed_label,
    'Promo: ' + (snapshot.promo_display || offerPhaseSummary({ phases: snapshot.phases })),
    'Promo Schedule: ' + offerPhaseSummary({ phases: snapshot.phases }),
    'Required Monthly Charges: ' + money(snapshot.recurring_charges_total),
    'Estimated First Bill: ' + money(snapshot.first_bill_estimate)
  ];
  if (snapshot.standard_rate_label) parts.push('After Promo: ' + snapshot.standard_rate_label);
  return parts.filter(Boolean).join(' | ');
}

function startScheduleRealtime() {
  if (!supabaseClient) return;

  if (scheduleRealtimeChannel) {
    try { supabaseClient.removeChannel(scheduleRealtimeChannel); } catch (e) {}
    scheduleRealtimeChannel = null;
  }

  scheduleRealtimeChannel = supabaseClient
    .channel('fieldos-schedule-realtime')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'schedule_slots'
      },
      function(payload) {
        var row = payload.new || payload.old;
        if (!row) return;

        var scheduleTerritory = getScheduleTerritory ? getScheduleTerritory() : (activeTerritory || '');
        var rowTerritory = String(row.territory || '').trim();

        if (scheduleTerritory && rowTerritory && rowTerritory !== scheduleTerritory) return;

        fetchScheduleSlotsFromSupabase(scheduleTerritory)
          .then(function(rows) {
            var data = {};
            rows.forEach(function(r) {
              var date = String(r.slot_date || '').trim();
              var time = schedNormalizeTime(r.time_label || '');
              if (!date || !time) return;

              if (!data[date]) data[date] = {};
              data[date][time] = {
                cap: Number(r.capacity || 0),
                booked: Number(r.booked_count || 0),
                avail: Math.max(0, Number(r.capacity || 0) - Number(r.booked_count || 0)),
                slotId: r.id,
                territory: r.territory
              };
            });

            schedData = data;

            if (!document.getElementById('sched-picker').classList.contains('hidden')) {
              schedRenderWeek();
            }
          })
          .catch(function(err) {
            console.error('Realtime schedule refresh failed', err);
          });
      }
    )
    .subscribe();
}

function stopScheduleRealtime() {
  if (!supabaseClient || !scheduleRealtimeChannel) return;
  try { supabaseClient.removeChannel(scheduleRealtimeChannel); } catch (e) {}
  scheduleRealtimeChannel = null;
}

function hasSupabase() {
  return !!supabaseClient;
}

function supabaseWarn() {
  if (!hasSupabase()) {
    toast('⚠ App connection is not configured yet', 't-err');
    console.error('Set FIELDOS_SUPABASE_URL and FIELDOS_SUPABASE_ANON_KEY in index.html');
    return false;
  }
  return true;
}

function readOfflineQueue() {
  try {
    var raw = localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]';
    var rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

function writeOfflineQueue(rows) {
  try { localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(rows || [])); } catch (e) {}
  updateOfflineQueueUI();
}

function offlineId() {
  return 'oq_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function enqueueOfflineTask(type, table, payload, label) {
  var q = readOfflineQueue();
  q.push({
    id: offlineId(),
    type: type,
    table: table,
    payload: payload || {},
    label: label || type,
    created_at: new Date().toISOString(),
    attempts: 0
  });
  writeOfflineQueue(q);
  toast('📴 Saved offline — will sync automatically', 't-info');
  return true;
}

function updateOfflineQueueUI() {
  var btn = document.getElementById('offline-sync-btn');
  if (!btn) return;
  var q = readOfflineQueue();
  btn.classList.remove('pending', 'syncing', 'error');
  if (offlineSyncRunning) {
    btn.classList.add('syncing');
    btn.textContent = 'Syncing…';
    return;
  }
  if (q.length > 0) {
    btn.classList.add(navigator.onLine === false ? 'error' : 'pending');
    btn.textContent = q.length + ' pending';
    btn.title = q.length + ' queued item(s). Tap to sync.';
  } else {
    btn.textContent = 'Synced';
    btn.title = 'All field activity is synced.';
  }
}

function isMissingOptionalColumnError(err) {
  var msg = String((err && (err.message || err.details || err.hint || err.code)) || '').toLowerCase();
  return msg.indexOf('column') >= 0 && (
    msg.indexOf('lat') >= 0 ||
    msg.indexOf('lng') >= 0 ||
    msg.indexOf('knocked_at') >= 0 ||
    msg.indexOf('team') >= 0 ||
    msg.indexOf('team_slug') >= 0
  );
}

function stripOptionalEventFields(payload) {
  var copy = Object.assign({}, payload || {});
  delete copy.lat;
  delete copy.lng;
  delete copy.knocked_lat;
  delete copy.knocked_lng;
  // Keep app from breaking if an optional field is not available.
  // Run the included SQL so these fields persist going forward.
  delete copy.team;
  delete copy.team_slug;
  return copy;
}


function isMissingOptionalSalesColumnError(err) {
  var msg = String((err && (err.message || err.details || err.hint || err.code)) || '').toLowerCase();
  return msg.indexOf('column') >= 0 && (
    msg.indexOf('offer_id') >= 0 ||
    msg.indexOf('offer_snapshot') >= 0 ||
    msg.indexOf('monthly_total') >= 0 ||
    msg.indexOf('first_bill_estimate') >= 0 ||
    msg.indexOf('promo_price') >= 0 ||
    msg.indexOf('promo_term') >= 0 ||
    msg.indexOf('standard_rate') >= 0 ||
    msg.indexOf('team') >= 0 ||
    msg.indexOf('team_slug') >= 0
  );
}

function stripOptionalSalesFields(payload) {
  var copy = Object.assign({}, payload || {});
  delete copy.offer_id;
  delete copy.offer_snapshot;
  delete copy.monthly_total;
  delete copy.first_bill_estimate;
  delete copy.promo_price;
  delete copy.promo_term;
  delete copy.standard_rate;
  // Keep app from breaking if an optional field is not available.
  // Run the included SQL so these fields persist going forward.
  delete copy.team;
  delete copy.team_slug;
  return copy;
}

function isMissingOptionalTeamColumnError(err) {
  var msg = String((err && (err.message || err.details || err.hint || err.code)) || '').toLowerCase();
  return msg.indexOf('column') >= 0 && (msg.indexOf('team') >= 0 || msg.indexOf('team_slug') >= 0 || msg.indexOf('territory') >= 0);
}

function stripOptionalTeamFields(payload) {
  var copy = Object.assign({}, payload || {});
  delete copy.team;
  delete copy.team_slug;
  delete copy.territory;
  return copy;
}

function insertSupabaseRow(table, payload) {
  if (!hasSupabase()) return Promise.reject(new Error('App connection is not configured'));
  return supabaseClient.from(table).insert([payload]).then(function(res) {
    if (res.error && table === 'address_events' && isMissingOptionalColumnError(res.error)) {
      return supabaseClient.from(table).insert([stripOptionalEventFields(payload)]).then(function(retry) {
        if (retry.error) throw retry.error;
        return retry;
      });
    }
    if (res.error && table === 'sales_orders' && isMissingOptionalSalesColumnError(res.error)) {
      return supabaseClient.from(table).insert([stripOptionalSalesFields(payload)]).then(function(retry) {
        if (retry.error) throw retry.error;
        return retry;
      });
    }
    if (res.error && table === 'schedule_bookings' && isMissingOptionalTeamColumnError(res.error)) {
      return supabaseClient.from(table).insert([stripOptionalTeamFields(payload)]).then(function(retry) {
        if (retry.error) throw retry.error;
        return retry;
      });
    }
    if (res.error) throw res.error;
    return res;
  });
}

function processOfflineQueue(manual) {
  updateOfflineQueueUI();
  if (offlineSyncRunning) return Promise.resolve(false);
  var q = readOfflineQueue();
  if (!q.length) {
    if (manual) toast('✅ Everything is already synced', 't-ok');
    updateOfflineQueueUI();
    return Promise.resolve(true);
  }
  if (!hasSupabase()) {
    if (manual) toast('⚠ Connection is not configured — queue kept locally', 't-err');
    updateOfflineQueueUI();
    return Promise.resolve(false);
  }
  if (navigator.onLine === false) {
    if (manual) toast('📴 Device is offline — queue kept locally', 't-err');
    updateOfflineQueueUI();
    return Promise.resolve(false);
  }

  offlineSyncRunning = true;
  updateOfflineQueueUI();

  var remaining = [];
  var synced = 0;

  return q.reduce(function(chain, task) {
    return chain.then(function() {
      var payload = Object.assign({}, task.payload || {});
      return insertSupabaseRow(task.table, payload).then(function() {
        synced++;
      }).catch(function(err) {
        console.error('Offline sync failed for task', task, err);
        task.attempts = Number(task.attempts || 0) + 1;
        task.last_error = String((err && err.message) || err || 'Sync failed');
        remaining.push(task);
      });
    });
  }, Promise.resolve()).then(function() {
    writeOfflineQueue(remaining);
    offlineSyncRunning = false;
    updateOfflineQueueUI();
    if (synced && manual) toast('✅ Synced ' + synced + ' queued item(s)', 't-ok');
    if (!synced && manual && remaining.length) toast('⚠ Still could not sync queued items', 't-err');
    return remaining.length === 0;
  }).catch(function(err) {
    console.error(err);
    offlineSyncRunning = false;
    updateOfflineQueueUI();
    if (manual) toast('⚠ Offline queue sync failed', 't-err');
    return false;
  });
}

window.addEventListener('online', function(){ processOfflineQueue(false); });
window.addEventListener('offline', updateOfflineQueueUI);
setTimeout(updateOfflineQueueUI, 0);

function fetchRepProfileFromSupabase(name) {
  if (!supabaseWarn()) return Promise.resolve(null);
  var clean = String(name || '').trim();
  if (!clean) return Promise.resolve(null);

  return supabaseClient
    .from('reps')
    .select('*')
    .ilike('full_name', clean)
    .limit(1)
    .then(function(res){
      if (res.error) throw res.error;
      var rep = (res.data && res.data[0]) ? res.data[0] : null;
      if (!rep) return null;

      var activeValue = String(rep.is_active === undefined || rep.is_active === null ? 'true' : rep.is_active).toLowerCase().trim();
      if (rep.is_active === false || activeValue === 'false' || activeValue === '0' || activeValue === 'no') {
        throw new Error('This rep profile is inactive. Please contact your manager before using FieldOS.');
      }

      return rep;
    });
}

function fetchRepTerritoriesFromSupabase(repId, fallbackTerritory) {
  if (!supabaseWarn()) return Promise.resolve([]);
  if (!repId) {
    return Promise.resolve(fallbackTerritory ? [String(fallbackTerritory).trim()] : []);
  }

  return supabaseClient
    .from('rep_territories')
    .select('territory, is_primary')
    .eq('rep_id', repId)
    .order('is_primary', { ascending: false })
    .then(function(res) {
      if (res.error) throw res.error;
      var rows = res.data || [];
      var territories = rows
        .map(function(row){ return String(row.territory || '').trim(); })
        .filter(function(v, i, arr){ return v && arr.indexOf(v) === i; });

      if (!territories.length && fallbackTerritory) {
        territories = [String(fallbackTerritory).trim()];
      }
      return territories;
    });
}

function fetchAddressesByTerritoriesFromSupabase(territories) {
  if (!supabaseWarn()) return Promise.resolve([]);
  var terrs = (territories || []).map(function(t){ return String(t || '').trim(); }).filter(Boolean);
  if (!terrs.length) return Promise.resolve([]);

  var pageSize = 1000;
  var allRows = [];
  var from = 0;

  function loadPage() {
    var to = from + pageSize - 1;

    return supabaseClient
      .from('addresses')
      .select('*')
      .in('territory', terrs)
      .order('territory', { ascending: true })
      .order('address1', { ascending: true })
      .range(from, to)
      .then(function(res) {
        if (res.error) throw res.error;

        var rows = res.data || [];
        allRows = allRows.concat(rows);

        if (rows.length < pageSize) {
          return allRows;
        }

        from += pageSize;
        return loadPage();
      });
  }

  return loadPage();
}

function getScheduleTerritory() {
  var addr = getAddr();
  if (addr && addr.territory) return String(addr.territory).trim();
  if (activeTerritoryTab) return String(activeTerritoryTab).trim();
  if (activeTerritory) return String(activeTerritory).trim();
  if (activeTerritories && activeTerritories.length) return String(activeTerritories[0]).trim();
  return '';
}

function fetchLatestAddressEventsMap(addressIds) {
  if (!supabaseWarn() || !addressIds || !addressIds.length) return Promise.resolve({});

  var chunkSize = 200;
  var chunks = [];
  for (var i = 0; i < addressIds.length; i += chunkSize) {
    chunks.push(addressIds.slice(i, i + chunkSize));
  }

  return Promise.all(
    chunks.map(function(chunk) {
      return supabaseClient
        .from('address_events')
        .select('*')
        .in('address_id', chunk)
        .order('created_at', { ascending: false })
        .then(function(res) {
          if (res.error) throw res.error;
          return res.data || [];
        });
    })
  ).then(function(results) {
    var map = {};
    results.flat().forEach(function(ev) {
      if (!map[ev.address_id]) map[ev.address_id] = ev;
    });
    return map;
  });
}

function fetchScheduleSlotsFromSupabase(territory) {
  if (!supabaseWarn()) return Promise.resolve([]);
  var terr = String(territory || '').trim();
  if (!terr) return Promise.resolve([]);
  var today = new Date().toISOString().split('T')[0];
  return supabaseClient
    .from('schedule_slots')
    .select('*')
    .eq('territory', terr)
    .gte('slot_date', today)
    .order('slot_date', { ascending: true })
    .order('time_label', { ascending: true })
    .then(function(res){
      if (res.error) throw res.error;
      return res.data || [];
    });
}

var activeTeam  = '';
var webhookURL  = '';
var repName    = 'Rep';
var repPhone   = '';
var repEmail   = '';
var repWebsite = 'https://www.zitomedia.net';
var activeTerritory = '';
var activeTerritories = [];
var activeTerritoryTab = '';
var mapObj     = null;
var mapMarkers = {};
var clusterGroup = null; // Leaflet.markercluster group — holds all address pins
var kmlGeoJSON = null;
var toastTimer = null;
var sidebarOpen  = true;
var pinDropMode  = false;
var tempPinMarker = null;
var focusPulseLayer = null;

// Rep-assistant state
var OFFLINE_QUEUE_KEY = 'fieldos_offline_queue_v1';
var offlineSyncRunning = false;
var nextBestDoorId = null;
var gamePlanCollapsed = false;
var launchLoadRunning = false;
var loadedRepLookupName = '';
function normalizeRepLoginName(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }

// ──────────────────────────────────────────────────────────
//  COLORS
// ──────────────────────────────────────────────────────────
var COLORS = {
  pending:       '#6b7280',
  mega:          '#8b5cf6',
  gig:           '#10b981',
  nothome:       '#f59e0b',   // amber
  nothome2:      '#f59e0b',
  nothome3:      '#f59e0b',
  nothome4:      '#f59e0b',
  fibercompetitor:   '#ef4444',   // red
  incontract:    '#6366f1',   // indigo
  notinterested: '#ec4899',   // pink
  goback:        '#06b6d4',   // cyan
  maybelater:    '#22c55e',
  sendinfo:      '#0ea5e9',
  talktospouse:  '#a855f7',
  priceconcern:  '#f97316',
  notdecisionmaker: '#14b8a6',
  vacant:        '#78716c',   // stone
  business:      '#2563eb',   // blue
  competitor:    '#f97316',   // orange
  activecustomer:'#facc15'    // yellow
};
var COLOR_ACTIVE = '#facc15';

// ── Knockable door classification ─────────────────────────
// An address is "knockable" if it is NOT an existing Zito customer.
// Existing customers arrive from the sheet with activeCount = 'active',
// 'existing', or 'customer' — they show as ⚡ bolt icons and must be
// excluded from coverage, close rate, pending, and forecast calculations.
// Everything else (homes passed with no service, empty activeCount) is knockable.
function isKnockable(a) {
  var ac = (a.activeCount || '').toLowerCase().trim();
  var s  = (a.status      || '').toLowerCase().trim();
  if (ac === 'active' || ac === 'existing' || ac === 'customer') return false;
  if (s  === 'active') return false;
  return true;
}

// Count knockable addresses — use this everywhere instead of addresses.length
// when you need the size of the actual sales universe.
function knockableCount() {
  return addresses.filter(isKnockable).length;
}
var COLOR_PASSED = '#6b7280';

var colors = {
  accent: '#005696',
  mega:   '#8b5cf6',
  gig:    '#10b981',
  warn:   '#d97706',
  danger: '#ef4444',
  muted:  '#8b949e'
};


var STANDARDIZED_OUTCOME_LABELS = {
  nothome: 'Not home',
  hardno: 'Hard no',
  someinterest: 'Some interest',
  converted: 'Converted'
};

function isSoftInterestStatus(status) {
  status = String(status || '').toLowerCase().trim();
  return ['goback','maybelater','sendinfo','talktospouse','priceconcern','notdecisionmaker'].indexOf(status) >= 0;
}

function getStandardizedOutcomeKey(status) {
  status = String(status || '').toLowerCase().trim();
  if (status === 'mega' || status === 'gig') return 'converted';
  if (status === 'nothome' || status === 'nothome2' || status === 'nothome3' || status === 'nothome4') return 'nothome';
  if (isSoftInterestStatus(status)) return 'someinterest';
  if (status === 'pending' || status === 'homes passed' || !status) return '';
  return 'hardno';
}

function getStandardizedOutcomeLabel(status) {
  var key = getStandardizedOutcomeKey(status);
  return key ? STANDARDIZED_OUTCOME_LABELS[key] : '';
}

function getSoftInterestType(status) {
  status = String(status || '').toLowerCase().trim();
  if (!isSoftInterestStatus(status) || status === 'goback') return '';
  return status;
}

function normalizeOutcomeFlagsForStatus(status, flags) {
  var next = {
    decisionMakerSpokenTo: (flags && flags.decisionMakerSpokenTo) || 'N',
    followUpNeeded: (flags && flags.followUpNeeded) || 'N',
    saleMade: (flags && flags.saleMade) || 'N'
  };
  if (isSoftInterestStatus(status)) next.followUpNeeded = 'Y';
  return next;
}


// ──────────────────────────────────────────────────────────
//  SIDEBAR TOGGLE
// ──────────────────────────────────────────────────────────
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  var app = document.getElementById('page-app');
  var btn = document.getElementById('sidebar-toggle');
  if (sidebarOpen) {
    app.classList.remove('sidebar-collapsed');
    btn.innerHTML = '&#8249;';
    btn.title = 'Hide address list';
  } else {
    app.classList.add('sidebar-collapsed');
    btn.innerHTML = '&#8250;';
    btn.title = 'Show address list';
  }
  if (mapObj) {
    setTimeout(function() { mapObj.invalidateSize(); }, 260);
  }
}

function maybeAutoCollapse() {
  if (window.innerWidth <= 640) {
    sidebarOpen = true;
    toggleSidebar();
  }
}

// ──────────────────────────────────────────────────────────
//  MODAL
// ──────────────────────────────────────────────────────────
function openModal()  { document.getElementById('modal').classList.add('open'); }
function closeModal() { document.getElementById('modal').classList.remove('open'); }
function handleModalClick(e) { if (e.target === document.getElementById('modal')) closeModal(); }

// ──────────────────────────────────────────────────────────
//  FILE INPUTS
// ──────────────────────────────────────────────────────────

// Lazy-load a script only when it's first needed.
// PapaParse (14KB) and JSZip (25KB) are skipped entirely on
// normal sessions where no file upload happens.
function lazyLoad(url, cb) {
  if (document.querySelector('script[src="' + url + '"]')) { cb(); return; }
  var s = document.createElement('script');
  s.src = url;
  s.onload = cb;
  document.head.appendChild(s);
}
var PAPAPARSE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js';
var JSZIP_URL     = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

var csvFileInput = document.getElementById('csv-file');
if (csvFileInput) {
  csvFileInput.addEventListener('change', function() {
    var f = this.files[0];
    if (!f) return;
    lazyLoad(PAPAPARSE_URL, function() {
      Papa.parse(f, {
        header: true,
        skipEmptyLines: true,
        complete: function(res) {
          addresses = [];
          res.data.forEach(function(row, i) {
            var keys = Object.keys(row);
            function col(names) {
              for (var n of names) {
                var k = keys.find(function(k){ return k.toLowerCase().trim() === n; });
                if (k !== undefined && row[k] !== undefined && String(row[k]).trim()) return String(row[k]).trim();
              }
              return '';
            }
            var addr = col(['address','street address','street']);
            if (!addr) return;
            var activeCount = col(['active count','active_count','activecount','active','type','customer type','customertype']).toLowerCase().trim();
            addresses.push({
              id: i,
              address: addr,
              city:  col(['city']),
              state: col(['state']),
              zip:   col(['zip','zipcode','zip code','postal','postal code']),
              lat:   parseFloat(col(['lat','latitude']))  || null,
              lng:   parseFloat(col(['lng','lon','longitude'])) || null,
              activeCount: activeCount,
              status: 'pending',
              sale: null
            });
          });
          var el = document.getElementById('csv-status');
          if (addresses.length > 0) {
            if (el) {
              el.className = 'dz-status ok';
              el.textContent = '✓ ' + addresses.length + ' addresses loaded';
            }
            checkLaunchReady();
          } else if (el) {
            el.className = 'dz-status err';
            el.textContent = '✗ No addresses found — check column names (need: address, city, state, zip)';
          }
        }
      });
    });
  });
}

// ── KMZ / KML ────────────────────────────────────────────
var kmlFiles = [];
var kmlLeafletLayers = [];
var activeBoundaryLoadKey = '';
var BOUNDARY_STORAGE_BUCKET = 'fieldos-boundaries';

var kmlFileInput = document.getElementById('kml-file');
if (kmlFileInput) {
  kmlFileInput.addEventListener('change', function() {
    var files = Array.from(this.files);
    if (!files.length) return;
    var input = this;
    lazyLoad(JSZIP_URL, function() {
      Promise.allSettled(files.map(function(f) { return loadKmlFile(f, { source: 'manual' }); }))
        .finally(function(){ input.value = ''; });
    });
  });
}

function getBoundaryFileName(row) {
  var raw = String((row && (row.display_name || row.file_name || row.file_path || row.path)) || 'territory_boundary.kmz').trim();
  raw = raw.split('/').pop() || raw;
  var ext = String((row && row.file_type) || '').toLowerCase().replace('.', '').trim();

  if (!/\.(kmz|kml)$/i.test(raw)) {
    raw += '.' + (ext === 'kml' ? 'kml' : 'kmz');
  }

  return raw;
}

function makeNamedBoundaryFile(blob, fileName, fileType) {
  var mime = fileType === 'kml'
    ? 'application/vnd.google-earth.kml+xml'
    : 'application/vnd.google-earth.kmz';

  try {
    return new File([blob], fileName, { type: mime });
  } catch (e) {
    // Older mobile browsers may not support File(). loadKmlFile only needs .name
    // plus Blob/FileReader compatibility, so assigning name is enough.
    blob.name = fileName;
    return blob;
  }
}

function loadKmlFile(f, opts) {
  opts = opts || {};
  var fileName = String(f && f.name ? f.name : 'territory_boundary.kmz');
  var ext = fileName.split('.').pop().toLowerCase();

  if (ext === 'kmz') {
    return JSZip.loadAsync(f).then(function(zip) {
      var kmlEntry = null;
      zip.forEach(function(path, file) {
        if (!kmlEntry && path.toLowerCase().endsWith('.kml')) kmlEntry = file;
      });
      if (!kmlEntry) {
        addKmlFileRow(fileName, [], '⚠ No KML inside', opts);
        return [];
      }
      return kmlEntry.async('string').then(function(text) {
        var features = parseKmlFeatures(text);
        addKmlFileRow(fileName, features, features.length ? null : '⚠ No polygons found', opts);
        return features;
      });
    }).catch(function(err) {
      console.warn('Could not unzip KMZ', err);
      addKmlFileRow(fileName, [], '⚠ Could not unzip', opts);
      return [];
    });
  }

  return new Promise(function(resolve) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var features = parseKmlFeatures(e.target.result);
      addKmlFileRow(fileName, features, features.length ? null : '⚠ No polygons found', opts);
      resolve(features);
    };
    reader.onerror = function() {
      addKmlFileRow(fileName, [], '⚠ Could not read file', opts);
      resolve([]);
    };
    reader.readAsText(f);
  });
}

function fetchBoundaryFilesForTerritoriesFromSupabase(territories) {
  if (!hasSupabase()) return Promise.resolve([]);

  var terrs = (territories || [])
    .map(function(t){ return String(t || '').trim(); })
    .filter(Boolean)
    .filter(function(v, i, arr){ return arr.indexOf(v) === i; });

  if (!terrs.length) return Promise.resolve([]);

  var teamSlug = '';
  try {
    teamSlug = (TEAMS[activeTeam] && TEAMS[activeTeam].slug) ? TEAMS[activeTeam].slug : '';
  } catch (e) {
    teamSlug = '';
  }

  var query = supabaseClient
    .from('territory_boundary_files')
    .select('*')
    .in('territory', terrs)
    .eq('is_active', true);

  // If team_slug is populated, only load rows for the current vendor/team.
  // If team_slug is null/blank, treat the boundary as generally available.
  if (teamSlug) {
    query = query.or('team_slug.is.null,team_slug.eq.' + teamSlug);
  }

  return query
    .order('sort_order', { ascending: true })
    .order('display_name', { ascending: true })
    .then(function(res) {
      if (res.error) throw res.error;
      return res.data || [];
    });
}

function loadRemoteBoundaryFile(row) {
  var bucket = String(row.bucket_name || BOUNDARY_STORAGE_BUCKET).trim();
  var path = String(row.file_path || row.storage_path || row.path || '').trim();
  var fileType = String(row.file_type || path.split('.').pop() || 'kmz').toLowerCase().replace('.', '').trim();

  if (!bucket || !path) {
    return Promise.reject(new Error('Boundary file row is missing bucket_name or file_path'));
  }

  return supabaseClient
    .storage
    .from(bucket)
    .download(path)
    .then(function(res) {
      if (res.error) throw res.error;

      var fileName = getBoundaryFileName(row);
      var file = makeNamedBoundaryFile(res.data, fileName, fileType);

      return loadKmlFile(file, {
        source: 'supabase',
        territory: row.territory || '',
        filePath: path,
        bucketName: bucket,
        displayName: row.display_name || fileName
      }).then(function(){ return fileName; });
    });
}

function clearKmlFiles(remoteOnly) {
  var removed = [];
  kmlFiles = kmlFiles.filter(function(f) {
    var shouldRemove = !remoteOnly || f.source === 'supabase';
    if (shouldRemove) removed.push(f.uid);
    return !shouldRemove;
  });

  removed.forEach(function(uid) {
    var row = document.getElementById(uid);
    if (row) row.remove();
  });

  rebuildKmlGeoJSON();
  renderKmlLayersOnMap(false);
}

function loadBoundaryFilesForActiveTerritories(territories, opts) {
  opts = opts || {};

  var terrs = (territories || [])
    .map(function(t){ return String(t || '').trim(); })
    .filter(Boolean)
    .filter(function(v, i, arr){ return arr.indexOf(v) === i; });

  if (!terrs.length) return Promise.resolve([]);

  var teamSlug = '';
  try {
    teamSlug = (TEAMS[activeTeam] && TEAMS[activeTeam].slug) ? TEAMS[activeTeam].slug : '';
  } catch (e) {
    teamSlug = '';
  }

  var loadKey = teamSlug + '|' + terrs.slice().sort().join('|');
  if (!opts.force && activeBoundaryLoadKey === loadKey) {
    return Promise.resolve([]);
  }

  activeBoundaryLoadKey = loadKey;
  clearKmlFiles(true);

  return new Promise(function(resolve) {
    lazyLoad(JSZIP_URL, function() {
      fetchBoundaryFilesForTerritoriesFromSupabase(terrs)
        .then(function(rows) {
          if (!rows.length) {
            console.info('No automatic boundary files found for territories:', terrs);
            resolve([]);
            return;
          }

          return Promise.allSettled(rows.map(loadRemoteBoundaryFile)).then(function(results) {
            var loaded = results.filter(function(r){ return r.status === 'fulfilled'; }).length;
            var failed = results.length - loaded;

            if (loaded) {
              toast('🗺️ Loaded ' + loaded + ' territory boundary file' + (loaded === 1 ? '' : 's'), 't-ok');
            }
            if (failed) {
              toast('⚠ ' + failed + ' boundary file' + (failed === 1 ? '' : 's') + ' could not load', 't-err');
              console.warn('Some boundary files failed to load', results);
            }

            resolve(results);
          });
        })
        .catch(function(err) {
          console.warn('Automatic boundary file load failed:', err);
          // Do not block address loading if the map file is missing.
          toast('⚠ Could not auto-load territory boundary', 't-err');
          resolve([]);
        });
    });
  });
}

function parseKmlFeatures(text) {
  try {
    var xml  = new DOMParser().parseFromString(text, 'text/xml');
    var feats = [];
    xml.querySelectorAll('coordinates').forEach(function(node) {
      var pts = node.textContent.trim().split(/\s+/).map(function(s) {
        var p = s.split(',');
        return [parseFloat(p[0]), parseFloat(p[1])];
      }).filter(function(p){ return !isNaN(p[0]) && !isNaN(p[1]); });
      if (pts.length > 2) {
        feats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[pts] }, properties:{} });
      }
    });
    return feats;
  } catch(e) { return []; }
}

function addKmlFileRow(name, features, errMsg, opts) {
  opts = opts || {};
  var ok = !errMsg && features.length > 0;
  var uid = 'kf-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
  var source = opts.source || 'manual';
  var displayName = opts.displayName || name;
  var territoryLabel = opts.territory ? ' • ' + opts.territory : '';

  if (ok) {
    kmlFiles.push({
      uid: uid,
      name: name,
      displayName: displayName,
      features: features,
      source: source,
      territory: opts.territory || '',
      filePath: opts.filePath || '',
      bucketName: opts.bucketName || ''
    });
    rebuildKmlGeoJSON();
    renderKmlLayersOnMap(true);
  }

  var list = document.getElementById('kml-file-list');
  if (!list) return;

  var row  = document.createElement('div');
  row.className = 'kml-file-row ' + (ok ? 'ok' : 'err') + (source === 'supabase' ? ' auto' : '');
  row.id = uid;
  row.innerHTML =
    '<span class="kml-file-icon">' + (ok ? (source === 'supabase' ? '☁️' : '🗺️') : '⚠️') + '</span>' +
    '<span class="kml-file-name" title="' + escHtml(displayName) + '">' + escHtml(displayName) + '</span>' +
    '<span class="kml-file-status">' +
      (ok
        ? features.length + ' polygon' + (features.length !== 1 ? 's' : '') + (source === 'supabase' ? ' • auto-loaded' : '') + escHtml(territoryLabel)
        : errMsg) +
    '</span>' +
    (ok ? '<button class="kml-file-remove" onclick="removeKmlFile(\'' + uid + '\')" title="Remove">✕</button>' : '');
  list.appendChild(row);
}

function removeKmlFile(uid) {
  kmlFiles = kmlFiles.filter(function(f){ return f.uid !== uid; });
  var row = document.getElementById(uid);
  if (row) row.remove();
  rebuildKmlGeoJSON();
  renderKmlLayersOnMap(false);
}

function rebuildKmlGeoJSON() {
  var allFeatures = [];
  kmlFiles.forEach(function(f){ allFeatures = allFeatures.concat(f.features); });
  kmlGeoJSON = allFeatures.length > 0
    ? { type:'FeatureCollection', features: allFeatures }
    : null;
}

function renderKmlLayersOnMap(shouldFit) {
  if (!mapObj || typeof L === 'undefined') return;

  kmlLeafletLayers.forEach(function(layer) {
    try { mapObj.removeLayer(layer); } catch (e) {}
  });
  kmlLeafletLayers = [];

  if (!kmlFiles.length) return;

  var palette = [
    { stroke:'#2563eb', fill:'#3b82f6' },
    { stroke:'#d97706', fill:'#f59e0b' },
    { stroke:'#059669', fill:'#10b981' },
    { stroke:'#dc2626', fill:'#ef4444' },
    { stroke:'#7c3aed', fill:'#8b5cf6' },
    { stroke:'#0891b2', fill:'#06b6d4' }
  ];
  var allBounds = [];

  kmlFiles.forEach(function(kf, i) {
    if (!kf.features || !kf.features.length) return;

    var col = palette[i % palette.length];
    var layer = L.geoJSON({ type:'FeatureCollection', features: kf.features }, {
      style: {
        color: col.stroke,
        weight: 3,
        fillColor: col.fill,
        fillOpacity: 0.12,
        dashArray: '8 4'
      }
    }).addTo(mapObj);

    kmlLeafletLayers.push(layer);

    try {
      var bounds = layer.getBounds();
      if (bounds && bounds.isValid && bounds.isValid()) allBounds.push(bounds);
    } catch (e) {}
  });

  if (shouldFit && allBounds.length) {
    var combined = allBounds[0];
    allBounds.forEach(function(b){ combined.extend(b); });
    setTimeout(function(){ mapObj.fitBounds(combined, { padding:[40,40] }); }, 100);
  }
}

['dz-csv','dz-kml'].forEach(function(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('dragover',  function(e){ e.preventDefault(); el.classList.add('dz-over'); });
  el.addEventListener('dragleave', function(){ el.classList.remove('dz-over'); });
  el.addEventListener('drop',      function(){ el.classList.remove('dz-over'); });
});

// ──────────────────────────────────────────────────────────
//  LOAD ADDRESSES FROM SHEET
// ──────────────────────────────────────────────────────────
function fetchAddressesFromSheet(opts) {
  opts = opts || {};
  var isRefresh = !!opts.isRefresh;
  var isLaunchLoad = !!opts.isLaunchLoad;
  var btn = document.getElementById('btn-fetch-addr');
  var st  = document.getElementById('fetch-addr-status');
  var profileSt = document.getElementById('rep-profile-status');
  var repInput = (document.getElementById('rep-name') ? (document.getElementById('rep-name').value || '').trim() : '');

  if (!repInput || repInput.split(/\s+/).filter(function(p){ return p.length > 0; }).length < 2) {
    if (st) {
      st.className = 'dz-status err';
      st.textContent = '✗ Enter your full name first (First Last).';
    }
    return Promise.reject(new Error('Enter your full name first (First Last).'));
  }

  if (!supabaseWarn()) return Promise.reject(new Error('App connection is not configured yet'));

  if (btn) btn.disabled = true;
  if (!isRefresh && document.getElementById('fetch-addr-icon')) {
    document.getElementById('fetch-addr-icon').textContent = '⏳';
  }
  if (st && !isRefresh) {
    st.className = 'dz-status';
    st.textContent = isLaunchLoad ? 'Loading addresses, pricing, and territory map…' : 'Loading…';
  }
  if (profileSt && !isRefresh) {
    profileSt.style.color = 'var(--muted)';
    profileSt.textContent = '';
  }

  setRefreshButtonState(true);

  return fetchRepProfileFromSupabase(repInput)
    .then(function(rep){
      if (!rep) throw new Error('Rep profile not found for this team.');

      activeTerritory = (rep.territory || '').trim();
      repPhone = (rep.phone || '').trim();
      repEmail = (rep.email || '').trim();

      try {
        if (repPhone) localStorage.setItem('zito_rep_phone', repPhone);
        if (repEmail) localStorage.setItem('zito_rep_email', repEmail);
      } catch(e) {}

      return fetchRepTerritoriesFromSupabase(rep.id, activeTerritory)
        .then(function(territories) {
          activeTerritories = territories || [];
          if (!activeTerritories.length && activeTerritory) activeTerritories = [activeTerritory];
          if (!activeTerritory && activeTerritories.length) activeTerritory = activeTerritories[0];

          if (profileSt) {
            profileSt.style.color = '#10b981';
            profileSt.textContent = '✓ Profile loaded' +
              (repPhone ? ' • ' + repPhone : '') +
              (repEmail ? ' • ' + repEmail : '') +
              (activeTerritories.length ? ' • Territories: ' + activeTerritories.join(', ') : '');
          }

          // Load the rep's assigned boundary file(s) and active pricing before
          // the app opens. Boundary failures are logged, but do not block reps
          // from getting into FieldOS if addresses still load correctly.
          var boundaryPromise = loadBoundaryFilesForActiveTerritories(activeTerritories, { force: !isRefresh })
            .catch(function(err) {
              console.error('Automatic boundary file load failed:', err);
              if (!isLaunchLoad) toast('⚠ Could not auto-load territory map', 't-err');
              return [];
            });

          var pricingPromise = fetchPricingOffersForActiveTerritories(activeTerritories)
            .catch(function(err) {
              console.error('Offer load failed:', err);
              toast('⚠ Pricing offers could not load — using fallback pricing', 't-err');
              return [];
            });

          return pricingPromise
            .then(function() {
              return fetchAddressesByTerritoriesFromSupabase(activeTerritories)
                .then(function(rows){
                  return fetchLatestAddressEventsMap(rows.map(function(r){ return r.id; }))
                    .then(function(eventsMap){ return { rows: rows, eventsMap: eventsMap }; });
                });
            })
            .then(function(result) {
              return boundaryPromise.then(function(){ return result; });
            });
        });
    })
    .then(function(result){
      var rows = result.rows || [];
      var eventsMap = result.eventsMap || {};

      activeTerritoryTab = '';
      addresses = rows.map(function(row) {
        var ev = eventsMap[row.id] || {};
        var lat = (row.lat !== '' && row.lat != null) ? parseFloat(row.lat) : null;
        var lng = (row.lng !== '' && row.lng != null) ? parseFloat(row.lng) : null;

        return {
          id: row.id,
          sheetRow: null,
          territory: (row.territory || activeTerritory || '').trim(),
          address: (row.address1 || '').trim(),
          city: (row.city || '').trim(),
          state: (row.state || '').trim(),
          zip: (row.postal_code || '').trim(),
          lat: isFinite(lat) ? lat : null,
          lng: isFinite(lng) ? lng : null,
          customerStatus: (row.customer_status || '').toString().trim(),
          activeCount: (row.customer_status || '').toString().trim(),
          status: ((ev.status || row.status || 'homes passed') + '').toLowerCase().trim(),
          salesperson: (ev.rep_name || row.salesperson || '').trim(),
          note: (ev.note || row.note || '').toString().trim(),
          knockedAt: ev.knocked_at || row.knocked_at || null,
          decisionMakerSpokenTo: ev.decision_maker_spoken_to ? 'Y' : 'N',
          followUpNeeded: ev.follow_up_needed ? 'Y' : 'N',
          saleMade: ev.sale_made ? 'Y' : 'N',
          technology: (row.technology || '').trim(),
          serviceability: (row.serviceability || '').trim(),
          externalLocationId: row.external_location_id || '',
          primaryCampaign: row.primary_campaign || '',
          priorityRank: row.priority_rank_within_territory || row.primary_campaign_priority_rank || row.priority_rank || null,
          targetDate: row.target_date || '',
          targetWeek: row.target_week || ''
        };
      });

      loadedRepLookupName = normalizeRepLoginName(repInput);

      updateStats();
      buildList();
      geocodeAll();
      fitToAddresses();
      checkLaunchReady();

      if (st) {
        st.className = 'dz-status ok';
        st.textContent = '✓ Loaded ' + addresses.length + ' addresses' + (kmlFiles.filter(function(f){ return f.source === 'supabase'; }).length ? ' and territory map' : '');
      }
      if (document.getElementById('fetch-addr-icon')) {
        document.getElementById('fetch-addr-icon').textContent = '✅';
      }

      return addresses;
    })
    .catch(function(err){
      console.error(err);
      if (st) {
        st.className = 'dz-status err';
        st.textContent = '✗ ' + (err.message || 'Failed to load addresses');
      }
      if (document.getElementById('fetch-addr-icon')) {
        document.getElementById('fetch-addr-icon').textContent = '⚠️';
      }
      throw err;
    })
    .finally(function(){
      if (btn) btn.disabled = false;
      setRefreshButtonState(false);
    });
}


// ──────────────────────────────────────────────────────────
//  NAME VALIDATION
// ──────────────────────────────────────────────────────────
function hasValidName() {
  var val   = (document.getElementById('rep-name').value || '').trim();
  var parts = val.split(/\s+/).filter(function(p){ return p.length > 0; });
  return parts.length >= 2 && val.toLowerCase() !== 'rep';
}

function validateRepName() {
  var hint = document.getElementById('rep-name-hint');
  var val  = (document.getElementById('rep-name').value || '').trim();
  if (loadedRepLookupName && normalizeRepLoginName(val) !== loadedRepLookupName) {
    addresses = [];
    loadedRepLookupName = '';
  }
  if (val.length > 0 && !hasValidName()) {
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
  checkLaunchReady();
}

function checkLaunchReady() {
  var hasTeam = !!activeTeam;
  var btn = document.getElementById('launch-btn');
  if (!btn) return;
  btn.disabled = !(hasValidName() && hasTeam) || !!launchLoadRunning;
  if (launchLoadRunning) {
    btn.textContent = 'Loading…';
  } else if (addresses.length > 0) {
    btn.textContent = 'Launch FieldOS';
  } else {
    btn.textContent = 'Load & Launch';
  }
}

function getPresetTeamNameFromURL() {
  try {
    var params = new URLSearchParams(window.location.search || '');
    var raw = (params.get('team') || '').toLowerCase().trim();
    if (!raw) return '';
    if (TEAM_LINK_ALIASES[raw]) return TEAM_LINK_ALIASES[raw];

    var direct = Object.keys(TEAMS).find(function(name) {
      return name.toLowerCase().trim() === raw;
    });
    return direct || '';
  } catch (e) {
    return '';
  }
}

function applyPresetTeamFromURL() {
  var presetTeam = getPresetTeamNameFromURL();
  var teamStep = document.getElementById('team-step');
  var teamSel  = document.getElementById('team-select');

  if (!presetTeam || !TEAMS[presetTeam]) {
    if (teamStep) teamStep.style.display = '';
    if (teamSel) teamSel.disabled = false;
    return '';
  }

  if (teamStep) teamStep.style.display = 'none';
  if (teamSel) {
    teamSel.disabled = true;
    if (!teamSel.options.length || !Array.from(teamSel.options).some(function(opt){ return opt.value === presetTeam; })) {
      var opt = document.createElement('option');
      opt.value = presetTeam;
      opt.textContent = presetTeam;
      teamSel.appendChild(opt);
    }
    teamSel.value = presetTeam;
  }

  selectTeam(presetTeam);
  return presetTeam;
}

function selectTeam(val) {
  activeTeam = (val || '').trim();
  var team = TEAMS[activeTeam];
  if (team) {
    webhookURL = '';
    SCHED_URL  = '';
    activeTerritories = [];
    activeBoundaryLoadKey = '';
    addresses = [];
    clearKmlFiles(false);
    var fetchStatusEl = document.getElementById('fetch-addr-status');
    var fetchIconEl = document.getElementById('fetch-addr-icon');
    var fetchBtnEl = document.getElementById('btn-fetch-addr');
    if (fetchStatusEl) fetchStatusEl.textContent = '';
    if (fetchIconEl) fetchIconEl.textContent = '📋';
    if (fetchBtnEl) fetchBtnEl.disabled = false;
    try { localStorage.setItem('fieldos_team', activeTeam); } catch(e) {}
  } else {
    webhookURL = '';
    SCHED_URL  = '';
  }
  checkLaunchReady();
}


function setRefreshButtonState(isLoading, label) {
  var btn = document.getElementById('btn-refresh-data');
  if (!btn) return;
  btn.disabled = !!isLoading;
  btn.textContent = isLoading ? '⟳ Refreshing…' : (label ? '⟳ ' + label : '⟳ Refresh');
}

function refreshAddressData() {
  if (!hasSupabase()) {
    supabaseWarn();
    return;
  }
  if (!repName || repName === 'Rep') {
    repName = (document.getElementById('rep-name') ? (document.getElementById('rep-name').value || '').trim() : repName);
  }
  if (!repName) {
    toast('⚠ Rep name missing', 't-err');
    return;
  }
  fetchAddressesFromSheet({ isRefresh: true });
}


function launchApp(opts) {
  opts = opts || {};
  repName = (document.getElementById('rep-name').value || '').trim();

  if (!hasValidName()) {
    toast('⚠ Enter your first and last name before launching', 't-err');
    validateRepName();
    return;
  }

  if (!activeTeam) {
    toast('⚠ Select your team before launching', 't-err');
    return;
  }

  // New production flow: reps type first and last name, click Launch, and
  // FieldOS loads their profile, assigned territories, addresses, pricing,
  // and KMZ/KML footprint automatically before the map opens.
  var currentRepLookupName = normalizeRepLoginName(repName);
  if (!opts.skipAutoLoad && (addresses.length === 0 || loadedRepLookupName !== currentRepLookupName)) {
    var launchBtn = document.getElementById('launch-btn');
    var st = document.getElementById('fetch-addr-status');
    launchLoadRunning = true;
    if (launchBtn) {
      launchBtn.disabled = true;
      launchBtn.textContent = 'Loading…';
    }
    if (st) {
      st.className = 'dz-status';
      st.textContent = 'Loading your assigned addresses, offers, and territory map…';
    }

    fetchAddressesFromSheet({ isLaunchLoad: true })
      .then(function() {
        launchLoadRunning = false;
        checkLaunchReady();
        if (!addresses.length) {
          toast('⚠ No addresses were found for your assigned territory', 't-err');
          return;
        }
        launchApp({ skipAutoLoad: true });
      })
      .catch(function(err) {
        launchLoadRunning = false;
        checkLaunchReady();
        console.error(err);
        toast('⚠ Could not load your addresses: ' + (err.message || err), 't-err');
      });
    return;
  }

  try {
    localStorage.setItem('zito_rep_name', repName);
    if (repPhone) localStorage.setItem('zito_rep_phone', repPhone);
    if (repEmail) localStorage.setItem('zito_rep_email', repEmail);
    if (!localStorage.getItem('fieldos_session_start')) {
      localStorage.setItem('fieldos_session_start', new Date().toISOString());
    }
  } catch(e) {}

  var splash = document.getElementById('splash');
  document.getElementById('splash-rep-name').textContent = repName;
  var fill = document.getElementById('splash-prog-fill');
  if (fill) { fill.style.animation = 'none'; fill.offsetHeight; fill.style.animation = ''; }
  if (splash) splash.classList.remove('gone', 'fade-out');

  var fadeTimer = setTimeout(function() {
    if (!splash) return;
    splash.classList.add('fade-out');
    setTimeout(function() { splash.classList.add('gone'); }, 700);
  }, 4500);

  try {
    document.getElementById('page-setup').style.display = 'none';
    document.getElementById('page-app').style.display   = 'block';

    startScheduleRealtime();
    updateStats();
    buildList();
    initMap();

    setTimeout(function() {
      if (mapObj) {
        mapObj.invalidateSize();
        fitToAddresses();
      }
    }, 150);

    startGPSPing();
    prefetchTiles();
    geocodeAll();
    processOfflineQueue(false);
    renderGamePlan();
    maybeAutoCollapse();
  } catch (err) {
    try { clearTimeout(fadeTimer); } catch(e) {}
    if (splash) { splash.classList.add('fade-out'); setTimeout(function(){ splash.classList.add('gone'); }, 300); }
    console.error(err);
    toast('App error: ' + String(err), 't-err');
  }
}


// ──────────────────────────────────────────────────────────
//  MAP
// ──────────────────────────────────────────────────────────
  var wxRadarLayer = null;
  var wxRadarMeta  = null;
  var wxRadarOn    = false;
  var wxRadarRefreshTimer = null;

  var wxLastTempFetch = 0;
  var wxTempTimer = null;

  function wxSetRadarUI_() {};

function toggleHeatMap() {
  if (!mapObj) return;
  heatMapOn = !heatMapOn;

  var btn = document.getElementById('btn-heat-map');
  if (btn) {
    btn.textContent = heatMapOn ? '🌡 Hide Map' : '🌡 Coverage Map';
    btn.classList.toggle('active', heatMapOn);
  }

  if (!heatMapOn) {
    if (heatMapLayer) { mapObj.removeLayer(heatMapLayer); heatMapLayer = null; }
    return;
  }

  renderHeatMap();
}

function renderHeatMap() {
  if (!mapObj) return;
  if (heatMapLayer) { mapObj.removeLayer(heatMapLayer); heatMapLayer = null; }

  var circles = [];
  addresses.forEach(function(a) {
    if (!a.lat || !a.lng) return;
    var s = (a.status || 'pending').toLowerCase();
    var style = HEAT_COLORS[s] || HEAT_COLORS.pending;
    var circle = L.circleMarker([a.lat, a.lng], {
      radius:      14,
      fillColor:   style.fill,
      fillOpacity: style.opacity,
      color:       style.fill,
      opacity:     0.15,
      weight:      1,
      interactive: false,   // don't intercept map clicks
      pane:        'heatPane'
    });
    circles.push(circle);
  });

  heatMapLayer = L.layerGroup(circles);
  heatMapLayer.addTo(mapObj);
}

// Track current map tile layers
var activeBaseLayer = null;
var activeLabelLayer = null;

// Satellite imagery (ONLY base map option) + labels overlay
var SATELLITE_LAYER = {
  url:  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  opts: {
    attribution: '© Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 20,
    maxNativeZoom: 19
  }
};

// Reference labels so streets/places are readable on imagery
var LABELS_LAYER = {
  url:  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  opts: {
    attribution: '',
    maxZoom: 20,
    maxNativeZoom: 19,
    pane: 'overlayPane'
  }
};

function setSatelliteBaseLayer() {
  if (!mapObj) return;

  if (activeBaseLayer)  { mapObj.removeLayer(activeBaseLayer);  activeBaseLayer = null; }
  if (activeLabelLayer) { mapObj.removeLayer(activeLabelLayer); activeLabelLayer = null; }

  activeBaseLayer  = L.tileLayer(SATELLITE_LAYER.url, SATELLITE_LAYER.opts).addTo(mapObj);
  activeLabelLayer = L.tileLayer(LABELS_LAYER.url, LABELS_LAYER.opts).addTo(mapObj);
}

function initMap() {
  if (mapObj) return;

  mapObj = L.map('map');

  mapObj.createPane('heatPane');
  mapObj.getPane('heatPane').style.zIndex = 650;

  setSatelliteBaseLayer();

  L.control.zoom({ position: 'bottomleft' }).addTo(mapObj);

  var pinned = addresses.filter(function(a) { return a.lat && a.lng; });
  if (pinned.length > 0) {
    var avgLat = pinned.reduce(function(s,a){ return s+a.lat; }, 0) / pinned.length;
    var avgLng = pinned.reduce(function(s,a){ return s+a.lng; }, 0) / pinned.length;
    mapObj.setView([avgLat, avgLng], 14);
  } else {
    mapObj.setView([39.5, -98.35], 5);
  }

  renderKmlLayersOnMap(true);

  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 50,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 17,
    iconCreateFunction: function(cluster) {
      var count = cluster.getChildCount();
      var size  = count < 10 ? 'small' : count < 50 ? 'medium' : 'large';
      return L.divIcon({
        html: '<div class="cluster-inner">' + count + '</div>',
        className: 'marker-cluster marker-cluster-' + size,
        iconSize: L.point(40, 40)
      });
    }
  });
  clusterGroup.addTo(mapObj);

  addresses.forEach(function(a) {
    if (a.lat && a.lng) placeMarker(a);
  });

  if (!kmlGeoJSON || !kmlGeoJSON.features.length) {
    fitToAddresses();
  }

  wxSetRadarUI_(false);

  mapObj.on('click', function(e) {
    if (!pinDropMode) return;
    handleMapPinDrop(e.latlng);
  });
}
function getMarkerColor(addr) {
  var s = (addr.status || '').toLowerCase().trim();

  if (s === 'gig') return '#22c55e';          // green
  if (s === 'mega') return '#8b5cf6';         // purple
  if (s === 'activecustomer') return '#06b6d4';
  if (s === 'homes passed' || s === 'pending') return '#f97316';   // orange

  if (
    s === 'nothome' || s === 'nothome2' || s === 'nothome3' || s === 'nothome4' ||
    s === 'goback' || s === 'maybelater' || s === 'sendinfo' || s === 'talktospouse' ||
    s === 'priceconcern' || s === 'notdecisionmaker' || s === 'notinterested' ||
    s === 'vacant' || s === 'business' || s === 'competitor' ||
    s === 'fibercompetitor' || s === 'incontract'
  ) return '#ef4444';

  return '#f97316';
}
function markerHTML(color, shape) {
  if (shape === 'house') {
    return '<div style="width:26px;height:26px;background:' + color + ';clip-path:polygon(50% 0%,100% 45%,85% 45%,85% 100%,15% 100%,15% 45%,0% 45%);filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55))"></div>';
  }
  if (shape === 'bolt') {
    return '<div style="width:20px;height:28px;background:' + color + ';clip-path:polygon(65% 0%,20% 52%,48% 52%,35% 100%,80% 42%,52% 42%,68% 0%);filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55))"></div>';
  }
  return '<div style="width:16px;height:16px;border-radius:50%;background:' + color + ';border:2.5px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.5)"></div>';
}

function getMarkerShape(addr) {
  var s  = (addr.status || '').toLowerCase().trim();
  var cs = (addr.customerStatus || addr.activeCount || '').toLowerCase().trim();

  // Sold homes
  if (s === 'mega' || s === 'gig') return 'house';

  // Active customers
  if (s === 'activecustomer') return 'bolt';

  // Workable / unworked homes
  if (s === 'homes passed' || s === 'pending') return 'house';

  // Rep-logged no-sale statuses
  var REP_LOGGED = [
    'nothome','nothome2','nothome3','nothome4',
    'fibercompetitor','incontract','notinterested','goback',
    'maybelater','sendinfo','talktospouse','priceconcern',
    'notdecisionmaker','vacant','business','competitor'
  ];
  if (REP_LOGGED.indexOf(s) >= 0) return 'dot';

  // Fallback to customer/account truth only if status is blank/unknown
  if (cs === 'active' || cs === 'existing' || cs === 'customer') return 'bolt';

  return 'house';
}

function placeMarker(addr) {
  // Remove existing marker from cluster group and tracking object
  if (mapMarkers[addr.id]) {
    if (clusterGroup) clusterGroup.removeLayer(mapMarkers[addr.id]);
    else mapMarkers[addr.id].remove();
    delete mapMarkers[addr.id];
  }

 // If a disposition filter is active, keep:
// 1) the selected disposition
// 2) pending
// 3) homes passed
// 4) active customers
if (activeDispoFilter) {
  var fs = (addr.status || '').toLowerCase().trim();
  var shape = getMarkerShape(addr);

  var isPending = fs === 'pending';
  var isHomesPassed = shape === 'house';
  var isActiveCustomer = shape === 'bolt';

  var matchesDisposition = false;
  if (activeDispoFilter === 'nothome') {
    matchesDisposition = (
      fs === 'nothome' ||
      fs === 'nothome2' ||
      fs === 'nothome3' ||
      fs === 'nothome4'
    );
  } else {
    matchesDisposition = fs === activeDispoFilter;
  }

  if (!matchesDisposition && !isPending && !isHomesPassed && !isActiveCustomer) return;
}

  var color  = getMarkerColor(addr);
  var shape  = getMarkerShape(addr);
  var html   = markerHTML(color, shape);
  var size   = shape === 'house' ? [26,26] : shape === 'bolt' ? [20,28] : [16,16];
  var anchor = shape === 'house' ? [13,26] : shape === 'bolt' ? [10,28] : [8,8];
  var icon   = L.divIcon({ className:'', html: html, iconSize: size, iconAnchor: anchor });
  var m      = L.marker([addr.lat, addr.lng], { icon: icon });

  // Lazy popup — build HTML only when the user actually taps the pin.
  // Previously all 200 popup strings were built and stored in memory at launch.
  var pid = addr.id;
  m.bindPopup(function() {
    var shape2  = getMarkerShape(addr);
    var safePid = String(pid).replace(/'/g, "\\'");
    var btnHTML = shape2 === 'bolt'
      ? '<button class="pop-open-btn pop-active-btn" onclick="openFormFromMap(\'' + safePid + '\')">⚡ View Address</button>'
      : '<button class="pop-open-btn" onclick="openFormFromMap(\'' + safePid + '\')">Open Sales Form</button>';
    return '<div style="font-family:Syne,sans-serif;min-width:160px">' +
      popupHtmlForAddr(addr) + btnHTML + '</div>';
  }, { minWidth: 180 });

  // Add to cluster group (falls back to direct map add if cluster not ready)
  if (clusterGroup) clusterGroup.addLayer(m);
  else m.addTo(mapObj);

  mapMarkers[addr.id] = m;
}

window.openFormFromMap = function(id) {
  if (mapObj) mapObj.closePopup();
  openForm(id);
};
// ──────────────────────────────────────────────────────────
//  GEOCODING
// ──────────────────────────────────────────────────────────
function fitToAddresses() {
  if (!mapObj) return;
  var pinned = addresses.filter(function(a) { return a.lat && a.lng; });
  if (pinned.length === 0) {
    mapObj.setView([39.5, -98.35], 5); // no pins yet — show whole US
    return;
  }
  if (pinned.length === 1) {
    // Single pin — go straight to street level
    mapObj.setView([pinned[0].lat, pinned[0].lng], 17);
    return;
  }
  // Multiple pins — fit all of them with padding, then cap zoom at 17
  // so we don't land on a comically close view when all pins are on one street
  var bounds = L.latLngBounds(pinned.map(function(a) { return [a.lat, a.lng]; }));
  mapObj.fitBounds(bounds, { padding: [48, 48], maxZoom: 17 });
}

// Pre-warm the browser's tile cache by fetching the 8 surrounding tiles at the
// current map view. This means when the user pans slightly the tiles are already
// in the HTTP cache and appear instantly instead of loading from the network.
function prefetchTiles() {
  if (!mapObj) return;
  try {
    var center = mapObj.getCenter();
    var zoom   = mapObj.getZoom();
    var tilePoint = mapObj.project(center, zoom).divideBy(256).floor();
    var urlTemplate = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    var offsets = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    offsets.forEach(function(o) {
      var url = urlTemplate
        .replace('{z}', zoom)
        .replace('{y}', tilePoint.y + o[0])
        .replace('{x}', tilePoint.x + o[1]);
      var img = new Image();
      img.src = url; // browser will cache the response; we discard the element
    });
  } catch(e) {}
}

function geocodeAll() {
  var toGeocode = addresses.filter(function(a) { return !a.lat || !a.lng; });
  if (toGeocode.length === 0) { buildList(); return; }

  var total  = toGeocode.length;
  var done   = 0;
  var failed = 0;
  showGeocodeBar(done, total);

  var idx = 0;

  // Debounced buildList — rebuilds sidebar at most once per second while
  // geocoding is in progress, instead of on every single address completion.
  // With 200 addresses this cuts ~200 full DOM rebuilds down to ~3-4.
  var _buildListTimer = null;
  function debouncedBuildList() {
    if (_buildListTimer) return;
    _buildListTimer = setTimeout(function() {
      _buildListTimer = null;
      buildList();
    }, 800);
  }

  // Persist newly geocoded coordinates back to the Google Sheet so future
  // sessions load with lat/lng already set — skipping geocoding entirely.
  function saveGeocodedCoords(a) {
    if (!hasSupabase() || !a || !a.id) return;
    supabaseClient
      .from('addresses')
      .update({
        lat: a.lat,
        lng: a.lng,
        updated_at: new Date().toISOString()
      })
      .eq('id', a.id)
      .then(function(){})
      .catch(function(){});
  }

  function geocodeOne(a) {
    var query = [a.address, a.city, a.state, a.zip].filter(Boolean).join(', ');
    var url   = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(query);

    fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'FieldSalesApp/1.0' } })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.length > 0) {
          a.lat = parseFloat(data[0].lat);
          a.lng = parseFloat(data[0].lon);
          if (mapObj) placeMarker(a);
          saveGeocodedCoords(a);
        } else {
          failed++;
          a._geocodeFailed = true;
        }
        done++;
        showGeocodeBar(done, total, failed);
        debouncedBuildList();
        scheduleNext();
      })
      .catch(function() {
        failed++;
        a._geocodeFailed = true;
        done++;
        showGeocodeBar(done, total, failed);
        scheduleNext();
      });
  }

  function scheduleNext() {
    if (idx < toGeocode.length) {
      var a = toGeocode[idx++];
      setTimeout(function() { geocodeOne(a); }, 1100);
    } else if (done >= total) {
      // Flush any pending debounced buildList before finishing
      if (_buildListTimer) { clearTimeout(_buildListTimer); _buildListTimer = null; }
      buildList();
      if (failed > 0) {
        document.getElementById('gc-text').textContent =
          '\u26a0 ' + (total - failed) + '/' + total + ' geocoded. ' + failed + ' not found.';
        document.getElementById('gc-fill').style.background = '#d97706';
        setTimeout(hideGeocodeBar, 6000);
      } else {
        document.getElementById('gc-text').textContent = '\u2713 All ' + total + ' addresses geocoded';
        document.getElementById('gc-fill').style.background = '#059669';
        setTimeout(hideGeocodeBar, 2500);
        fitToAddresses();
      }
    }
  }

  // Start a single geocoding chain — the old code called scheduleNext() twice,
  // which accidentally launched two parallel chains that stomped on each other.
  scheduleNext();
}

function showGeocodeBar(done, total, failed) {
  var bar = document.getElementById('geocode-bar');
  if (!bar) return;
  failed = failed || 0;
  var pct = Math.round((done / total) * 100);
  bar.style.display = 'flex';
  var found = done - failed;
  document.getElementById('gc-text').textContent = 'Geocoding… ' + found + ' found, ' + failed + ' not found — ' + done + '/' + total;
  document.getElementById('gc-fill').style.width = pct + '%';
}

function hideGeocodeBar() {
  var bar = document.getElementById('geocode-bar');
  if (bar) bar.style.display = 'none';
}
async function updateAddressSnapshot(addr, status, note) {
  if (!supabaseWarn()) return;

  var payload = {
    status: (status || '').toLowerCase().trim(),
    salesperson: repName || addr.salesperson || '',
    knocked_at: new Date().toISOString(),
    note: note || ''
  };

  var res = await supabaseClient
    .from('addresses')
    .update(payload)
    .eq('id', addr.id);

  if (res.error) {
    console.error(res.error);
    throw res.error;
  }
}
// ──────────────────────────────────────────────────────────
//  ADDRESS LIST
// ──────────────────────────────────────────────────────────
var TAG_HTML  = {
  mega:          '<span class="ar-tag tag-mega">⚡ Mega</span>',
  gig:           '<span class="ar-tag tag-gig">🚀 Gig</span>',
  nothome:       '<span class="ar-tag tag-nh">🚪 Not Home</span>',
  nothome2:      '<span class="ar-tag tag-nh">🚪 NH ×2</span>',
  nothome3:      '<span class="ar-tag tag-nh">🚪 NH ×3</span>',
  nothome4:      '<span class="ar-tag tag-nh">🚪 NH ×4</span>',
  fibercompetitor:   '<span class="ar-tag tag-fc">⚡ Fiber Competitor</span>',
  incontract:    '<span class="ar-tag tag-ic">📋 In Contract</span>',
  notinterested: '<span class="ar-tag tag-ni">❌ Not Int.</span>',
  goback:        '<span class="ar-tag tag-gbl">🔄 Go Back</span>',
  maybelater:    '<span class="ar-tag tag-gbl">🕒 Maybe Later</span>',
  sendinfo:      '<span class="ar-tag tag-gbl">📩 Send Info</span>',
  talktospouse:  '<span class="ar-tag tag-gbl">💬 Talk to Spouse</span>',
  priceconcern:  '<span class="ar-tag tag-comp">💲 Price Concern</span>',
  notdecisionmaker:'<span class="ar-tag tag-biz">👤 Not Decision Maker</span>',
  vacant:        '<span class="ar-tag tag-vac">🏚️ Vacant</span>',
  business:      '<span class="ar-tag tag-biz">🏢 Business</span>',
  competitor:    '<span class="ar-tag tag-comp">🔌 Competitor</span>',
  activecustomer:'<span class="ar-tag tag-ac">⚡ Active Cust.</span>'
};

// ──────────────────────────────────────────────────────────
//  DISPOSITION CONFIGS — per-territory button sets
// ──────────────────────────────────────────────────────────

// Each entry: { label, id, status, cls, icon, needsNote, notePlaceholder }
var DISPOSITIONS = [
  { label:'Not Home x1',    id:'sbt-nh1',  status:'nothome',        cls:'act-nh',   icon:'🚪',    needsNote:true },
  { label:'Not Home x2',    id:'sbt-nh2',  status:'nothome2',       cls:'act-nh',   icon:'🚪🚪',  needsNote:true },
  { label:'Not Home x3',    id:'sbt-nh3',  status:'nothome3',       cls:'act-nh',   icon:'🚪×3',  needsNote:true },
  { label:'Not Home x4',    id:'sbt-nh4',  status:'nothome4',       cls:'act-nh',   icon:'🚪×4',  needsNote:true },
  { label:'Maybe Later',    id:'sbt-ml',   status:'maybelater',     cls:'act-cb',   icon:'🕒',    needsNote:true,  notePlaceholder:'Example: interested, but asked to revisit in 30 days' },
  { label:'Send Information', id:'sbt-si', status:'sendinfo',       cls:'act-cb',   icon:'📩',    needsNote:true,  notePlaceholder:'Example: asked for email or printed information before deciding' },
  { label:'Need to Talk to Spouse', id:'sbt-ts', status:'talktospouse', cls:'act-cb', icon:'💬', needsNote:true, notePlaceholder:'Example: wants to review it with spouse before deciding' },
  { label:'Price Concern',  id:'sbt-pc',   status:'priceconcern',   cls:'act-comp', icon:'💲',    needsNote:true,  notePlaceholder:'Example: interested, but price is the current objection' },
  { label:'Not Decision Maker', id:'sbt-ndm', status:'notdecisionmaker', cls:'act-biz', icon:'👤', needsNote:true, notePlaceholder:'Example: renter or family member answered — need owner / account holder' },
  { label:'Go Back Later',  id:'sbt-gbl',  status:'goback',         cls:'act-cb',   icon:'🔄',    needsNote:true,  notePlaceholder:'Example: customer asked to come back Friday' },
  { label:'Fiber Competitor',    id:'sbt-fc',   status:'fibercompetitor',    cls:'act-fc',   icon:'⚡',    needsNote:true },
  { label:'In Contract',    id:'sbt-ic',   status:'incontract',     cls:'act-ic',   icon:'📋',    needsNote:true },
  { label:'Not Interested', id:'sbt-ni',   status:'notinterested',  cls:'act-ni',   icon:'❌',    needsNote:true,  notePlaceholder:'Example: not interested — already has provider' },
  { label:'Vacant',         id:'sbt-vac',  status:'vacant',         cls:'act-vac',  icon:'🏚️',   needsNote:true },
  { label:'Business',       id:'sbt-biz',  status:'business',       cls:'act-biz',  icon:'🏢',    needsNote:true },
  { label:'Competitor',     id:'sbt-comp', status:'competitor',     cls:'act-comp', icon:'🔌',    needsNote:true },
  { label:'Active Customer',id:'sbt-ac',   status:'activecustomer', cls:'act-ac',   icon:'⚡',    needsNote:true }
];

// Returns the disposition config (now unified for all territories)
function getDispositions(addr) {
  return DISPOSITIONS;
}

// Returns the disposition entry whose status matches, searching the given config
function findDispByStatus(status, config) {
  for (var i = 0; i < config.length; i++) {
    if (config[i].status === status) return config[i];
  }
  return null;
}

// Render the No Sale buttons into #status-grid for the given address
function renderDispositionButtons(addr) {
  var grid = document.getElementById('status-grid');
  if (!grid) return;
  var config = getDispositions(addr);
  grid.innerHTML = config.map(function(d) {
    return '<button class="stbtn" id="' + d.id + '" onclick="pickStatus(\'' + d.label.replace(/'/g,"\\'") + '\')">' +
      d.icon + ' ' + d.label + '</button>';
  }).join('');
}

// Single delegated click listener on the address list container.
// Attached once at startup — never recreated on buildList() calls.
// Replaces the old pattern of adding a listener to every row on every render,
// which was leaking N listeners every 30 seconds during polling.
document.addEventListener('click', function(e) {
  var row = e.target.closest('.addr-row');
  if (!row) return;

  var id = row.getAttribute('data-id');
  if (!id) return;

  // When a rep clicks an address in the sidebar, take the map directly to
  // that house. This works even when the pin is currently inside a cluster.
  zoomToAddressPin(id, { openPopup: false, zoom: 18 });
  openForm(id);

  if (window.innerWidth <= 640 && sidebarOpen) {
    toggleSidebar();
  }
});


// ──────────────────────────────────────────────────────────
//  TERRITORY TABS — split address list by territory
// ──────────────────────────────────────────────────────────
function buildTerritoryTabs() {
  var el = document.getElementById('territory-tabs');
  if (!el) return;
  var terrs = {};
  addresses.forEach(function(a) { if (a.territory) terrs[a.territory] = true; });
  var sorted = Object.keys(terrs).sort();
  if (sorted.length < 2) { el.innerHTML = ''; activeTerritoryTab = ''; return; }
  var html = '<button class="terr-tab' + (activeTerritoryTab === '' ? ' active' : '') + '" onclick="switchTerritoryTab(\'\')">All</button>';
  sorted.forEach(function(t) {
    html += '<button class="terr-tab' + (activeTerritoryTab === t ? ' active' : '') + '" onclick="switchTerritoryTab(\'' + escHtml(t).replace(/'/g, "\\'") + '\')">' + escHtml(t) + '</button>';
  });
  el.innerHTML = html;
}

function switchTerritoryTab(t) {
  activeTerritoryTab = t;
  buildTerritoryTabs();
  buildList(document.getElementById('addr-search').value || null);
  refreshMapMarkers();
}

function buildList(filter) {
  // Update territory tabs
  buildTerritoryTabs();
  // Update stale badge every time list rebuilds
  updateStaleBadge();
  updateOfflineQueueUI();

  var list;

  // Stale mode: show only Not Home / Go Back addresses, oldest first
  if (staleMode) {
    list = getStaleAddresses();
    if (filter) {
      var q = filter.toLowerCase();
      list = list.filter(function(a) {
        return a.address.toLowerCase().indexOf(q) >= 0 ||
               (a.city && a.city.toLowerCase().indexOf(q) >= 0);
      });
    }
  // Route mode: sort all addresses by distance from current GPS, nearest first
  } else if (routeMode && lastGPS) {
    list = addresses.slice().sort(function(a, b) {
      var distA = (a.lat && a.lng)
        ? haversineMiles(lastGPS.lat, lastGPS.lng, a.lat, a.lng)
        : 9999;
      var distB = (b.lat && b.lng)
        ? haversineMiles(lastGPS.lat, lastGPS.lng, b.lat, b.lng)
        : 9999;
      return distA - distB;
    });
    if (filter) {
      var q = filter.toLowerCase();
      list = list.filter(function(a) {
        return a.address.toLowerCase().indexOf(q) >= 0 ||
               (a.city && a.city.toLowerCase().indexOf(q) >= 0) ||
               (a.zip  && a.zip.indexOf(q) >= 0);
      });
    }
  } else {
    list = filter
      ? addresses.filter(function(a) {
          var q = filter.toLowerCase();
          return a.address.toLowerCase().indexOf(q) >= 0 ||
                 (a.city && a.city.toLowerCase().indexOf(q) >= 0) ||
                 (a.zip  && a.zip.indexOf(q) >= 0);
        })
      : addresses;
  }

  document.getElementById('addr-count').textContent = addresses.length;

  // Apply disposition filter if active
  if (activeDispoFilter) {
    list = list.filter(function(a) {
      var s = (a.status || '').toLowerCase();
      if (activeDispoFilter === 'nothome') {
        return s === 'nothome' || s === 'nothome2' || s === 'nothome3' || s === 'nothome4';
      }
      return s === activeDispoFilter;
    });
  }

  // Apply territory tab filter if active
  if (activeTerritoryTab) {
    list = list.filter(function(a) {
      return (a.territory || '').trim() === activeTerritoryTab;
    });
  }

  var currentNextBest = getNextBestDoor();
  nextBestDoorId = currentNextBest && currentNextBest.address ? currentNextBest.address.id : null;
  var streetCompletionMapForList = buildStreetCompletionMap(currentTerritoryAddresses());
  var html = list.map(function(a) {
    var sub   = [a.city, a.state, a.zip].filter(Boolean).join(', ') || '—';
    var tag   = TAG_HTML[a.status] || '';
    var selC  = isActiveAddress_(a) ? ' sel' : '';
    var color = getMarkerColor(a);
    var shape = getMarkerShape(a);
    var icon;
    if (shape === 'bolt') {
      icon = '<div style="width:11px;height:15px;background:' + color + ';clip-path:polygon(65% 0%,20% 52%,48% 52%,35% 100%,80% 42%,52% 42%,68% 0%)"></div>';
    } else if (shape === 'house') {
      icon = '<div style="width:14px;height:14px;background:' + color + ';clip-path:polygon(50% 0%,100% 45%,85% 45%,85% 100%,15% 100%,15% 45%,0% 45%)"></div>';
    } else {
      icon = '<div style="width:10px;height:10px;border-radius:50%;background:' + color + '"></div>';
    }
    var noteLine = (a.note && a.note.trim())
      ? '<div class="ar-note">' + escHtml(a.note.trim()) + '</div>'
      : '';
    var nextC = String(a.id) === String(nextBestDoorId || '') ? ' next-best-highlight' : '';

    // Route mode: show distance from current GPS position
    var modeLine = '';
    if (routeMode && lastGPS && a.lat && a.lng) {
      var mi = haversineMiles(lastGPS.lat, lastGPS.lng, a.lat, a.lng);
      var distStr = mi < 0.1 ? 'Nearby' : mi.toFixed(2) + ' mi';
      modeLine = '<div class="ar-dist">📍 ' + distStr + '</div>';
    } else if (staleMode && a.knockedAt) {
      var hrs = (Date.now() - new Date(a.knockedAt).getTime()) / 3600000;
      var ageStr = hrs < 1 ? Math.round(hrs * 60) + 'm ago'
                 : hrs < 24 ? hrs.toFixed(1) + 'h ago'
                 : Math.floor(hrs / 24) + 'd ago';
      modeLine = '<div class="ar-dist" style="color:#d97706">⏱ ' + ageStr + '</div>';
    }

    var streetMeta = streetCompletionMapForList[streetKeyForAddress(a)];
    var streetLine = streetMeta && streetMeta.total > 3
      ? '<div class="ar-progress">' + streetMeta.worked + '/' + streetMeta.total + ' worked on this street • ' + streetMeta.pending + ' pending</div>'
      : '';

    return '<div class="addr-row' + selC + nextC + '" data-id="' + a.id + '">' +
      '<div class="ar-dot">' + icon + '</div>' +
      '<div class="ar-info">' +
        '<div class="ar-st">'  + escHtml(a.address) + '</div>' +
        '<div class="ar-sub">' + escHtml(sub)        + '</div>' +
        noteLine +
        modeLine +
        streetLine +
      '</div>' + tag + '</div>';
  }).join('');

  var container = document.getElementById('addr-items');
  container.innerHTML = html || '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">No addresses found</div>';
  renderGamePlan();
  // No per-row listeners needed — delegated listener above handles all clicks
}

function filterList(val) { buildList(val || null); }

function filterByDisposition(val) {
  activeDispoFilter = (val || '').toLowerCase();
  buildList(document.getElementById('addr-search').value || null);
  refreshMapMarkers();
}

// ──────────────────────────────────────────────────────────
//  REP ASSISTANT — Today’s Game Plan, Next Best Door, Street Completion
// ──────────────────────────────────────────────────────────
function statusKey(a) { return String((a && a.status) || '').toLowerCase().trim(); }
function isPendingLikeStatus(s) { return !s || s === 'pending' || s === 'homes passed' || s === 'homespassed'; }
function isSaleStatus(s) { return s === 'mega' || s === 'gig'; }
function isNoContactStatus(s) { return s === 'nothome' || s === 'nothome2' || s === 'nothome3' || s === 'nothome4'; }
function isSoftInterestStatus(s) { return s === 'goback' || s === 'maybelater' || s === 'sendinfo' || s === 'talktospouse' || s === 'priceconcern' || s === 'notdecisionmaker'; }
function isHardStopStatus(s) { return s === 'notinterested' || s === 'vacant' || s === 'business' || s === 'activecustomer' || s === 'fibercompetitor' || s === 'competitor' || s === 'incontract'; }

function currentTerritoryAddresses() {
  return (addresses || []).filter(function(a) {
    if (!a) return false;
    if (activeTerritoryTab && String(a.territory || '').trim() !== activeTerritoryTab) return false;
    return true;
  });
}

function normalizeStreetName(address) {
  var s = String(address || '').toUpperCase();
  s = s.replace(/\b(APT|UNIT|STE|SUITE|#)\b.*$/i, '');
  s = s.replace(/^\s*\d+[A-Z]?\s+/, '');
  s = s.replace(/\b(NORTH|SOUTH|EAST|WEST)\b/g, function(m){ return ({NORTH:'N',SOUTH:'S',EAST:'E',WEST:'W'})[m] || m; });
  s = s.replace(/\b(STREET)\b/g, 'ST').replace(/\b(AVENUE)\b/g, 'AVE').replace(/\b(ROAD)\b/g, 'RD')
       .replace(/\b(DRIVE)\b/g, 'DR').replace(/\b(LANE)\b/g, 'LN').replace(/\b(BOULEVARD)\b/g, 'BLVD')
       .replace(/\b(COURT)\b/g, 'CT').replace(/\b(CIRCLE)\b/g, 'CIR').replace(/\b(PLACE)\b/g, 'PL')
       .replace(/\b(TERRACE)\b/g, 'TER').replace(/\b(HIGHWAY)\b/g, 'HWY');
  return s.replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || 'UNKNOWN STREET';
}

function streetKeyForAddress(a) {
  return [String((a && a.territory) || '').trim(), normalizeStreetName(a && a.address)].join('|');
}

function buildStreetCompletionMap(list) {
  var map = {};
  (list || currentTerritoryAddresses()).forEach(function(a) {
    if (!a || !isKnockable(a)) return;
    var key = streetKeyForAddress(a);
    var street = normalizeStreetName(a.address);
    if (!map[key]) map[key] = { key:key, street: street, territory: a.territory || '', total:0, worked:0, pending:0, sales:0, soft:0, noContact:0, latSum:0, lngSum:0, geoCount:0 };
    var row = map[key];
    var s = statusKey(a);
    row.total++;
    if (isPendingLikeStatus(s)) row.pending++;
    else row.worked++;
    if (isSaleStatus(s)) row.sales++;
    if (isSoftInterestStatus(s)) row.soft++;
    if (isNoContactStatus(s)) row.noContact++;
    if (a.lat && a.lng) { row.latSum += Number(a.lat); row.lngSum += Number(a.lng); row.geoCount++; }
  });
  Object.keys(map).forEach(function(k) {
    var r = map[k];
    r.completion = r.total ? r.worked / r.total : 0;
    r.closeRate = r.worked ? r.sales / r.worked : 0;
    if (r.geoCount) { r.lat = r.latSum / r.geoCount; r.lng = r.lngSum / r.geoCount; }
  });
  return map;
}

function streetProgressForAddress(a) {
  if (!a || !a.address) return null;
  var map = buildStreetCompletionMap(currentTerritoryAddresses());
  return map[streetKeyForAddress(a)] || null;
}

function getTopStreetRows() {
  var rows = Object.values(buildStreetCompletionMap(currentTerritoryAddresses()))
    .filter(function(r){ return r.total >= 3; })
    .sort(function(a,b){
      return (b.pending - a.pending) || (a.completion - b.completion) || (b.total - a.total);
    });
  return rows.slice(0, 4);
}

function priorityScoreForAddress(a) {
  var raw = a && a.priorityRank;
  if (raw === null || raw === undefined || raw === '') return 0;
  var n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.max(0, 24 - Math.min(24, n));
}

function scoreNextBestDoor(a, streetMap) {
  if (!a || !isKnockable(a) || !a.address) return null;
  var s = statusKey(a);
  if (isSaleStatus(s) || isHardStopStatus(s) || s === 'nothome4') return null;

  var now = new Date();
  var hour = now.getHours();
  var isPrime = hour >= 16 && hour <= 20;
  var score = 0;
  var reasons = [];

  if (isPendingLikeStatus(s)) { score += 55; reasons.push('still unworked'); }
  if (isSoftInterestStatus(s)) { score += isPrime ? 78 : 52; reasons.push('warm follow-up'); }
  if (isNoContactStatus(s)) { score += isPrime ? 48 : 18; reasons.push(isPrime ? 'good retry window' : 'retry later if no answer'); }

  var st = streetMap[streetKeyForAddress(a)];
  if (st) {
    score += Math.min(22, st.pending * 3);
    if (st.total >= 5) reasons.push(st.pending + ' pending on this street');
    if (st.completion > 0 && st.completion < .8) score += 8;
  }

  score += priorityScoreForAddress(a);
  if (a.primaryCampaign) { score += 8; reasons.push('campaign priority'); }

  if (lastGPS && a.lat && a.lng) {
    var mi = haversineMiles(lastGPS.lat, lastGPS.lng, a.lat, a.lng);
    score += Math.max(-35, 30 - (mi * 28));
    if (mi < .15) reasons.push('near you');
    else if (mi < .5) reasons.push(mi.toFixed(2) + ' mi away');
  } else if (a.lat && a.lng) {
    score += 5;
  }

  if (a.followUpNeeded === 'Y') { score += 14; reasons.push('marked follow-up'); }
  if (a.note && isSoftInterestStatus(s)) score += 8;
  if (!a.note && isSoftInterestStatus(s)) score -= 6;

  return { address: a, score: score, reasons: reasons.filter(function(v,i,arr){ return v && arr.indexOf(v) === i; }) };
}

function getNextBestDoor() {
  var list = currentTerritoryAddresses();
  var streetMap = buildStreetCompletionMap(list);
  var scored = list.map(function(a){ return scoreNextBestDoor(a, streetMap); }).filter(Boolean);
  scored.sort(function(a,b){ return b.score - a.score; });
  return scored[0] || null;
}

function openNextBestDoor(id) {
  var a = findAddressById(id);
  if (!a) return;
  nextBestDoorId = a.id;
  zoomToAddressPin(a, { openPopup: true, zoom: 18 });
  openForm(a.id);
  buildList((document.getElementById('addr-search') && document.getElementById('addr-search').value) || null);
}

function centerNextBestDoor(id) {
  var a = findAddressById(id);
  if (!a) return;
  nextBestDoorId = a.id;
  zoomToAddressPin(a, { openPopup: true, zoom: 18 });
  buildList((document.getElementById('addr-search') && document.getElementById('addr-search').value) || null);
}

function focusStreet(street) {
  var search = document.getElementById('addr-search');
  if (search) search.value = street || '';
  buildList(street || null);
  var rows = currentTerritoryAddresses().filter(function(a){ return normalizeStreetName(a.address) === normalizeStreetName(street); }).filter(function(a){ return a.lat && a.lng; });
  if (rows.length && mapObj) {
    var bounds = L.latLngBounds(rows.map(function(a){ return [a.lat, a.lng]; }));
    mapObj.fitBounds(bounds, { padding:[60,60], maxZoom:18 });
  }
}

function findAddressById(id) {
  for (var i = 0; i < addresses.length; i++) {
    if (String(addresses[i].id) === String(id)) return addresses[i];
  }
  return null;
}


function pulseAddressPin_(addr) {
  if (!mapObj || !addr || !addr.lat || !addr.lng || typeof L === 'undefined') return;
  if (focusPulseLayer) {
    try { mapObj.removeLayer(focusPulseLayer); } catch(e) {}
    focusPulseLayer = null;
  }
  if (typeof L.circleMarker !== 'function') return;
  focusPulseLayer = L.circleMarker([Number(addr.lat), Number(addr.lng)], {
    radius: 20,
    weight: 3,
    opacity: 1,
    fillOpacity: 0.12,
    color: '#22d3ee',
    fillColor: '#22d3ee'
  }).addTo(mapObj);
  setTimeout(function(){
    if (focusPulseLayer) {
      try { mapObj.removeLayer(focusPulseLayer); } catch(e) {}
      focusPulseLayer = null;
    }
  }, 1800);
}

function zoomToAddressPin(idOrAddress, opts) {
  opts = opts || {};
  var addr = (idOrAddress && typeof idOrAddress === 'object') ? idOrAddress : findAddressById(idOrAddress);
  if (!addr || !mapObj || !addr.lat || !addr.lng) return false;

  var lat = Number(addr.lat);
  var lng = Number(addr.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  var marker = mapMarkers[addr.id];
  var targetZoom = Math.max(Number(opts.zoom || 18), mapObj.getZoom ? mapObj.getZoom() : 18);

  function finishFocus() {
    try {
      mapObj.flyTo([lat, lng], targetZoom, { duration: 0.55 });
    } catch(e) {
      try { mapObj.setView([lat, lng], targetZoom); } catch(e2) {}
    }
    setTimeout(function(){
      pulseAddressPin_(addr);
      if (opts.openPopup !== false && marker) {
        try { marker.openPopup(); } catch(e) {}
      }
    }, 400);
  }

  // If the marker is clustered, Leaflet.markercluster needs to zoom/spiderfy
  // the cluster before the individual marker can be shown.
  if (clusterGroup && marker && typeof clusterGroup.zoomToShowLayer === 'function') {
    try {
      clusterGroup.zoomToShowLayer(marker, finishFocus);
      return true;
    } catch(e) {
      finishFocus();
      return true;
    }
  }

  finishFocus();
  return true;
}

function buildTodayFocusItems(metrics, next, streets) {
  var items = [];
  var hour = new Date().getHours();
  if (next) items.push('Start with the next-best door, then finish the surrounding street before jumping pockets.');
  if (metrics.soft > 0) items.push('Work ' + metrics.soft + ' warm follow-up' + (metrics.soft === 1 ? '' : 's') + ' before cold pending homes.');
  if (metrics.noContact >= 5 && hour < 16) items.push('You have several no-contact homes. Save repeat not-homes for after 4 PM when answer rates should improve.');
  if (metrics.pending > 0 && streets.length) items.push('Finish ' + streets[0].street + ' first — it has ' + streets[0].pending + ' pending door' + (streets[0].pending === 1 ? '' : 's') + '.');
  if (!items.length && metrics.pending > 0) items.push('Keep working nearest pending homes and capture notes on every real conversation.');
  if (!items.length) items.push('No obvious pending route left in the current filter. Refresh data or switch territory.');
  return items.slice(0, 4);
}

function renderGamePlan() {
  var panel = document.getElementById('fieldos-game-plan');
  if (!panel) return;
  panel.classList.toggle('collapsed', gamePlanCollapsed);
  var btn = document.getElementById('gp-collapse-btn');
  if (btn) btn.textContent = gamePlanCollapsed ? 'Show' : 'Hide';

  var list = currentTerritoryAddresses().filter(isKnockable);
  var metrics = { total:list.length, pending:0, worked:0, sales:0, soft:0, noContact:0 };
  list.forEach(function(a) {
    var s = statusKey(a);
    if (isPendingLikeStatus(s)) metrics.pending++; else metrics.worked++;
    if (isSaleStatus(s)) metrics.sales++;
    if (isSoftInterestStatus(s)) metrics.soft++;
    if (isNoContactStatus(s)) metrics.noContact++;
  });

  var title = document.getElementById('gp-title');
  if (title) {
    var territoryLabel = activeTerritoryTab || (activeTerritories && activeTerritories.length === 1 ? activeTerritories[0] : 'assigned territory');
    title.textContent = metrics.pending + ' pending • ' + metrics.soft + ' warm follow-up' + (metrics.soft === 1 ? '' : 's') + ' • ' + metrics.sales + ' sale' + (metrics.sales === 1 ? '' : 's') + ' in ' + territoryLabel;
  }

  var next = getNextBestDoor();
  nextBestDoorId = next && next.address ? next.address.id : null;
  var nextEl = document.getElementById('next-best-door');
  if (nextEl) {
    if (!next) {
      nextEl.innerHTML = '<div class="gp-muted">No knockable next door found in the current filter.</div>';
    } else {
      var a = next.address;
      var sub = [a.city, a.state, a.zip].filter(Boolean).join(', ');
      var dist = (lastGPS && a.lat && a.lng) ? haversineMiles(lastGPS.lat, lastGPS.lng, a.lat, a.lng) : null;
      var distText = dist !== null ? (dist < .1 ? 'Nearby' : dist.toFixed(2) + ' mi away') : 'GPS not available';
      nextEl.innerHTML =
        '<div class="gp-door-main">' + escHtml(a.address) + '</div>' +
        '<div class="gp-door-sub">' + escHtml(sub || a.territory || '') + ' • ' + escHtml(distText) + '</div>' +
        '<div class="gp-door-reason">Why: ' + escHtml(next.reasons.slice(0, 3).join(' • ') || 'best overall score') + '</div>' +
        '<div class="gp-actions">' +
          '<button class="gp-action primary" onclick="openNextBestDoor(\'' + String(a.id).replace(/'/g,"\\'") + '\')">Open Door</button>' +
          '<button class="gp-action" onclick="centerNextBestDoor(\'' + String(a.id).replace(/'/g,"\\'") + '\')">Show on Map</button>' +
        '</div>';
    }
  }

  var streetRows = getTopStreetRows();
  var streetEl = document.getElementById('street-completion');
  if (streetEl) {
    streetEl.innerHTML = streetRows.length ? streetRows.map(function(r) {
      var pct = Math.round(r.completion * 100);
      return '<div class="street-row">' +
        '<div><div class="street-name">' + escHtml(r.street) + '</div>' +
        '<div class="street-detail">' + r.worked + '/' + r.total + ' worked • ' + r.pending + ' pending • ' + r.sales + ' sales</div></div>' +
        '<div class="street-pct">' + pct + '%</div>' +
        '<div class="street-bar"><span style="width:' + pct + '%"></span></div>' +
        '<div class="gp-actions" style="grid-column:1/-1;margin-top:0"><button class="gp-action" onclick="focusStreet(\'' + String(r.street).replace(/'/g,"\\'") + '\')">Finish this street</button></div>' +
      '</div>';
    }).join('') : '<div class="gp-muted">No street with enough homes to score yet.</div>';
  }

  var focusEl = document.getElementById('today-focus');
  if (focusEl) {
    var items = buildTodayFocusItems(metrics, next, streetRows);
    var metricHtml = '<div class="gp-metric-grid">' +
      '<div class="gp-metric"><div class="gp-metric-value">' + metrics.pending + '</div><div class="gp-metric-label">Pending</div></div>' +
      '<div class="gp-metric"><div class="gp-metric-value">' + metrics.soft + '</div><div class="gp-metric-label">Warm</div></div>' +
      '<div class="gp-metric"><div class="gp-metric-value">' + Math.round(metrics.worked ? (metrics.sales / metrics.worked) * 100 : 0) + '%</div><div class="gp-metric-label">Close</div></div>' +
    '</div>';
    focusEl.innerHTML = metricHtml + '<div class="focus-list" style="margin-top:10px">' + items.map(function(item){
      return '<div class="focus-item"><span class="focus-dot"></span><span>' + escHtml(item) + '</span></div>';
    }).join('') + '</div>';
  }
}

function toggleGamePlan() {
  gamePlanCollapsed = !gamePlanCollapsed;
  try { localStorage.setItem('fieldos_game_plan_collapsed', gamePlanCollapsed ? '1' : '0'); } catch(e) {}
  renderGamePlan();
}

try { gamePlanCollapsed = localStorage.getItem('fieldos_game_plan_collapsed') === '1'; } catch(e) {}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ──────────────────────────────────────────────────────────
//  ADDRESS SELECTION LOCK
// ──────────────────────────────────────────────────────────
function normalizeAddressPart_(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function addressStableKey(addr) {
  if (!addr) return '';
  if (addr.sheetRow !== undefined && addr.sheetRow !== null && String(addr.sheetRow).trim() !== '') {
    return 'row:' + String(addr.sheetRow).trim();
  }
  if (addr.locationId !== undefined && addr.locationId !== null && String(addr.locationId).trim() !== '') {
    return 'loc:' + String(addr.locationId).trim();
  }
  return 'addr:' + [
    normalizeAddressPart_(addr.address),
    normalizeAddressPart_(addr.city),
    normalizeAddressPart_(addr.state),
    normalizeAddressPart_(addr.zip)
  ].join('|');
}

function copyAddressSnapshot_(addr) {
  if (!addr) return null;
  var copy = {};
  Object.keys(addr).forEach(function(k) { copy[k] = addr[k]; });
  return copy;
}

function setActiveAddressLock(addr) {
  if (!addr) return;
  activeId = addr.id;
  activeAddressKey = addressStableKey(addr);
  activeAddressSnapshot = copyAddressSnapshot_(addr);
}

function clearActiveAddressLock() {
  activeId = null;
  activeAddressKey = null;
  activeAddressSnapshot = null;
}

function findAddressByKey_(key) {
  if (!key) return null;
  for (var i = 0; i < addresses.length; i++) {
    if (addressStableKey(addresses[i]) === key) return addresses[i];
  }
  return null;
}

function applyLockedCoords_(addr) {
  if (!addr || !activeAddressSnapshot || !activeAddressKey) return addr;
  if (addressStableKey(addr) !== activeAddressKey) return addr;
  // Keep the selected marker on the coordinates the rep actually tapped/opened.
  if (activeAddressSnapshot.lat !== undefined && activeAddressSnapshot.lat !== null && activeAddressSnapshot.lng !== undefined && activeAddressSnapshot.lng !== null) {
    addr.lat = activeAddressSnapshot.lat;
    addr.lng = activeAddressSnapshot.lng;
  }
  return addr;
}

function isActiveAddress_(addr) {
  if (!addr) return false;
  if (activeAddressKey) return addressStableKey(addr) === activeAddressKey;
  return addr.id === activeId;
}

// ──────────────────────────────────────────────────────────
//  FORM
// ──────────────────────────────────────────────────────────
function openForm(id) {
  var addr = null;
  for (var i = 0; i < addresses.length; i++) {
    if (String(addresses[i].id) === String(id)) {
      addr = addresses[i];
      break;
    }
  }
  if (!addr) return;

  setFormCollapsed(false);

  if (getMarkerShape(addr) === 'bolt') {
    setActiveAddressLock(addr);
    document.getElementById('pf-addr-line').textContent = addr.address;
    document.getElementById('pf-addr-sub').textContent  = [addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
    document.getElementById('active-notice').style.display = 'block';
    document.getElementById('sales-form-body').style.display = 'none';
    document.getElementById('panel-form').classList.add('open');
    document.body.classList.add('form-open');
    buildList();
    return;
  }

  document.getElementById('active-notice').style.display = 'none';
  document.getElementById('sales-form-body').style.display = 'block';

  setActiveAddressLock(addr);

  document.getElementById('pf-addr-line').textContent = addr.address;
  document.getElementById('pf-addr-sub').textContent  = [addr.city, addr.state, addr.zip].filter(Boolean).join(', ');

  var s = addr.sale || {};
  document.getElementById('f-first').value = s.firstName || '';
  document.getElementById('f-last').value  = s.lastName  || '';
  document.getElementById('f-phone').value = s.phone     || '';
  document.getElementById('f-email').value = s.email     || '';
  document.getElementById('f-notes').value = s.notes     || '';

  selPkg    = null;
  selStatus = null;
  renderPackageCards();
  document.getElementById('pkg-mega').className = 'pkg-card mega-card';
  document.getElementById('pkg-gig').className  = 'pkg-card gig-card';
  document.getElementById('btn-mega').disabled  = true;
  document.getElementById('btn-gig').disabled   = true;
  document.getElementById('btn-mega').textContent = '⚡ Submit — ' + ((getCurrentOffer('mega') || {}).package_name || 'Mega Speed');
  document.getElementById('btn-gig').textContent  = '🚀 Submit — ' + ((getCurrentOffer('gig') || {}).package_name || 'Gig Speed');
  document.getElementById('pricing-box').classList.add('hidden');
  document.getElementById('proration-section').classList.add('hidden');
  document.getElementById('sched-confirmed').classList.add('hidden');
  document.getElementById('sched-picker').classList.add('hidden');
  document.getElementById('sched-loading').classList.add('hidden');
  document.getElementById('sched-error').classList.add('hidden');
  document.getElementById('f-install-date').value = '';
  document.getElementById('f-install-time').value = '';
  selSlot = null;
  resetOutcomeFlags();

  renderDispositionButtons(addr);

  var prevDisp    = document.getElementById('prev-disposition');
  var prevStatus  = document.getElementById('prev-disp-status');
  var prevNote    = document.getElementById('prev-disp-note');
  var nsWrap      = document.getElementById('ns-note-wrap');
  var nsNote      = document.getElementById('ns-note');
  var curStatus   = (addr.status || '').toLowerCase().trim();
  var curNote     = (addr.note   || '').trim();

  var config      = getDispositions(addr);
  var prevEntry   = findDispByStatus(curStatus, config);
  if (!prevEntry) prevEntry = findDispByStatus(curStatus, DISPOSITIONS);

  if (prevEntry) {
    setOutcomeFlags({
      decisionMakerSpokenTo: addr.decisionMakerSpokenTo || 'N',
      followUpNeeded: addr.followUpNeeded || (isSoftInterestStatus(curStatus) ? 'Y' : 'N')
    });
    prevStatus.textContent = prevEntry.label;
    prevStatus.className   = 'prev-disp-status s-' + curStatus;
    if (curNote) {
      prevNote.textContent   = '💬 ' + curNote;
      prevNote.style.display = 'block';
    } else {
      prevNote.style.display = 'none';
    }
    prevDisp.style.display = 'block';

    selStatus = prevEntry.label;
    var btnEl = document.getElementById(prevEntry.id);
    if (btnEl) btnEl.className = 'stbtn ' + prevEntry.cls;

    var needsNote = !!prevEntry.needsNote;
    if (nsWrap && nsNote) {
      if (needsNote) { nsWrap.classList.remove('hidden'); } else { nsWrap.classList.add('hidden'); }
      nsNote.value = curNote;
      if (needsNote && prevEntry.notePlaceholder) nsNote.placeholder = prevEntry.notePlaceholder;
    }
  } else {
    prevDisp.style.display = 'none';
    if (nsWrap && nsNote) { nsWrap.classList.add('hidden'); nsNote.value = ''; }
    setOutcomeFlags({
      decisionMakerSpokenTo: addr.decisionMakerSpokenTo || 'N',
      followUpNeeded: addr.followUpNeeded || (isSoftInterestStatus(curStatus) ? 'Y' : 'N')
    });
  }

  document.getElementById('panel-form').classList.add('open');
  document.body.classList.add('form-open');

  if (addr.lat && addr.lng && mapObj) {
    // Opening an address should keep the selected pin in view. For sidebar
    // clicks, zoomToAddressPin() already handled the zoom; this is a safe
    // fallback for map popups or older entry points.
    if (mapObj.getZoom && mapObj.getZoom() < 17) {
      zoomToAddressPin(addr, { openPopup: false, zoom: 18 });
    } else {
      mapObj.panTo([addr.lat, addr.lng], { animate: true });
    }
  }

  buildList();
}

function closeForm() {
  document.getElementById('panel-form').classList.remove('open');
  document.body.classList.remove('form-open');
  clearActiveAddressLock();
  selPkg    = null;
  selStatus = null;
  buildList();
}

function clearPrevDisposition() {
  var addr = getAddr();
  if (!addr) return;
  addr.status = 'pending';
  addr.note   = '';
  addr.decisionMakerSpokenTo = 'N';
  addr.followUpNeeded = 'N';
  addr.saleMade = 'N';
  // Reset banner
  document.getElementById('prev-disposition').style.display = 'none';
  // Reset all disposition buttons for the current territory
  var config = getDispositions(addr);
  config.forEach(function(d) {
    var el = document.getElementById(d.id);
    if (el) el.className = 'stbtn';
  });
  selStatus = null;
  var nsWrap = document.getElementById('ns-note-wrap');
  var nsNote = document.getElementById('ns-note');
  if (nsWrap) nsWrap.classList.add('hidden');
  if (nsNote) nsNote.value = '';
  resetOutcomeFlags();
  // Update marker and sidebar to reflect cleared status
  if (addr.lat && addr.lng) placeMarker(addr);
  buildList();
  updateAddressStatus(addr, 'pending', '', {
    decisionMakerSpokenTo: 'N',
    followUpNeeded: 'N',
    saleMade: 'N'
  });
  toast('🗑 Disposition cleared', 't-info');
}

// ──────────────────────────────────────────────────────────
//  SALES FORM COLLAPSE / EXPAND
// ──────────────────────────────────────────────────────────
var formCollapsed = false;

function setFormCollapsed(collapsed) {
  formCollapsed = !!collapsed;
  var body = document.querySelector('#panel-form .pf-body');
  var btn  = document.getElementById('pf-collapse-btn');
  if (!body || !btn) return;
  body.style.display = formCollapsed ? 'none' : 'block';
  btn.textContent = formCollapsed ? '▸' : '▾';
  btn.setAttribute('aria-expanded', String(!formCollapsed));
}

function toggleFormCollapse() {
  setFormCollapsed(!formCollapsed);
}

function pickPkg(p) {
  selPkg = p;
  renderPackageCards();
  var megaOffer = getCurrentOffer('mega') || {};
  var gigOffer = getCurrentOffer('gig') || {};
  document.getElementById('pkg-mega').className = 'pkg-card mega-card' + (p === 'mega' ? ' active' : '');
  document.getElementById('pkg-gig').className  = 'pkg-card gig-card'  + (p === 'gig'  ? ' active' : '');
  document.getElementById('btn-mega').disabled  = (p !== 'mega');
  document.getElementById('btn-gig').disabled   = (p !== 'gig');
  document.getElementById('btn-mega').textContent = '⚡ Submit — ' + (megaOffer.package_name || 'Mega Speed');
  document.getElementById('btn-gig').textContent  = '🚀 Submit — ' + (gigOffer.package_name || 'Gig Speed');
  document.getElementById('pricing-box').classList.remove('hidden');
  schedShow();
  calcPricing();
}

// ──────────────────────────────────────────────────────────
//  SCHEDULE PICKER
// ──────────────────────────────────────────────────────────
var SCHED_URL    = ''; // set dynamically by team selection
var SLOT_TIMES   = ['8:00 AM','10:00 AM','1:00 PM','3:00 PM'];
var schedData    = {};
var schedWeekOff = 0;

function schedNormalizeTime(raw) {
  if (!raw) return '';
  var s = String(raw).trim();
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(s)) return s.toUpperCase();
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    return (h % 12 || 12) + ':' + (m === 0 ? '00' : String(m).padStart(2,'0')) + ' ' + ap;
  }
  return s;
}

function schedIsBooked(name) {
  if (!name) return false;
  return /[a-zA-Z0-9]/.test(String(name).trim());
}

function schedToYMD(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0');
}

function schedThisMonday() {
  var t = new Date(); t.setHours(0,0,0,0);
  var day = t.getDay();
  t.setDate(t.getDate() + (day === 0 ? -6 : 1 - day));
  return t;
}

function schedFetch(callback) {
  if (!supabaseWarn()) {
    callback(false);
    return;
  }

  var scheduleTerritory = getScheduleTerritory();
  if (!scheduleTerritory) {
    schedData = {};
    callback(false);
    return;
  }

  fetchScheduleSlotsFromSupabase(scheduleTerritory)
    .then(function(rows) {
      var data = {};
      rows.forEach(function(row) {
        var date = (row.slot_date || '').toString().trim();
        var time = schedNormalizeTime(row.time_label || '');
        if (!date || !time) return;

        if (!data[date]) data[date] = {};
        data[date][time] = {
          cap: Number(row.capacity || 0),
          booked: Number(row.booked_count || 0),
          avail: Math.max(0, Number(row.capacity || 0) - Number(row.booked_count || 0)),
          slotId: row.id,
          territory: row.territory || scheduleTerritory
        };
      });
      schedData = data;
      callback(true);
    })
    .catch(function(err){
      console.error(err);
      callback(false);
    });
}

function schedShow() {
  var scheduleTerritory = getScheduleTerritory();

  document.getElementById('sched-loading').classList.remove('hidden');
  document.getElementById('sched-picker').classList.add('hidden');
  document.getElementById('sched-error').classList.add('hidden');
  document.getElementById('sched-confirmed').classList.add('hidden');
  schedWeekOff = 0;

  schedFetch(function(ok){
    document.getElementById('sched-loading').classList.add('hidden');
    if (!ok) {
      document.getElementById('sched-error').classList.remove('hidden');
      document.getElementById('sched-error').textContent    = '⚠ Could not load schedule' + (scheduleTerritory ? ' for ' + scheduleTerritory : '') + '.';
      return;
    }
    document.getElementById('sched-picker').classList.remove('hidden');
    schedRenderWeek();
  });
}

function schedRenderWeek() {
  var mon = schedThisMonday();
  mon.setDate(mon.getDate() + schedWeekOff * 7);
  var fri = new Date(mon); fri.setDate(mon.getDate() + 4);

  var MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('sched-week-label').textContent =
    MO[mon.getMonth()] + ' ' + mon.getDate() + ' – ' +
    MO[fri.getMonth()] + ' ' + fri.getDate() + ', ' + fri.getFullYear();

  var DAYS = ['Mon','Tue','Wed','Thu','Fri'];
  var grid = document.getElementById('sched-day-grid');
  grid.innerHTML = '';
  var today = new Date(); today.setHours(0,0,0,0);

  for (var di = 0; di < 5; di++) {
    var day = new Date(mon); day.setDate(mon.getDate() + di);
    var key = schedToYMD(day);
    var isPast = day < today;
    var dd = schedData[key] || null;
    var totalAvail = dd ? SLOT_TIMES.reduce(function(s,t){ return s+(dd[t]?dd[t].avail:0); },0) : 0;

    var hdrCls = isPast || !dd ? '' : (totalAvail > 0 ? 'has-open' : 'all-full');
    var hdrCount = isPast ? 'Past' : (!dd ? 'No data' : (totalAvail > 0 ? totalAvail+' open' : 'Full'));

    var slotsHTML = SLOT_TIMES.map(function(t){
      var sd    = dd && dd[t];
      var avail = sd ? sd.avail : -1;
      var isChosen = selSlot && selSlot.date === key && selSlot.time === t;
      var cls, av;
      if (isPast)            { cls='past';   av='—'; }
      else if (!dd || !sd)   { cls='past';   av='—'; }
      else if (isChosen)     { cls='chosen'; av='✓'; }
      else if (avail <= 0)   { cls='full';   av='Full'; }
      else                   { cls='open';   av=avail+' left'; }
      var canClick = !isPast && sd && (avail > 0 || isChosen);
      var onclick  = canClick ? 'onclick="schedPickSlot(\''+key+'\',\''+t+'\')"' : '';
      return '<button class="sched-slot '+cls+'" '+onclick+'>'+
        '<span class="st">'+t.replace(':00','')+'</span>'+
        '<span class="sa">'+av+'</span>'+
        '</button>';
    }).join('');

    grid.innerHTML +=
      '<div class="sched-day">'+
        '<div class="sched-day-hdr '+hdrCls+'">'+
          '<span>'+DAYS[di]+' '+MO[day.getMonth()]+' '+day.getDate()+'</span>'+
          '<span class="sched-avail-count">'+hdrCount+'</span>'+
        '</div>'+
        '<div class="sched-slots">'+slotsHTML+'</div>'+
      '</div>';
  }
}

function schedShiftWeek(dir) {
  schedWeekOff += dir;
  if (schedWeekOff < 0) schedWeekOff = 0;
  schedRenderWeek();
}

function schedPickSlot(date, time) {
  selSlot = { date:date, time:time };
  document.getElementById('f-install-date').value = date;
  document.getElementById('f-install-time').value = time;
  calcPricing();

  var MO   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var d    = new Date(date + 'T12:00:00');
  document.getElementById('sched-conf-date').textContent = DAYS[d.getDay()]+', '+MO[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear();
  document.getElementById('sched-conf-time').textContent = '🕐 '+time;

  document.getElementById('sched-picker').classList.add('hidden');
  document.getElementById('sched-confirmed').classList.remove('hidden');

  var mo = MO[d.getMonth()];
  var megaName = ((getCurrentOffer('mega') || {}).package_name || 'Mega Speed');
  var gigName  = ((getCurrentOffer('gig') || {}).package_name || 'Gig Speed');
  document.getElementById('btn-mega').textContent = '⚡ Submit ' + megaName + ' — '+mo+' '+d.getDate()+' @ '+time;
  document.getElementById('btn-gig').textContent  = '🚀 Submit ' + gigName  + ' — ' +mo+' '+d.getDate()+' @ '+time;
}

function schedClearSlot() {
  selSlot = null;
  document.getElementById('f-install-date').value = '';
  document.getElementById('f-install-time').value = '';
  document.getElementById('sched-confirmed').classList.add('hidden');
  document.getElementById('sched-picker').classList.remove('hidden');
  document.getElementById('proration-section').classList.add('hidden');
  document.getElementById('btn-mega').textContent = '⚡ Submit — ' + ((getCurrentOffer('mega') || {}).package_name || 'Mega Speed');
  document.getElementById('btn-gig').textContent  = '🚀 Submit — ' + ((getCurrentOffer('gig') || {}).package_name || 'Gig Speed');
  schedRenderWeek();
}

function schedBookSlot(date, time, customerName, address) {
  var slot = schedData[date] && schedData[date][time] ? schedData[date][time] : null;
  if (!slot || !slot.slotId) return Promise.resolve(false);

  var teamPayload = getActiveTeamPayload();
  var bookingAddress = getAddr ? getAddr() : null;

  var bookingPayload = {
    schedule_slot_id: slot.slotId,
    address_id: bookingAddress && bookingAddress.id ? bookingAddress.id : null,
    rep_name: repName || '',
    team: teamPayload.team,
    team_slug: teamPayload.team_slug,
    territory: bookingAddress && bookingAddress.territory ? bookingAddress.territory : (slot.territory || activeTerritory || getScheduleTerritory() || ''),
    customer_name: customerName || '',
    phone: (document.getElementById('f-phone') ? document.getElementById('f-phone').value : ''),
    email: (document.getElementById('f-email') ? document.getElementById('f-email').value : ''),
    notes: (document.getElementById('f-notes') ? document.getElementById('f-notes').value : ''),
    status: 'booked'
  };

  function markLocalBooked() {
    if (schedData[date] && schedData[date][time]) {
      schedData[date][time].booked = Number(schedData[date][time].booked || 0) + 1;
      schedData[date][time].avail = Math.max(
        0,
        Number(schedData[date][time].cap || 0) - Number(schedData[date][time].booked || 0)
      );
    }
    var picker = document.getElementById('sched-picker');
    if (picker && !picker.classList.contains('hidden')) schedRenderWeek();
  }

  if (!hasSupabase() || navigator.onLine === false) {
    enqueueOfflineTask('schedule_booking', 'schedule_bookings', bookingPayload, 'Booking: ' + customerName);
    markLocalBooked();
    return Promise.resolve(true);
  }

  return insertSupabaseRow('schedule_bookings', bookingPayload)
    .then(function() {
      markLocalBooked();
      return new Promise(function(resolve) {
        schedFetch(function(ok) {
          var picker = document.getElementById('sched-picker');
          if (ok && picker && !picker.classList.contains('hidden')) schedRenderWeek();
          processOfflineQueue(false);
          resolve(ok);
        });
      });
    })
    .catch(function(err) {
      console.error(err);
      enqueueOfflineTask('schedule_booking', 'schedule_bookings', bookingPayload, 'Booking: ' + customerName);
      markLocalBooked();
      return true;
    });
}

function setText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setHidden(id, hidden) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('hidden', !!hidden);
}

function renderPromoPhaseList(offer) {
  var el = document.getElementById('pr-phase-list');
  if (!el || !offer) return;
  var rows = (offer.phases || []).map(function(p) {
    var price = Number(p.internet_price || 0) === 0 ? '<span class="free-tag">FREE</span>' : money(p.internet_price) + '/mo';
    return '<div class="price-row"><span>' + escHtml(phaseLabel(p)) + '</span><span>' + price + '</span></div>';
  }).join('');
  el.innerHTML = '<div class="price-section-label">Promo Schedule</div>' + rows;
}

function updateChargeRows(offer) {
  var charges = requiredRecurringCharges(offer);
  var modem = charges.find(function(c){ return c.key === 'modem'; }) || { label:'Modem Rental', amount:0 };
  var eero = charges.find(function(c){ return c.key === 'eero'; }) || { label:'eero WiFi Router', amount:0 };
  var processing = charges.find(function(c){ return c.key === 'processing'; }) || { label:'Payment Processing Fee', amount:0 };
  setText('pr-modem-label', modem.label || 'Modem Rental');
  setText('pr-modem', money(modem.amount));
  setText('pr-eero-label', eero.label || 'eero WiFi Router');
  setText('pr-eero', money(eero.amount));
  setText('pr-processing-label', processing.label || 'Payment Processing Fee');
  setText('pr-processing', money(processing.amount));
  setText('pr-first-modem-label', modem.label || 'Modem Rental');
  setText('pr-first-modem', money(modem.amount));
  setText('pr-first-eero-label', eero.label || 'eero WiFi Router');
  setText('pr-first-eero', money(eero.amount));
  setText('pr-first-processing-label', processing.label || 'Payment Processing Fee');
  setText('pr-first-processing', money(processing.amount));
}

function calcPricing() {
  if (!selPkg) return;
  var offer = getCurrentOffer(selPkg);
  if (!offer) return;
  var charges = requiredRecurringCharges(offer);
  var chargeTotal = sumCharges(charges);
  var monthOneInternet = getInternetPriceForMonth(offer, 1);
  var monthOneTotal = monthOneInternet + chargeTotal;

  setText('pr-offer-title', offer.offer_title || offer.package_name || 'Selected Offer');
  renderPromoPhaseList(offer);
  setText('pr-internet', monthOneInternet === 0 ? 'FREE' : money(monthOneInternet));
  setText('pr-first-internet', monthOneInternet === 0 ? 'FREE' : money(monthOneInternet));
  setText('pr-monthly', money(monthOneTotal));
  updateChargeRows(offer);
  setText('pr-firstbill-fees', money(chargeTotal));
  setText('pr-firstbill-total', money(monthOneTotal));
  setText('pr-disclosure', offer.disclosure || 'Pricing is an estimate. Final billing is subject to serviceability, approved promo, equipment selection, taxes, and account setup.');

  var dateEl = document.getElementById('f-install-date');
  var proSection = document.getElementById('proration-section');
  if (!dateEl || !dateEl.value) {
    if (proSection) proSection.classList.add('hidden');
    return;
  }

  var install = new Date(dateEl.value + 'T12:00:00');
  if (isNaN(install.getTime())) {
    if (proSection) proSection.classList.add('hidden');
    return;
  }
  var nextFirst = new Date(install.getFullYear(), install.getMonth() + 1, 1);
  var diffDays = Math.max(0, Math.round((nextFirst - install) / (1000 * 60 * 60 * 24)));
  var daysInMonth = new Date(install.getFullYear(), install.getMonth() + 1, 0).getDate();
  var proratableCharges = charges.filter(function(c){ return c.prorate !== false; });
  var proratedInternet = (monthOneInternet / daysInMonth) * diffDays;
  var proratedCharges  = (sumCharges(proratableCharges) / daysInMonth) * diffDays;
  var prorateToFirstBill = proratedInternet + proratedCharges;

  setText('pr-prorate-label', 'Internet (' + diffDays + ' days @ $' + (monthOneInternet / daysInMonth).toFixed(3) + '/day)');
  setText('pr-prorate-internet', money(proratedInternet));
  setText('pr-prorate-eero-label', 'Prorated recurring equipment/fees (' + diffDays + ' days)');
  setText('pr-prorate-eero', money(proratedCharges));
  setText('pr-prorate-total', money(prorateToFirstBill));
  setText('pr-firstbill-total', money(monthOneTotal + prorateToFirstBill));
  if (proSection) proSection.classList.remove('hidden');
}

function pickStatus(s) {
  selStatus = s;

  // Get the config for the currently open address
  var addr = getAddr();
  var config = getDispositions(addr);

  // Reset all buttons in the current grid
  config.forEach(function(d) {
    var el = document.getElementById(d.id);
    if (el) el.className = 'stbtn';
  });

  // Highlight the selected one
  var entry = config.find(function(d){ return d.label === s; });
  if (entry) {
    var el = document.getElementById(entry.id);
    if (el) el.className = 'stbtn ' + entry.cls;
  }

  var needsNote = entry ? !!entry.needsNote : false;
  var wrap = document.getElementById('ns-note-wrap');
  var note = document.getElementById('ns-note');
  if (wrap && note) {
    if (needsNote) { wrap.classList.remove('hidden'); } else { wrap.classList.add('hidden'); }
    if (!needsNote) note.value = '';
    if (needsNote && entry && entry.notePlaceholder) note.placeholder = entry.notePlaceholder;
  }
}

function fmtPhone(inp) {
  var v = inp.value.replace(/\D/g, '');
  if (v.length >= 10) v = '(' + v.slice(0,3) + ') ' + v.slice(3,6) + '-' + v.slice(6,10);
  inp.value = v;
}

function maybeWriteNewAddrToSheet(addr) {
  return;
  if (!addr._manuallyAdded) return;
  if (!supabaseWarn()) return;

  var oldId = addr.id;
  supabaseClient
    .from('addresses')
    .insert([{
      external_location_id: addr.externalLocationId || null,
      territory: addr.territory || activeTerritory || '',
      address1: addr.address || '',
      city: addr.city || '',
      state: addr.state || '',
      postal_code: addr.zip || '',
      lat: addr.lat != null ? addr.lat : null,
      lng: addr.lng != null ? addr.lng : null,
      technology: addr.technology || null,
      serviceability: addr.serviceability || null,
      customer_status: addr.activeCount || null,
      updated_at: new Date().toISOString()
    }])
    .select()
    .then(function(res) {
      if (res.error) throw res.error;
      if (res.data && res.data[0]) {
        addr.id = res.data[0].id;
        if (activeId === oldId) activeId = addr.id;
        if (activeAddressSnapshot && activeAddressSnapshot.id === oldId) activeAddressSnapshot.id = addr.id;
      }
    })
    .catch(function(err) {
      console.error(err);
    });
}

function boolToYN(val) {
  return val ? 'Y' : 'N';
}

function ynToBool(val) {
  return String(val || '').trim().toUpperCase() === 'Y';
}

function getOutcomeFlags(isSale) {
  var decisionEl = document.getElementById('f-decision-maker');
  var followEl   = document.getElementById('f-followup-needed');
  return {
    decisionMakerSpokenTo: boolToYN(isSale ? true : !!(decisionEl && decisionEl.checked)),
    followUpNeeded:        boolToYN(!!(followEl && followEl.checked)),
    saleMade:              boolToYN(!!isSale)
  };
}

function setOutcomeFlags(flags) {
  var decisionEl = document.getElementById('f-decision-maker');
  var followEl   = document.getElementById('f-followup-needed');
  if (decisionEl) decisionEl.checked = ynToBool(flags && flags.decisionMakerSpokenTo);
  if (followEl)   followEl.checked   = ynToBool(flags && flags.followUpNeeded);
}

function resetOutcomeFlags() {
  setOutcomeFlags({
    decisionMakerSpokenTo: 'N',
    followUpNeeded: 'N'
  });
}

// ──────────────────────────────────────────────────────────
//  SUBMIT
// ──────────────────────────────────────────────────────────
function getAddr() {
  // Prefer the stable selected-address key over the temporary numeric id.
  // GPS/route refreshes can rebuild addresses[] and reuse ids for different houses.
  if (activeAddressKey) {
    var locked = findAddressByKey_(activeAddressKey);
    if (locked) {
      activeId = locked.id;
      applyLockedCoords_(locked);
      return locked;
    }
    // If the rep moved and the GPS radius no longer returns the selected house,
    // keep using the snapshot captured when the pin/form was opened.
    if (activeAddressSnapshot) return activeAddressSnapshot;
  }
  for (var i = 0; i < addresses.length; i++) {
    if (addresses[i].id === activeId) return addresses[i];
  }
  return null;
}

async function submitSale(pkgLabel) {
  var addr = getAddr();
  if (!addr) { toast('No address selected', 't-err'); return; }

  var first   = document.getElementById('f-first').value.trim();
  var last    = document.getElementById('f-last').value.trim();
  var phone   = document.getElementById('f-phone').value.trim();
  var email   = document.getElementById('f-email').value.trim();
  var notes   = document.getElementById('f-notes').value.trim();
  var install = document.getElementById('f-install-date').value;

  if (!first || !last || !phone) {
    toast('⚠ Please fill in First Name, Last Name, and Phone', 't-err');
    return;
  }

  var offer = getCurrentOffer(selPkg);
  if (!offer) {
    toast('⚠ No offer found for selected package', 't-err');
    return;
  }
  var offerSnapshot = buildSelectedOfferSnapshot(selPkg, install);
  var pricingSummary = pricingSummaryText(offerSnapshot);

  applyLockedCoords_(addr);
  var outcomeFlags = getOutcomeFlags(true);
  var payload = {
    territory: (addr.territory || activeTerritory || ''),
    sheetRow: addr.sheetRow || null,
    lat: addr.lat != null ? addr.lat : '',
    lng: addr.lng != null ? addr.lng : '',
    salesperson: repName,
    repPhone: repPhone,
    repEmail: repEmail,
    repWebsite: repWebsite,
    address: addr.address, city: addr.city||'', state: addr.state||'', zip: addr.zip||'',
    firstName: first, lastName: last, phone: phone, email: email,
    package: pricingSummary,
    packageName: offer.package_name || ((selPkg === 'gig') ? 'Gig Speed Internet' : 'Mega Speed Internet'),
    internetSpeed: offer.speed_label || ((selPkg === 'gig') ? '1000/1000 Mbps' : '400/400 Mbps'),
    promoPrice: offerSnapshot ? offerSnapshot.promo_display : (offer.promo_display || ''),
    promoTerm: offerSnapshot ? offerSnapshot.promo_term_label : (offer.promo_term_label || ''),
    standardRate: offerSnapshot ? offerSnapshot.standard_rate_label : (offer.standard_rate_label || ''),
    promoEffectiveDate: offer.active_start || '',
    offerId: offerSnapshot ? offerSnapshot.offer_id : (offer.id || null),
    offerCode: offerSnapshot ? offerSnapshot.offer_code : (offer.offer_code || ''),
    offerSnapshot: offerSnapshot,
    installDate: selSlot ? selSlot.date : (install || ''),
    installTime: selSlot ? selSlot.time : '',
    notes: notes,
    status: 'Sale — ' + (offer.package_name || pkgLabel),
    standardizedOutcome: getStandardizedOutcomeLabel((selPkg === 'mega') ? 'mega' : 'gig'),
    softInterestType: '',
    decisionMakerSpokenTo: outcomeFlags.decisionMakerSpokenTo,
    followUpNeeded: outcomeFlags.followUpNeeded,
    saleMade: outcomeFlags.saleMade
  };

  addr.status = (selPkg === 'mega') ? 'mega' : 'gig';
  addr.salesperson = repName;
  addr.note   = (notes || '').trim();
  addr.decisionMakerSpokenTo = outcomeFlags.decisionMakerSpokenTo;
  addr.followUpNeeded = outcomeFlags.followUpNeeded;
  addr.saleMade = outcomeFlags.saleMade;

  var saleSaved = await sendData(payload);
  if (!saleSaved) return;
  maybeWriteNewAddrToSheet(addr);

  if (selSlot) {
    var fullAddress = addr.address + (addr.city ? ', ' + addr.city : '') + (addr.state ? ', ' + addr.state : '');
    schedBookSlot(selSlot.date, selSlot.time, first + ' ' + last, fullAddress);
  }

  addr.sale   = { firstName: first, lastName: last, phone: phone, email: email, notes: notes };
  await updateAddressStatus(addr, addr.status, notes, outcomeFlags);
  if (addr.lat && addr.lng) placeMarker(addr);
  updateStats();
  buildList((document.getElementById('addr-search') && document.getElementById('addr-search').value) || null);
  refreshMapMarkers();
  sendHeartbeat();
  toast('✅ ' + (offer.package_name || pkgLabel) + ' sold to ' + first + ' ' + last + '!', 't-ok');
  closeForm();
}

async function submitStatus() {
  var addr = getAddr();
  if (!addr)      { toast('No address selected', 't-err'); return; }
  if (!selStatus) { toast('⚠ Pick a status first', 't-err'); return; }

  var nsWrap  = document.getElementById('ns-note-wrap');
  var nsNote  = document.getElementById('ns-note');
  var notes   = (nsWrap && !nsWrap.classList.contains('hidden') && nsNote)
    ? (nsNote.value || '').trim()
    : '';
  var outcomeFlags = normalizeOutcomeFlagsForStatus(selStatus ? (DISPOSITIONS.find(function(d){ return d.label === selStatus; }) || {}).status : '', getOutcomeFlags(false));
  var mappedStatus = selStatus ? (DISPOSITIONS.find(function(d){ return d.label === selStatus; }) || {}).status : '';
  applyLockedCoords_(addr);
  var standardizedOutcome = getStandardizedOutcomeLabel(mappedStatus);
  var softInterestType = getSoftInterestType(mappedStatus);
  var payload = {
    salesperson: repName,
    address: addr.address, city: addr.city||'', state: addr.state||'', zip: addr.zip||'',
    sheetRow: addr.sheetRow || null,
    lat: addr.lat != null ? addr.lat : '',
    lng: addr.lng != null ? addr.lng : '',
    firstName:'', lastName:'', phone:'', email:'',
    package:'', notes: notes,
    status: selStatus,
    standardizedOutcome: standardizedOutcome,
    softInterestType: softInterestType,
    decisionMakerSpokenTo: outcomeFlags.decisionMakerSpokenTo,
    followUpNeeded: outcomeFlags.followUpNeeded,
    saleMade: outcomeFlags.saleMade
  };

  // Build label→status map from unified config
  var smap = {};
  DISPOSITIONS.forEach(function(d) {
    smap[d.label] = d.status;
  });
  addr.status = mappedStatus || smap[selStatus] || 'nocontact';
  addr.standardizedOutcome = standardizedOutcome;
  addr.softInterestType = softInterestType;
  addr.salesperson = repName;
  addr.note = notes || '';
  addr.decisionMakerSpokenTo = outcomeFlags.decisionMakerSpokenTo;
  addr.followUpNeeded = outcomeFlags.followUpNeeded;
  addr.saleMade = outcomeFlags.saleMade;

  // NOTE: sendData() is intentionally NOT called here — no-sale statuses
  // should never go to recordSale(). Only updateAddressStatus() is needed
  // to write the status + note to the Addresses tab.
  maybeWriteNewAddrToSheet(addr);
  var statusSaved = await updateAddressStatus(addr, addr.status, notes, outcomeFlags);
  if (!statusSaved) return;
  if (addr.lat && addr.lng) placeMarker(addr);
  updateStats();
  buildList((document.getElementById('addr-search') && document.getElementById('addr-search').value) || null);
  refreshMapMarkers();
  toast('📋 "' + selStatus + '" logged', 't-info');
  var nsNoteEl = document.getElementById('ns-note');
  if (nsNoteEl) nsNoteEl.value = '';
  closeForm();
}

async function updateAddressStatus(addr, status, note, flags) {
  var outcomeFlags = flags || {
    decisionMakerSpokenTo: addr.decisionMakerSpokenTo || 'N',
    followUpNeeded: addr.followUpNeeded || 'N',
    saleMade: addr.saleMade || 'N'
  };

  if (!addr || !addr.id) return false;

  var nowIso = new Date().toISOString();
  var teamPayload = getActiveTeamPayload();

  var eventPayload = {
    address_id: addr.id,
    rep_name: repName,
    team: teamPayload.team,
    team_slug: teamPayload.team_slug,
    territory: (addr.territory || activeTerritory || ''),
    status: status,
    note: (note || ''),
    knocked_at: nowIso,
    created_at: nowIso,
    decision_maker_spoken_to: outcomeFlags.decisionMakerSpokenTo === 'Y',
    follow_up_needed: outcomeFlags.followUpNeeded === 'Y',
    sale_made: outcomeFlags.saleMade === 'Y'
  };

  if (addr.lat != null && addr.lng != null) {
    eventPayload.lat = Number(addr.lat);
    eventPayload.lng = Number(addr.lng);
  }

  if (!hasSupabase() || navigator.onLine === false) {
    enqueueOfflineTask('address_event', 'address_events', eventPayload, 'Disposition: ' + status);
    return true;
  }

  try {
    await insertSupabaseRow('address_events', eventPayload);
    processOfflineQueue(false);
    return true;
  } catch (err) {
    console.error(err);
    enqueueOfflineTask('address_event', 'address_events', eventPayload, 'Disposition: ' + status);
    return true;
  }
}

async function sendData(payload) {
  var addr = getAddr ? getAddr() : null;
  var fullName = ((payload.firstName || '') + ' ' + (payload.lastName || '')).trim();

  var teamPayload = getActiveTeamPayload();
  var saleTerritory = addr && addr.territory ? addr.territory : (activeTerritory || getScheduleTerritory() || '');

  var salesPayload = {
    address_id: addr && addr.id ? addr.id : null,
    rep_name: repName || '',
    team: teamPayload.team,
    team_slug: teamPayload.team_slug,
    territory: saleTerritory,
    customer_name: fullName,
    phone: payload.phone || '',
    email: payload.email || '',
    package_name: payload.package || payload.packageName || '',
    install_date: payload.installDate || null,
    install_time: payload.installTime || '',
    notes: payload.notes || payload.note || '',
    offer_id: payload.offerId || null,
    offer_snapshot: payload.offerSnapshot || null,
    monthly_total: payload.offerSnapshot ? payload.offerSnapshot.month_one_total : null,
    first_bill_estimate: payload.offerSnapshot ? payload.offerSnapshot.first_bill_estimate : null,
    promo_price: payload.promoPrice || '',
    promo_term: payload.promoTerm || '',
    standard_rate: payload.standardRate || ''
  };

  if (!hasSupabase() || navigator.onLine === false) {
    enqueueOfflineTask('sales_order', 'sales_orders', salesPayload, 'Sale: ' + fullName);
    return true;
  }

  try {
    await insertSupabaseRow('sales_orders', salesPayload);
    processOfflineQueue(false);
    return true;
  } catch (err) {
    console.error(err);
    enqueueOfflineTask('sales_order', 'sales_orders', salesPayload, 'Sale: ' + fullName);
    return true;
  }
}

// ──────────────────────────────────────────────────────────
//  STATS
// ──────────────────────────────────────────────────────────
function updateStats() {
  // Total = ALL homes passed (entire fiber footprint, including existing Zito customers)
  document.getElementById('st-total').textContent = addresses.length;
  var knockable = addresses.filter(isKnockable);
  document.getElementById('st-sched').textContent = addresses.filter(function(a){ return a.status==='mega' || a.status==='gig'; }).length;
  document.getElementById('st-pend').textContent  = knockable.filter(function(a){
    var s = (a.status||'').toLowerCase();
    return !s || s === 'pending' || s === 'homes passed';
  }).length;
  // Show unique territory count in topbar for managers
  if (isManager && isManager()) {
    var territories = {};
    addresses.forEach(function(a){ if (a.territory) territories[a.territory] = true; });
    var tCount = Object.keys(territories).length;
    var stSched = document.getElementById('st-sched');
    if (stSched && tCount > 0) {
      stSched.parentElement.title = tCount + ' territories loaded';
    }
  }
  updateOfflineQueueUI();
  renderGamePlan();
}

// ──────────────────────────────────────────────────────────
//  MANAGER — Kasey Pelchy only
// ──────────────────────────────────────────────────────────
var MANAGER_NAMES  = ['kasey pelchy', 'james rigas', 'chris ruding']; // ← add more names here, all lowercase
var heartbeatTimer = null;
var mgrAutoRefresh = null;

function isManager() { return false; }

function initManagerAccess() {}

function sendHeartbeat(statusOverride) {
  return;
}

function startHeartbeat() {
  if (isManager()) return;
  sendHeartbeat();
  heartbeatTimer = setInterval(function() {
    if (repOnline) sendHeartbeat();
  }, 120000);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

window.addEventListener('beforeunload', function() {
  if (!isManager()) sendHeartbeat('offline');
});

function openSignOutConfirm() {
  document.getElementById('signout-confirm').classList.add('open');
}
function closeSignOutConfirm() {
  document.getElementById('signout-confirm').classList.remove('open');
}
function confirmSignOut() {
  closeSignOutConfirm();
  sendHeartbeat('offline');
  stopHeartbeat();
  setTimeout(function() {
    repName   = 'Rep';
    try { localStorage.removeItem('fieldos_session_start'); } catch(e) {}
    repOnline = false;
    addresses = [];
    clearActiveAddressLock();
    selPkg    = null;
    selStatus = null;
    selSlot   = null;
    clearInterval(heartbeatTimer);
    stopScheduleRealtime();
    if (mapObj) { mapObj.remove(); mapObj = null; }

    document.getElementById('page-app').style.display   = 'none';
    document.getElementById('page-setup').style.display = 'flex';
    document.getElementById('rep-name').value = '';
    repPhone = '';
    repEmail = '';
    try { localStorage.removeItem('zito_rep_name'); localStorage.removeItem('zito_rep_phone'); localStorage.removeItem('zito_rep_email'); localStorage.removeItem('fieldos_team'); } catch(e) {}
    document.getElementById('launch-btn').disabled = true;
    var fetchStatusEl = document.getElementById('fetch-addr-status');
    if (fetchStatusEl) fetchStatusEl.textContent = '';
    activeTeam = '';
    webhookURL = '';
    SCHED_URL  = '';
    activeTerritory = '';
    activeTerritories = [];
    var teamSel = document.getElementById('team-select');
    if (teamSel) teamSel.value = '';
    applyPresetTeamFromURL();
    checkLaunchReady();

    toast('👋 Signed out successfully', 't-info');
  }, 400);
}

function hideAppForDirectAccess() {
  document.body.innerHTML = '';
  document.body.style.background = '#0d1117';
}

function requireTeamInURL() {
  var presetTeam = getPresetTeamNameFromURL();
  if (!presetTeam || !TEAMS[presetTeam]) {
    hideAppForDirectAccess();
    return false;
  }
  return true;
}

function restoreRepProfile() {
  // Populate team dropdown from TEAMS config
  var sel = document.getElementById('team-select');
  if (sel && sel.options.length <= 1) {
    Object.keys(TEAMS).forEach(function(name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  }

  try {
    var presetTeam = getPresetTeamNameFromURL();
    var t = presetTeam || '';
    var n = localStorage.getItem('zito_rep_name')  || '';
    var p = localStorage.getItem('zito_rep_phone') || '';
    var e = localStorage.getItem('zito_rep_email') || '';
    if (t && TEAMS[t]) {
      activeTeam = t;
      webhookURL = '';
      SCHED_URL  = '';
      if (sel) sel.value = t;
    }
    if (n && document.getElementById('rep-name')) document.getElementById('rep-name').value = n;
    if (p) repPhone = p;
    if (e) repEmail = e;
  } catch(err) {}

  applyPresetTeamFromURL();
  checkLaunchReady();
}

window.addEventListener('load', function() {
  try {
    if (!requireTeamInURL()) return;
    restoreRepProfile();
    renderPackageCards();
  } catch(e) {}
});

function emailCustomerOffer(pkgKey) {
  var to = '';
  var custEmailEl = document.getElementById('f-email');
  if (custEmailEl) to = (custEmailEl.value || '').trim();
  if (!to) to = prompt('Customer email address to send the package info to:');
  if (!to) return;

  var rep = repName || 'Zito FieldOS';
  var rp  = repPhone || '';
  var re  = repEmail || '';
  var offer = getCurrentOffer(pkgKey) || DEFAULT_PRICING_OFFERS[pkgKey];
  var snapshot = buildSelectedOfferSnapshot(pkgKey, (document.getElementById('f-install-date') || {}).value || '');
  var pkg = {
    name: offer.package_name || (pkgKey === 'gig' ? 'Gig Speed Internet' : 'Mega Speed Internet'),
    speed: offer.speed_label || '',
    promo: offer.promo_display || '',
    term: offer.promo_term_label || '',
    reg: offer.standard_rate_label || ''
  };

  var custFirst = '';
  var fn = document.getElementById('f-first');
  if (fn) custFirst = (fn.value || '').trim();

  var greet = custFirst ? ('Hi ' + custFirst + ',') : 'Hi there,';
  var subject = 'Zito Fiber Internet Package Details — ' + pkg.name;

  var bodyLines = [
    greet,
    '',
    'Here are the Zito Fiber details we discussed:',
    '',
    pkg.name,
    'Speed: ' + pkg.speed,
    'Promo: ' + pkg.promo,
    'Promo Schedule: ' + offerPhaseSummary(offer),
    pkg.reg ? ('Regular Rate / After Promo: ' + pkg.reg) : '',
    '',
    'Required Monthly Charges: ' + money(snapshot ? snapshot.recurring_charges_total : sumCharges(requiredRecurringCharges(offer))),
    'Estimated First Bill: ' + money(snapshot ? snapshot.first_bill_estimate : 0),
    '',
    'Ready to get started? Reply to this email and I can help schedule your install.',
    '',
    'Thanks,',
    rep + (rp ? (' | ' + rp) : ''),
    (re ? re : ''),
    repWebsite
  ];

  var mailto = 'mailto:' + encodeURIComponent(to)
    + '?subject=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(bodyLines.join('\n'));

  window.location.href = mailto;
}

function refreshMapMarkers() {
  if (!mapObj) return;

  // Clear all markers from the cluster group in one shot (much faster than
  // removing them one at a time from the map directly)
  if (clusterGroup) {
    clusterGroup.clearLayers();
  } else {
    Object.keys(mapMarkers).forEach(function(k){
      try { mapObj.removeLayer(mapMarkers[k]); } catch(e) {}
    });
  }
  mapMarkers = {};

  // Batch-add all markers to the cluster group at once.
  // L.markerClusterGroup.addLayers() is far faster than calling
  // addLayer() in a loop — it does a single internal reindex.
  var toAdd = [];
  (addresses || []).forEach(function(a){
    if (!a || a.lat == null || a.lng == null) return;

    if (activeDispoFilter) {
  var s = (a.status || '').toLowerCase().trim();
  var shape = getMarkerShape(a);

  var isPending = s === 'pending';
  var isHomesPassed = shape === 'house';
  var isActiveCustomer = shape === 'bolt';

  var matchesDisposition = false;
  if (activeDispoFilter === 'nothome') {
    matchesDisposition = (
      s === 'nothome' ||
      s === 'nothome2' ||
      s === 'nothome3' ||
      s === 'nothome4'
    );
  } else {
    matchesDisposition = s === activeDispoFilter;
  }

  if (!matchesDisposition && !isPending && !isHomesPassed && !isActiveCustomer) return;
}

    // Territory tab filter
    if (activeTerritoryTab) {
      if ((a.territory || '').trim() !== activeTerritoryTab) return;
    }

    var color  = getMarkerColor(a);
    var shape  = getMarkerShape(a);
    var html   = markerHTML(color, shape);
    var size   = shape === 'house' ? [26,26] : shape === 'bolt' ? [20,28] : [16,16];
    var anchor = shape === 'house' ? [13,26] : shape === 'bolt' ? [10,28] : [8,8];
    var icon   = L.divIcon({ className:'', html: html, iconSize: size, iconAnchor: anchor });
    var m      = L.marker([a.lat, a.lng], { icon: icon });
    var pid    = a.id;
    m.bindPopup(function() {
      var shape2  = getMarkerShape(a);
      var safePid = String(pid).replace(/'/g, "\\'");
      var btnHTML = shape2 === 'bolt'
        ? '<button class="pop-open-btn pop-active-btn" onclick="openFormFromMap(\'' + safePid + '\')">⚡ View Address</button>'
        : '<button class="pop-open-btn" onclick="openFormFromMap(\'' + safePid + '\')">Open Sales Form</button>';
      return '<div style="font-family:Syne,sans-serif;min-width:160px">' +
        popupHtmlForAddr(a) + btnHTML + '</div>';
    }, { minWidth: 180 });
    mapMarkers[a.id] = m;
    toAdd.push(m);
  });

  if (clusterGroup) clusterGroup.addLayers(toAdd);
}

function openManagerPanel() {}
function closeManagerPanel() {}

// ── Tab switching ─────────────────────────────────────────
function switchMgrTab(tab, btn) {
  document.querySelectorAll('.mgr-tab-panel').forEach(function(p){ p.classList.remove('active'); });
  document.querySelectorAll('.mgr-tab').forEach(function(b){ b.classList.remove('active'); });
  var panel = document.getElementById('mgr-tab-' + tab);
  if (panel) panel.classList.add('active');
  if (btn)   btn.classList.add('active');

  if (tab === 'analytics') renderAnalyticsTab();
  if (tab === 'coverage')  renderCoverageTab();
  if (tab === 'forecast')  renderForecastTab();
  if (tab === 'territory') renderTerritoryTab();
  if (tab === 'ai')        renderAITab();
}
function refreshManagerPanel() {
  var btn = document.getElementById('mgr-refresh-btn');
  btn.classList.add('spinning');
  setTimeout(function(){ btn.classList.remove('spinning'); }, 500);

  fetch(webhookURL + '?action=repStatus&_t=' + Date.now())
    .then(function(r){ return r.json(); })
    .then(function(json){ renderRepList(json.reps || []); })
    .catch(function(){
      document.getElementById('mgr-rep-list').innerHTML =
        '<div class="mgr-empty"><div class="mgr-empty-icon">🔌</div>' +
        '<div class="mgr-empty-txt">Could not load rep data.<br>Make sure the Apps Script is deployed with the repStatus handler.</div></div>';
      updateMgrSummary(0, 0, 0);
      updateMgrPerformance({ doorsWorked:0,totalSales:0,megaSales:0,gigSales:0,onlineReps:0,activeHours:0 });
    });

  var now = new Date();
  document.getElementById('mgr-last-refresh').textContent =
    'Refreshed ' + now.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function renderRepList(reps) {
  var onlineReps  = reps.filter(function(r){ return r.status === 'online'; });
  var offlineReps = reps.filter(function(r){ return r.status !== 'online'; });

  var megaTotal = reps.reduce(function(s,r){ return s + (Number(r.megaSales)||0); }, 0);
  var gigTotal  = reps.reduce(function(s,r){ return s + (Number(r.gigSales)||0); }, 0);
  var totalSales = reps.reduce(function(s,r){ return s + (Number(r.totalSales)||0); }, 0);

  var doorsWorked = reps.reduce(function(s,r){
    return s + (Number(r.doorsWorked)||0);
  }, 0);
  if (!doorsWorked && totalSales) doorsWorked = totalSales * 3;

  var nowMs = Date.now();
  var activeHours = onlineReps.reduce(function(s,r){
    var t0 = r.firstSeen ? new Date(r.firstSeen).getTime()
            : (r.lastSeen ? new Date(r.lastSeen).getTime() : nowMs);
    var hrs = Math.max((nowMs - t0) / 3600000, 0);
    return s + Math.max(hrs, 0.25);
  }, 0);

  updateMgrSummary(onlineReps.length, offlineReps.length, totalSales);
  updateMgrPerformance({
    doorsWorked: doorsWorked,
    totalSales: totalSales,
    megaSales: megaTotal,
    gigSales: gigTotal,
    onlineReps: onlineReps.length,
    activeHours: activeHours
  });

  if (reps.length === 0) {
    document.getElementById('mgr-rep-list').innerHTML =
      '<div class="mgr-empty"><div class="mgr-empty-icon">📡</div>' +
      '<div class="mgr-empty-txt">No reps have checked in yet.<br>Status updates appear here once reps log in.</div></div>';
    return;
  }

  var sorted = onlineReps.concat(offlineReps).sort(function(a,b){
    if (a.status==='online' && b.status!=='online') return -1;
    if (a.status!=='online' && b.status==='online') return  1;
    return (a.name||'').localeCompare(b.name||'');
  });

  document.getElementById('mgr-rep-list').innerHTML = sorted.map(function(rep) {
    var isOn    = rep.status === 'online';
    var parts   = (rep.name||'Rep').trim().split(/\s+/);
    var initials = parts.length >= 2
      ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase()
      : (rep.name||'?').slice(0,2).toUpperCase();
    var lastSeen   = rep.lastSeen ? timeAgo(rep.lastSeen) : 'No activity';
    var mega       = Number(rep.megaSales)||0;
    var gig        = Number(rep.gigSales)||0;
    var total      = Number(rep.totalSales)||(mega+gig);
    var salesStr   = total + ' sale' + (total===1?'':'s');
    if (mega||gig) salesStr += ' (' + mega + ' Mega / ' + gig + ' Gig)';

    return '<div class="mgr-rep-card ' + (isOn?'rep-online':'rep-offline') + '">' +
      '<div class="mgr-rep-avatar">' + escHtml(initials) + '</div>' +
      '<div class="mgr-rep-info">' +
        '<div class="mgr-rep-name">' + escHtml(rep.name||'Unknown') + '</div>' +
        '<div class="mgr-rep-meta">Last seen: ' + lastSeen + '</div>' +
        (!isOn && rep.signOutTime ? '<div class="mgr-signout-time">Signed out ' + timeAgo(rep.signOutTime) + '</div>' : '') +
      '</div>' +
      '<div class="mgr-rep-right">' +
        '<div class="mgr-status-badge ' + (isOn?'online':'offline') + '">' +
          '<span class="mgr-status-dot"></span>' + (isOn?'ONLINE':'OFFLINE') +
        '</div>' +
        '<div class="mgr-rep-sales">' + escHtml(salesStr) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function updateMgrSummary(online, offline, sales) {
  document.getElementById('mgr-count-online').textContent  = online;
  document.getElementById('mgr-count-offline').textContent = offline;
  document.getElementById('mgr-count-sales').textContent   = sales;
}

function updateMgrPerformance(metrics) {
  var doors   = Number(metrics.doorsWorked) || 0;
  var sales   = Number(metrics.totalSales)  || 0;
  var mega    = Number(metrics.megaSales)   || 0;
  var gig     = Number(metrics.gigSales)    || 0;
  var online  = Number(metrics.onlineReps)  || 0;
  var hours   = Number(metrics.activeHours) || 0;

  var closeRate = (doors > 0) ? (sales / doors) : 0;
  var pace = (hours > 0) ? (sales / hours) : 0;
  var denom = (mega + gig);
  var gigMix = (denom > 0) ? (gig / denom) : 0;
  var spr = (online > 0) ? (sales / online) : 0;

  function pct(x){ return Math.round(x * 100) + '%'; }
  function num1(x){ return (Math.round(x * 10) / 10).toFixed(1); }

  var elClose   = document.getElementById('mgr-m-close');
  var elPace    = document.getElementById('mgr-m-pace');
  var elGigMix  = document.getElementById('mgr-m-gigmix');
  var elSPR     = document.getElementById('mgr-m-spr');

  if (elClose)  elClose.textContent  = (doors > 0) ? pct(closeRate) : '—';
  if (elPace)   elPace.textContent   = (hours > 0) ? num1(pace) : '—';
  if (elGigMix) elGigMix.textContent = (denom > 0) ? pct(gigMix) : '—';
  if (elSPR)    elSPR.textContent    = (online > 0) ? num1(spr) : '—';

  var closeSub = document.getElementById('mgr-m-close-sub');
  var paceSub  = document.getElementById('mgr-m-pace-sub');
  var mixSub   = document.getElementById('mgr-m-gigmix-sub');
  var sprSub   = document.getElementById('mgr-m-spr-sub');

  if (closeSub) closeSub.textContent = (doors > 0) ? (sales + ' sales / ' + doors + ' worked') : 'No door activity reported';
  if (paceSub)  paceSub.textContent  = (hours > 0) ? ('Across ' + online + ' online rep' + (online===1?'':'s')) : '—';
  if (mixSub)   mixSub.textContent   = (denom > 0) ? (gig + ' Gig • ' + mega + ' Mega') : 'No sales reported';
  if (sprSub)   sprSub.textContent   = (online > 0) ? ('Online reps only') : '—';
}

// ══════════════════════════════════════════════════════════
//  TIER 1 ANALYTICS — Tab renderers
// ══════════════════════════════════════════════════════════

// ── Helpers ────────────────────────────────────────────────
function pct(x) { return Math.round(x * 100) + '%'; }
function usd(n) {
  return '$' + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Status label map for display
var STATUS_LABELS = {
  mega:          'Mega Sale',
  gig:           'Gig Sale',
  nothome:       'Not Home',
  fibercompetitor:   'Fiber Competitor',
  incontract:    'In Contract',
  notinterested: 'Not Interested',
  goback:        'Go Back Later',
  vacant:        'Vacant',
  business:      'Business',
  pending:       'Pending / Untouched',
  nocontact:     'No Contact',
  // Bryson City
  nothome2:      'Not Home ×2',
  nothome3:      'Not Home ×3',
  nothome4:      'Not Home ×4',
  competitor:    'Competitor',
  activecustomer:'Active Customer'
};

// ── Analytics Tab ──────────────────────────────────────────
function renderAnalyticsTab() {
  renderTodChart();
  renderStatusBars();
  renderCompetitor();
  renderLeaderboard();
}

// 1. Time-of-day knock chart
// Uses knockedAt stored on each address object (set when rep submits a status).
// Falls back to graceful empty state when no hourly data exists yet.
function renderTodChart() {
  var hourSales = new Array(24).fill(0);
  var hourKnocks = new Array(24).fill(0);

  addresses.forEach(function(a) {
    if (!a.knockedAt) return;
    var h = new Date(a.knockedAt).getHours();
    if (h < 0 || h > 23) return;
    hourKnocks[h]++;
    if (a.status === 'mega' || a.status === 'gig') hourSales[h]++;
  });

  // Only show 7am–9pm (hours 7–21) — the realistic knock window
  var hours   = [];
  var labels  = [];
  for (var h = 7; h <= 21; h++) {
    hours.push(h);
    labels.push(h < 12 ? h + 'a' : h === 12 ? '12p' : (h-12) + 'p');
  }

  var maxRate = 0;
  var rates   = hours.map(function(h) {
    var rate = hourKnocks[h] > 0 ? hourSales[h] / hourKnocks[h] : 0;
    if (rate > maxRate) maxRate = rate;
    return { h: h, rate: rate, knocks: hourKnocks[h], sales: hourSales[h] };
  });

  var chartEl  = document.getElementById('ana-tod-chart');
  var labelEl  = document.getElementById('ana-tod-labels');
  if (!chartEl || !labelEl) return;

  var totalKnocks = hourKnocks.reduce(function(s,v){ return s+v; }, 0);
  if (totalKnocks === 0) {
    chartEl.innerHTML = '<div style="width:100%;text-align:center;padding:20px 0;font-size:11px;color:var(--muted)">No knock data yet — data populates as reps log door contacts</div>';
    labelEl.innerHTML = '';
    return;
  }

  chartEl.innerHTML = rates.map(function(r) {
    var heightPct = maxRate > 0 ? Math.max((r.rate / maxRate) * 100, r.knocks > 0 ? 5 : 1) : 2;
    var color = r.rate >= 0.15 ? '#10b981'
              : r.rate >= 0.08 ? '#facc15'
              : r.knocks > 0   ? '#d97706'
              : 'rgba(255,255,255,.08)';
    var label = r.knocks > 0 ? pct(r.rate) : '';
    return '<div class="tod-bar-wrap">' +
      '<div class="tod-bar" style="height:' + heightPct + '%;background:' + color + '">' +
        (label ? '<div class="tod-bar-val">' + label + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  labelEl.innerHTML = labels.map(function(l) {
    return '<span>' + l + '</span>';
  }).join('');
}

// 2. Status breakdown horizontal bars
function renderStatusBars() {
  var el = document.getElementById('ana-status-bars');
  if (!el) return;

  var counts = {};
  var worked = addresses.filter(function(a) {
    var s = (a.status || 'pending').toLowerCase();
    return s !== 'pending' && s !== '' && s !== 'homes passed';
  });

  worked.forEach(function(a) {
    var s = (a.status || 'unknown').toLowerCase();
    counts[s] = (counts[s] || 0) + 1;
  });

  if (worked.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:16px;font-size:11px;color:var(--muted)">No doors worked yet this session</div>';
    return;
  }

  var sorted = Object.keys(counts).sort(function(a,b){ return counts[b]-counts[a]; });

  el.innerHTML = sorted.map(function(s) {
    var color = COLORS[s] || '#6b7280';
    var widthPct = (counts[s] / worked.length) * 100;
    var label = STATUS_LABELS[s] || s;
    return '<div class="sb-row">' +
      '<div class="sb-header">' +
        '<span class="sb-label">' + label + '</span>' +
        '<span class="sb-count">' + counts[s] + ' (' + pct(counts[s]/worked.length) + ')</span>' +
      '</div>' +
      '<div class="sb-track"><div class="sb-fill" style="width:' + widthPct + '%;background:' + color + '"></div></div>' +
    '</div>';
  }).join('');
}

// 3. Competitor landscape — who do prospects already have?
function renderCompetitor() {
  var el = document.getElementById('ana-competitor');
  if (!el) return;

  // Only count knockable homes — existing customers are a separate universe
  var knockable = addresses.filter(isKnockable);
  var total     = knockable.length;
  var bspeed    = knockable.filter(function(a){ return a.status === 'fibercompetitor'; }).length;
  var incon     = knockable.filter(function(a){ return a.status === 'incontract'; }).length;
  var sold      = knockable.filter(function(a){ return a.status === 'mega' || a.status === 'gig'; }).length;
  var avail     = knockable.filter(function(a){
    var s = (a.status || 'pending').toLowerCase();
    return !s || s === 'pending' || s === 'nothome' || s === 'goback' || s === 'nocontact';
  }).length;

  var cells = [
    { val: total,  label: 'Total Homes', color: 'var(--text)' },
    { val: bspeed, label: 'Fiber Competitor', color: '#ef4444' },
    { val: incon,  label: 'In Contract', color: '#818cf8' },
    { val: sold,   label: 'Zito Sales',  color: '#10b981' },
    { val: avail,  label: 'Still Available', color: '#facc15' },
    { val: total > 0 ? pct(avail/total) : '—', label: 'Market Open', color: '#06b6d4', isStr: true }
  ];

  el.innerHTML = cells.map(function(c) {
    return '<div class="comp-pill">' +
      '<div class="comp-pill-val" style="color:' + c.color + '">' + (c.isStr ? c.val : c.val) + '</div>' +
      '<div class="comp-pill-lbl">' + c.label + '</div>' +
    '</div>';
  }).join('');
}

// 4. Rep leaderboard — close rate, min 5 doors
function renderLeaderboard() {
  var el = document.getElementById('ana-leaderboard');
  if (!el) return;

  // Aggregate per rep — knockable addresses only
  var repData = {};
  addresses.forEach(function(a) {
    var rep = (a.salesperson || '').trim();
    if (!rep) return;
    if (!isKnockable(a)) return;  // skip existing customers
    if (!repData[rep]) repData[rep] = { doors: 0, sales: 0 };
    var s = (a.status || 'pending').toLowerCase();
    if (s !== 'pending' && s !== '' && s !== 'homes passed') repData[rep].doors++;
    if (s === 'mega' || s === 'gig') repData[rep].sales++;
  });

  var rows = Object.keys(repData)
    .filter(function(r){ return repData[r].doors >= 5; })
    .map(function(r) {
      var d = repData[r];
      return { name: r, doors: d.doors, sales: d.sales, rate: d.doors > 0 ? d.sales/d.doors : 0 };
    })
    .sort(function(a,b){ return b.rate - a.rate; });

  if (rows.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:16px;font-size:11px;color:var(--muted);">Need at least 5 doors per rep to rank</div>';
    return;
  }

  var medals = ['gold','silver','bronze'];
  el.innerHTML = rows.map(function(r, i) {
    var medal = medals[i] || '';
    return '<div class="lb-row">' +
      '<div class="lb-rank ' + medal + '">' + (i+1) + '</div>' +
      '<div>' +
        '<div class="lb-name">' + escHtml(r.name) + '</div>' +
        '<div class="lb-stats">' + r.sales + ' sales / ' + r.doors + ' doors</div>' +
      '</div>' +
      '<div class="lb-rate">' + pct(r.rate) + '</div>' +
    '</div>';
  }).join('');
}

// ── Coverage Tab ──────────────────────────────────────────
function renderCoverageTab() {
  var el = document.getElementById('cov-territory-bars');
  if (!el) return;

  // Group knockable addresses by territory — existing customers excluded
  var terrMap = {};
  addresses.forEach(function(a) {
    if (!isKnockable(a)) return;
    var t = (a.territory || 'Unknown').trim();
    if (!terrMap[t]) terrMap[t] = { total: 0, worked: 0, sold: 0 };
    terrMap[t].total++;
    var s = (a.status || 'pending').toLowerCase();
    if (s !== 'pending' && s !== '' && s !== 'homes passed') terrMap[t].worked++;
    if (s === 'mega' || s === 'gig') terrMap[t].sold++;
  });

  var names = Object.keys(terrMap).sort();
  if (names.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:16px;font-size:11px;color:var(--muted);">No territory data available</div>';
    return;
  }

  el.innerHTML = names.map(function(t) {
    var d = terrMap[t];
    var covPct  = d.total > 0 ? d.worked / d.total : 0;
    var soldPct = d.total > 0 ? d.sold / d.total : 0;
    // Gradient: sold (green) fills left portion, rest of worked (blue) fills remaining
    var soldW   = (soldPct * 100).toFixed(1);
    var workedW = ((covPct - soldPct) * 100).toFixed(1);
    return '<div class="cov-terr-row">' +
      '<div class="cov-terr-header">' +
        '<span class="cov-terr-name">' + escHtml(t) + '</span>' +
        '<span class="cov-terr-stats">' +
          d.worked + '/' + d.total + ' worked · ' + pct(covPct) + ' coverage · ' + d.sold + ' sales' +
        '</span>' +
      '</div>' +
      '<div class="cov-track">' +
        '<div class="cov-fill" style="width:' + soldW + '%;background:#10b981;float:left"></div>' +
        '<div class="cov-fill" style="width:' + workedW + '%;background:rgba(0,86,150,.6);float:left"></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Forecast Tab ──────────────────────────────────────────
// Pricing constants (match PKG at top of file)
var FC_MONTHLY = {
  mega: 29.95 + 5.00 + 1.00,  // base + eero + proc
  gig:  30.00 + 5.00 + 1.00
};

function renderForecastTab() {
  // Current actuals — knockable doors only (excludes existing Zito customers)
  var knockable   = addresses.filter(isKnockable);
  var totalHomes  = knockable.length;
  var soldMega    = knockable.filter(function(a){ return a.status === 'mega'; }).length;
  var soldGig     = knockable.filter(function(a){ return a.status === 'gig'; }).length;
  var totalSold   = soldMega + soldGig;
  var worked      = knockable.filter(function(a){
    var s = (a.status||'pending').toLowerCase();
    return s !== 'pending' && s !== '' && s !== 'homes passed';
  }).length;
  var pending     = knockable.filter(function(a){
    var s = (a.status||'pending').toLowerCase();
    return !s || s === 'pending';
  }).length;

  var closeRate   = worked > 0 ? totalSold / worked : 0;
  var gigMix      = totalSold > 0 ? soldGig / totalSold : 0.40; // default 40% gig mix

  // Projected additional sales from remaining pending homes
  var projSales   = Math.round(pending * closeRate);
  var projGig     = Math.round(projSales * gigMix);
  var projMega    = projSales - projGig;

  // Current MRR from confirmed sales
  var currentMRR  = (soldMega * FC_MONTHLY.mega) + (soldGig * FC_MONTHLY.gig);
  // Projected total MRR including pending conversions
  var projMRR     = currentMRR +
    (projMega * FC_MONTHLY.mega) +
    (projGig  * FC_MONTHLY.gig);

  // Render hero number
  var mrrEl = document.getElementById('fc-mrr');
  if (mrrEl) mrrEl.textContent = usd(projMRR);

  // Render inputs grid
  var inputsEl = document.getElementById('fc-inputs-grid');
  if (inputsEl) {
    var inputs = [
      { val: totalHomes, lbl: 'Total Homes' },
      { val: pending, lbl: 'Pending' },
      { val: worked > 0 ? pct(closeRate) : '—', lbl: 'Close Rate' },
      { val: projSales, lbl: 'Projected Sales' },
      { val: usd(currentMRR), lbl: 'Current MRR' },
      { val: pct(gigMix), lbl: 'Gig Mix' }
    ];
    inputsEl.innerHTML = inputs.map(function(i) {
      return '<div class="fc-input-cell">' +
        '<div class="fc-input-val">' + i.val + '</div>' +
        '<div class="fc-input-lbl">' + i.lbl + '</div>' +
      '</div>';
    }).join('');
  }

  // Render territory breakdown — knockable doors only
  var terrMap = {};
  addresses.forEach(function(a) {
    if (!isKnockable(a)) return;
    var t = (a.territory || 'Unknown').trim();
    if (!terrMap[t]) terrMap[t] = { pending: 0, sold: 0, worked: 0 };
    var s = (a.status||'pending').toLowerCase();
    if (!s || s === 'pending') terrMap[t].pending++;
    if (s !== 'pending' && s !== '' && s !== 'homes passed') terrMap[t].worked++;
    if (s === 'mega' || s === 'gig') terrMap[t].sold++;
  });

  var terrEl = document.getElementById('fc-territory-table');
  if (terrEl) {
    var tNames = Object.keys(terrMap).sort();
    if (tNames.length === 0) {
      terrEl.innerHTML = '<div style="text-align:center;padding:16px;font-size:11px;color:var(--muted);">No territory data</div>';
    } else {
      terrEl.innerHTML = '<div class="fc-terr-table">' +
        tNames.map(function(t) {
          var d    = terrMap[t];
          var cr   = d.worked > 0 ? d.sold/d.worked : closeRate; // use territory CR or global
          var proj = Math.round(d.pending * cr);
          var mrr  = proj * (FC_MONTHLY.mega * (1 - gigMix) + FC_MONTHLY.gig * gigMix);
          return '<div class="fc-terr-row">' +
            '<span class="fc-terr-name">' + escHtml(t) + '</span>' +
            '<span class="fc-terr-pending">' + d.pending + ' pending</span>' +
            '<span class="fc-terr-rev">+' + usd(mrr) + '/mo</span>' +
          '</div>';
        }).join('') +
      '</div>';
    }
  }

  // Package split bars
  var pkgEl = document.getElementById('fc-pkg-split');
  if (pkgEl) {
    var totalProjRev = projMRR;
    var megaRev = (soldMega + projMega) * FC_MONTHLY.mega;
    var gigRev  = (soldGig  + projGig)  * FC_MONTHLY.gig;
    var pkgs = [
      { label: 'Gig Speed Fiber',  rev: gigRev,  color: '#10b981' },
      { label: 'Mega Speed Fiber', rev: megaRev, color: '#8b5cf6' }
    ];
    pkgEl.innerHTML = pkgs.map(function(p) {
      var w = totalProjRev > 0 ? (p.rev / totalProjRev) * 100 : 0;
      return '<div class="fc-pkg-row">' +
        '<div class="fc-pkg-header">' +
          '<span class="fc-pkg-label">' + p.label + '</span>' +
          '<span class="fc-pkg-val">' + usd(p.rev) + '/mo</span>' +
        '</div>' +
        '<div class="fc-pkg-track"><div class="fc-pkg-fill" style="width:' + w + '%;background:' + p.color + '"></div></div>' +
      '</div>';
    }).join('');
  }
}

// ══════════════════════════════════════════════════════════
//  TIER 3 — TERRITORY INTELLIGENCE
// ══════════════════════════════════════════════════════════

// ── Haversine distance in miles (client-side) ─────────────
function haversineMiles(lat1, lng1, lat2, lng2) {
  var R    = 3958.76;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a    = Math.sin(dLat/2) * Math.sin(dLat/2) +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
             Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ──────────────────────────────────────────────────────────
//  ROUTE MODE
//  Sorts the sidebar list nearest-first from the rep's current
//  GPS position so they walk an efficient path door to door.
// ──────────────────────────────────────────────────────────
var routeMode = false;
var staleMode = false;
var activeDispoFilter = '';
var STALE_HOURS = 2; // hours before a Not Home / Go Back is considered stale

function toggleRouteMode() {
  routeMode = !routeMode;
  if (routeMode) staleMode = false;  // mutually exclusive

  var btn     = document.getElementById('btn-route-mode');
  var staleBtn = document.getElementById('btn-stale-mode');
  if (btn)     btn.classList.toggle('active', routeMode);
  if (staleBtn) staleBtn.classList.remove('active');

  if (routeMode && !lastGPS) {
    routeMode = false;
    if (btn) btn.classList.remove('active');
    // Re-show the GPS prompt so they can grant permission on the spot
    showGPSPrompt();
    return;
  }

  buildList();
  toast(routeMode ? '🧭 Route Mode ON — sorted nearest first' : '🧭 Route Mode OFF', 't-info');
}

function toggleStaleMode() {
  staleMode = !staleMode;
  if (staleMode) routeMode = false;  // mutually exclusive

  var btn      = document.getElementById('btn-stale-mode');
  var routeBtn = document.getElementById('btn-route-mode');
  if (btn)      btn.classList.toggle('active', staleMode);
  if (routeBtn) routeBtn.classList.remove('active');

  buildList();
  toast(staleMode ? '🔄 Follow-Up Mode ON — showing stale contacts' : '🔄 Follow-Up Mode OFF', 't-info');
}

// Returns the follow-up queue: Not Home or Go Back Later addresses
// sorted by how long since they were knocked (oldest first so rep revisits them)
function getStaleAddresses() {
  var now = Date.now();
  return addresses.filter(function(a) {
    var s = (a.status || '').toLowerCase();
    if (s !== 'nothome' && s !== 'goback') return false;
    // Include anything without a knockedAt — we don't know when it was last tried
    if (!a.knockedAt) return true;
    var hrs = (now - new Date(a.knockedAt).getTime()) / 3600000;
    return hrs >= STALE_HOURS;
  }).sort(function(a, b) {
    // Oldest knockedAt first; nulls go to top (unknown = assume old)
    var ta = a.knockedAt ? new Date(a.knockedAt).getTime() : 0;
    var tb = b.knockedAt ? new Date(b.knockedAt).getTime() : 0;
    return ta - tb;
  });
}

// Updates the stale count badge on the Follow-Up button
function updateStaleBadge() {
  var el = document.getElementById('stale-badge');
  if (!el) return;
  var count = getStaleAddresses().length;
  // textContent drives the CSS :empty selector — clear when zero so badge hides
  el.textContent = count > 0 ? String(count) : '';
}

// ──────────────────────────────────────────────────────────
//  TERRITORY INTEL TAB
// ──────────────────────────────────────────────────────────
function renderTerritoryTab() {
  renderSaturation();
  renderCompetitorByTerritory();
  renderStaleList();
  renderDeployRecommendations();
}

// 1. Saturation — how worked-out is each territory?
function renderSaturation() {
  var el = document.getElementById('ti-saturation');
  if (!el) return;

  var terrMap = buildTerrMap();
  var names   = Object.keys(terrMap).sort();

  if (!names.length) {
    el.innerHTML = noDataMsg('No territory data loaded');
    return;
  }

  el.innerHTML = names.map(function(t) {
    var d   = terrMap[t];
    var cov = d.total > 0 ? d.worked / d.total : 0;
    var cr  = d.worked > 0 ? d.sales / d.worked : 0;

    // Saturation signal
    var sig, sigColor, sigIcon;
    if (cov >= 0.90) {
      sig = 'Saturated — consider rotating reps out';
      sigColor = '#ef4444'; sigIcon = '🔴';
    } else if (cov >= 0.70) {
      sig = 'Well-worked — push for closes on remaining homes';
      sigColor = '#facc15'; sigIcon = '🟡';
    } else if (cov >= 0.40) {
      sig = 'Active — good opportunity remaining';
      sigColor = '#10b981'; sigIcon = '🟢';
    } else {
      sig = 'Fresh territory — high opportunity';
      sigColor = '#06b6d4'; sigIcon = '🔵';
    }

    var covW  = (cov * 100).toFixed(1);
    var soldW = d.total > 0 ? ((d.sales / d.total) * 100).toFixed(1) : 0;

    return '<div class="ti-terr-card">' +
      '<div class="ti-terr-header">' +
        '<div>' +
          '<div class="ti-terr-name">' + escHtml(t) + '</div>' +
          '<div class="ti-terr-sig" style="color:' + sigColor + '">' + sigIcon + ' ' + sig + '</div>' +
        '</div>' +
        '<div class="ti-terr-pct" style="color:' + sigColor + '">' + covW + '%</div>' +
      '</div>' +
      '<div class="ti-track">' +
        '<div class="ti-fill" style="width:' + soldW + '%;background:#10b981"></div>' +
        '<div class="ti-fill" style="width:' + (covW - soldW) + '%;background:rgba(0,86,150,.55)"></div>' +
      '</div>' +
      '<div class="ti-terr-stats">' +
        '<span>' + d.worked + '/' + d.total + ' knocked</span>' +
        '<span>' + d.sales + ' sales</span>' +
        '<span>Close rate: ' + pct(cr) + '</span>' +
        '<span>' + d.pending + ' remaining</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

// 2. Competitor breakdown per territory
function renderCompetitorByTerritory() {
  var el = document.getElementById('ti-competitor-table');
  if (!el) return;

  var terrMap = buildTerrMap();
  var names   = Object.keys(terrMap).sort();

  if (!names.length) {
    el.innerHTML = noDataMsg('No territory data loaded');
    return;
  }

  // Header
  var rows = '<div class="ti-comp-header">' +
    '<span class="ti-comp-terr">Territory</span>' +
    '<span class="ti-comp-col" style="color:#ef4444">Brightspd</span>' +
    '<span class="ti-comp-col" style="color:#818cf8">In Contr</span>' +
    '<span class="ti-comp-col" style="color:#10b981">Zito</span>' +
    '<span class="ti-comp-col" style="color:#06b6d4">Open</span>' +
  '</div>';

  rows += names.map(function(t) {
    var d       = terrMap[t];
    var total   = d.total || 1;
    var open    = total - d.fibercompetitor - d.incontract - d.sales;
    open = Math.max(open, 0);

    function bar(val, color) {
      var w = ((val / total) * 100).toFixed(0);
      return '<div class="ti-comp-bar-wrap">' +
        '<span class="ti-comp-num">' + val + '</span>' +
        '<div class="ti-mini-track"><div style="width:' + w + '%;background:' + color + ';height:100%;border-radius:2px"></div></div>' +
      '</div>';
    }

    return '<div class="ti-comp-row">' +
      '<span class="ti-comp-terr" title="' + escHtml(t) + '">' + escHtml(t) + '</span>' +
      bar(d.fibercompetitor, '#ef4444') +
      bar(d.incontract,  '#818cf8') +
      bar(d.sales,       '#10b981') +
      bar(open,          '#06b6d4') +
    '</div>';
  }).join('');

  el.innerHTML = rows;
}

// 3. Stale follow-up list — oldest unvisited contacts first
function renderStaleList() {
  var el = document.getElementById('ti-stale-list');
  if (!el) return;

  var stale = getStaleAddresses();

  if (!stale.length) {
    el.innerHTML = '<div class="ti-empty">No follow-up contacts — all Not Home and Go Back doors are either fresh or cleared 👍</div>';
    return;
  }

  var now = Date.now();
  el.innerHTML = stale.slice(0, 20).map(function(a) {
    var s       = (a.status || '').toLowerCase();
    var icon    = s === 'goback' ? '🔄' : '🚪';
    var label   = s === 'goback' ? 'Go Back' : 'Not Home';
    var color   = s === 'goback' ? '#06b6d4' : '#d97706';

    var age = '';
    if (a.knockedAt) {
      var hrs = (now - new Date(a.knockedAt).getTime()) / 3600000;
      age = hrs < 1 ? Math.round(hrs * 60) + 'm ago'
          : hrs < 24 ? hrs.toFixed(1) + 'h ago'
          : Math.floor(hrs / 24) + 'd ago';
    } else {
      age = 'unknown';
    }

    var dist = '';
    if (lastGPS && a.lat && a.lng) {
      var mi = haversineMiles(lastGPS.lat, lastGPS.lng, a.lat, a.lng);
      dist = mi < 0.1 ? 'nearby' : mi.toFixed(2) + ' mi';
    }

    return '<div class="ti-stale-row" onclick="openForm(' + a.id + ');closeManagerPanel()">' +
      '<div class="ti-stale-icon" style="color:' + color + '">' + icon + '</div>' +
      '<div class="ti-stale-info">' +
        '<div class="ti-stale-addr">' + escHtml(a.address) + '</div>' +
        '<div class="ti-stale-meta">' +
          '<span style="color:' + color + '">' + label + '</span>' +
          (a.note ? ' · ' + escHtml(a.note.substring(0, 40)) : '') +
        '</div>' +
      '</div>' +
      '<div class="ti-stale-right">' +
        (dist ? '<div class="ti-stale-dist">' + dist + '</div>' : '') +
        '<div class="ti-stale-age">' + age + '</div>' +
      '</div>' +
    '</div>';
  }).join('') +
  (stale.length > 20 ? '<div class="ti-empty" style="margin-top:8px">+ ' + (stale.length - 20) + ' more — use Follow-Up Mode in sidebar to see all</div>' : '');
}

// 4. Deploy recommendations based on saturation + close rate + pending count
function renderDeployRecommendations() {
  var el = document.getElementById('ti-recommendations');
  if (!el) return;

  var terrMap = buildTerrMap();
  var names   = Object.keys(terrMap);

  if (!names.length) {
    el.innerHTML = noDataMsg('No territory data to analyze');
    return;
  }

  var recs = [];

  names.forEach(function(t) {
    var d    = terrMap[t];
    var cov  = d.total > 0 ? d.worked / d.total : 0;
    var cr   = d.worked > 0 ? d.sales / d.worked : 0;
    var pending = d.pending;
    var staleCount = addresses.filter(function(a) {
      return (a.territory || '').trim() === t &&
             (a.status === 'nothome' || a.status === 'goback');
    }).length;

    // Rule engine
    if (cov >= 0.90) {
      recs.push({
        territory: t, priority: 'high',
        icon: '🔴',
        action: 'Rotate out — ' + (cov * 100).toFixed(0) + '% worked, only ' + pending + ' homes left',
        detail: 'Territory is effectively saturated. Move reps to a fresh area to maintain pace.'
      });
    } else if (staleCount >= 10 && cov >= 0.50) {
      recs.push({
        territory: t, priority: 'medium',
        icon: '🔄',
        action: 'Schedule a revisit day — ' + staleCount + ' Not Home / Go Back contacts waiting',
        detail: 'High stale count suggests many residents were not home during the initial sweep. A dedicated revisit run could yield hidden sales.'
      });
    } else if (cr >= 0.12 && cov < 0.50) {
      recs.push({
        territory: t, priority: 'high',
        icon: '🟢',
        action: 'Double down — ' + pct(cr) + ' close rate with ' + pending + ' homes untouched',
        detail: 'Above-average performance with significant runway remaining. Add more reps or extend hours here.'
      });
    } else if (cr < 0.05 && d.worked >= 20) {
      recs.push({
        territory: t, priority: 'low',
        icon: '🟡',
        action: 'Review approach — only ' + pct(cr) + ' close rate after ' + d.worked + ' doors',
        detail: 'Low close rate may indicate high competitor penetration or wrong rep-territory fit. Check competitor data.'
      });
    } else if (cov < 0.20 && d.total > 50) {
      recs.push({
        territory: t, priority: 'medium',
        icon: '🔵',
        action: 'Fresh territory — send more reps to ' + t,
        detail: 'Only ' + (cov * 100).toFixed(0) + '% worked. High opportunity — deploy additional reps to increase pace.'
      });
    }
  });

  if (!recs.length) {
    el.innerHTML = '<div class="ti-empty">All territories are well-balanced — no urgent recommendations right now.</div>';
    return;
  }

  var priorityOrder = { high: 0, medium: 1, low: 2 };
  recs.sort(function(a,b){ return (priorityOrder[a.priority]||0) - (priorityOrder[b.priority]||0); });

  el.innerHTML = recs.map(function(r) {
    var borderColor = r.priority === 'high' ? '#ef4444' : r.priority === 'medium' ? '#facc15' : '#6b7280';
    return '<div class="ti-rec-card" style="border-left-color:' + borderColor + '">' +
      '<div class="ti-rec-header">' +
        '<span class="ti-rec-icon">' + r.icon + '</span>' +
        '<div>' +
          '<div class="ti-rec-terr">' + escHtml(r.territory) + '</div>' +
          '<div class="ti-rec-action">' + r.action + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ti-rec-detail">' + r.detail + '</div>' +
    '</div>';
  }).join('');
}

// ── Shared territory aggregation ─────────────────────────
function buildTerrMap() {
  var m = {};
  addresses.forEach(function(a) {
    var t = (a.territory || 'Unknown').trim();
    if (!m[t]) m[t] = {
      total: 0, worked: 0, pending: 0, sales: 0,
      mega: 0, gig: 0, nothome: 0,
      fibercompetitor: 0, incontract: 0, goback: 0,
      notinterested: 0, vacant: 0, business: 0,
      // Existing customer count tracked separately for context
      existingCustomers: 0
    };
    var d = m[t];
    var s = (a.status || 'pending').toLowerCase();

    // Track existing customers separately — they are NOT in the knockable universe
    if (!isKnockable(a)) {
      d.existingCustomers++;
      return;
    }

    // Only knockable addresses count toward totals, coverage, and close rate
    d.total++;
    if (!s || s === 'pending' || s === 'homes passed') { d.pending++; return; }
    d.worked++;
    if (s === 'mega')            { d.mega++;          d.sales++; }
    else if (s === 'gig')        { d.gig++;           d.sales++; }
    else if (s === 'nothome')      d.nothome++;
    else if (s === 'nothome2')     d.nothome++;   // count all NH variants together
    else if (s === 'nothome3')     d.nothome++;
    else if (s === 'nothome4')     d.nothome++;
    else if (s === 'fibercompetitor')  d.fibercompetitor++;
    else if (s === 'competitor')   d.fibercompetitor++; // lump competitor with BS for coverage stats
    else if (s === 'incontract')   d.incontract++;
    else if (s === 'goback')       d.goback++;
    else if (s === 'notinterested') d.notinterested++;
    else if (s === 'vacant')       d.vacant++;
    else if (s === 'business')     d.business++;
    else if (s === 'activecustomer') d.existingCustomers++; // treat as existing
  });
  return m;
}

function noDataMsg(msg) {
  return '<div class="ti-empty">' + escHtml(msg) + '</div>';
}

function timeAgo(isoString) {
  var diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60)   return diff + 's ago';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  return Math.floor(diff/3600) + 'h ago';
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ──────────────────────────────────────────────────────────
//  BADGE & ONLINE/OFFLINE STATUS
// ──────────────────────────────────────────────────────────
var repOnline = false;

function initBadge() {}

function applyRepStatus() {}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function popupHtmlForAddr(addr) {
  var cityState = [addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
  var noteHtml = addr.note ? '<div style="margin-top:6px;color:#8b949e;font-size:11px">💬 ' + escHtml(addr.note) + '</div>' : '';
  var outcomeLabel = getStandardizedOutcomeLabel(addr.status);
  var outcomeHtml = outcomeLabel ? '<div style="margin-top:6px;font-size:11px;color:#cbd5e1">Framework: <strong>' + escHtml(outcomeLabel) + '</strong></div>' : '';
  var softType = getSoftInterestType(addr.status);
  var softHtml = softType ? '<div style="margin-top:4px;font-size:11px;color:#93c5fd">Soft interest: ' + escHtml(softType) + '</div>' : '';
  return '<div style="font-size:12px;font-weight:700">' + escHtml(addr.address) + '</div>' +
         '<div style="font-size:11px;color:#8b949e">' + escHtml(cityState || '—') + '</div>' +
         noteHtml + outcomeHtml + softHtml;
}

function toggleRepStatus() {}

function openBadge() {}

function closeBadge() {}

var lastGPS       = null;
var gpsWatchId    = null;
var repMarker     = null;   // Leaflet marker showing the rep's live position
var repAccCircle  = null;   // Accuracy radius circle

// ── GPS Permission & Init ─────────────────────────────────

function showGPSPrompt() {
  showGPSBanner('📍 Allow location access to use Route Mode', 'warn');
  requestGPS();
}

function dismissGPSPrompt() {}

function showGPSBanner() {}

// ── Rep position marker ──────────────────────────────────
function updateRepMarker(lat, lng, acc) {
  if (!mapObj) return;

  // Build initials from repName
  var parts    = (repName || 'ME').trim().split(/\s+/);
  var initials = parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (repName || 'ME').slice(0, 2).toUpperCase();

  // SVG icon: outer pulse ring + solid dot + initials label
  var markerHTML = [
    '<div class="rep-marker-wrap">',
      '<div class="rep-marker-pulse"></div>',
      '<div class="rep-marker-dot">',
        '<span class="rep-marker-initials">' + initials + '</span>',
      '</div>',
    '</div>'
  ].join('');

  var icon = L.divIcon({
    className: '',
    html: markerHTML,
    iconSize:   [44, 44],
    iconAnchor: [22, 22],
    popupAnchor:[0, -22]
  });

  if (repMarker) {
    // Smoothly move existing marker
    repMarker.setLatLng([lat, lng]);
    repMarker.setIcon(icon); // refreshes initials if repName changed
  } else {
    // First time — create marker on a custom pane so it floats above all address pins
    if (!mapObj.getPane('repPane')) {
      mapObj.createPane('repPane');
      mapObj.getPane('repPane').style.zIndex = 650; // above markerPane (600)
      mapObj.getPane('repPane').style.pointerEvents = 'none';
    }
    repMarker = L.marker([lat, lng], {
      icon:        icon,
      pane:        'repPane',
      interactive: false,   // don't intercept taps meant for address pins
      zIndexOffset: 1000
    }).addTo(mapObj);

    repMarker.bindTooltip(
      '<strong>' + (repName || 'Rep') + '</strong><br><span style="font-size:10px;color:#8b949e">Your location</span>',
      { permanent: false, direction: 'top', className: 'rep-tooltip' }
    );
  }

  // Update accuracy circle
  if (acc && acc > 0 && acc < 500) {
    if (repAccCircle) {
      repAccCircle.setLatLng([lat, lng]).setRadius(acc);
    } else {
      repAccCircle = L.circle([lat, lng], {
        radius:      acc,
        color:       '#3b82f6',
        fillColor:   '#3b82f6',
        fillOpacity: 0.06,
        opacity:     0.25,
        weight:      1,
        interactive: false
      }).addTo(mapObj);
    }
  } else if (repAccCircle) {
    mapObj.removeLayer(repAccCircle);
    repAccCircle = null;
  }
}

function removeRepMarker() {
  if (repMarker)    { mapObj.removeLayer(repMarker);    repMarker    = null; }
  if (repAccCircle) { mapObj.removeLayer(repAccCircle); repAccCircle = null; }
}

function requestGPS() {
  dismissGPSPrompt(); // close the modal first

  if (!navigator.geolocation) {
    showGPSBanner('⚠ GPS not supported on this device', 'err');
    return;
  }

  // One-shot getCurrentPosition to trigger the browser permission dialog.
  // If the user grants it, we immediately kick off the persistent watchPosition.
  navigator.geolocation.getCurrentPosition(
    function(pos) {
      // Permission granted — seed lastGPS right away so Route Mode works immediately
      lastGPS = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        acc: pos.coords.accuracy || null,
        ts: Date.now()
      };
      updateRepMarker(lastGPS.lat, lastGPS.lng, lastGPS.acc);
      showGPSBanner('📍 Location enabled — Route Mode available', 'ok');
      buildList((document.getElementById('addr-search') && document.getElementById('addr-search').value) || '');
      _startGPSWatch_();  // begin continuous watch
    },
    function(err) {
      var msg = err.code === 1
        ? '📍 Location denied — Route Mode unavailable. Enable in browser settings.'
        : '📍 Could not get location — try again later.';
      showGPSBanner(msg, 'warn');
      _markRouteButtonUnavailable_();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function _markRouteButtonUnavailable_() {
  var btn = document.getElementById('btn-route-mode');
  if (btn) btn.classList.add('no-gps');
}

function _startGPSWatch_() {
  if (gpsWatchId !== null) return;  // already watching
  if (!navigator.geolocation) return;

  gpsWatchId = navigator.geolocation.watchPosition(function(pos) {
    lastGPS = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      acc: pos.coords.accuracy || null,
      ts: Date.now()
    };
    // Remove no-gps class if it was set (e.g. permission granted after initial deny)
    var btn = document.getElementById('btn-route-mode');
    if (btn) btn.classList.remove('no-gps');
    updateRepMarker(lastGPS.lat, lastGPS.lng, lastGPS.acc);
    if (routeMode) buildList((document.getElementById('addr-search') && document.getElementById('addr-search').value) || '');
    pingNearbyAddresses();
  }, function(err) {
    console.warn('Geolocation watch error:', err);
  }, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 10000
  });
}

// Public entry called from launchApp — shows the in-app prompt first
function startGPSPing() {
  // Kick off the browser permission flow / GPS watch on app launch so
  // Route Mode has a usable starting location without an extra tap.
  requestGPS();
}

var _lastNearbyPing = 0;
var NEARBY_PING_THROTTLE = 180000; // 3 minutes

function pingNearbyAddresses() {
  return;
}

// ──────────────────────────────────────────────────────────
//  ADD ADDRESS MODAL
// ──────────────────────────────────────────────────────────
function openAddAddrModal() { return; }

function closeAddAddrModal() { return; }

function checkNewAddrReady() { return; }

function submitNewAddress() { return; }

// ──────────────────────────────────────────────────────────
//  PIN DROP — tap the map to add a new address
// ──────────────────────────────────────────────────────────

// Helper — updates BOTH the topbar button (desktop) and the FAB (mobile)
// so whichever is visible always reflects the current pin-drop state.
function _setPinDropBtnState_(active) {
  var btnTop = document.getElementById('btn-drop-pin-top');
  var btnFab = document.getElementById('btn-drop-pin-fab');
  [btnTop, btnFab].forEach(function(btn) {
    if (!btn) return;
    if (active) {
      btn.classList.add('active');
      btn.textContent = '📍 Tap a Home…';
    } else {
      btn.classList.remove('active');
      btn.textContent = '📍 Drop Pin';
    }
  });
}

function togglePinDropMode() { return; }

function cancelPinDropMode() { pinDropMode = false; return; }

// Pending pin-drop data while the confirm modal is open
var _pendingPin = null;

function handleMapPinDrop() { return; }
function showPinConfirm() { return; }

function confirmPinAddress() { return; }

function cancelPinConfirm() { return; }

// Convert full US state name → 2-letter abbreviation
function stateAbbr(name) {
  var map = {
    'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
    'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
    'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA',
    'Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD',
    'Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO',
    'Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ',
    'New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH',
    'Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC',
    'South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT',
    'Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'
  };
  return map[name] || name;
}

function addPinDropAddress() { return; }

// ──────────────────────────────────────────────────────────
//  DRAW ZONE — polygon drawing + OSM rooftop auto-import
// ──────────────────────────────────────────────────────────
var drawZoneMode    = false;
var drawZonePoints  = [];        // [{lat,lng}] polygon vertices
var drawZoneVisuals = [];        // temp Leaflet layers to clear on cancel/reset
var drawZonePolygon = null;      // filled polygon shown after closing
var drawZonePending = [];        // buildings awaiting user confirmation

function toggleDrawZoneMode() {
  if (drawZoneMode) { cancelDrawZone(); return; }
  if (pinDropMode)  cancelPinDropMode();
  drawZoneMode   = true;
  drawZonePoints = [];
  _dzClearVisuals_();
  var btn = document.getElementById('btn-draw-zone-top');
  if (btn) { btn.classList.add('active'); btn.textContent = '✏️ Drawing…'; }
  document.getElementById('draw-zone-banner').classList.add('show');
  var mapEl = document.getElementById('map');
  if (mapEl) mapEl.classList.add('draw-zone-mode');
  if (window.innerWidth <= 640 && sidebarOpen) toggleSidebar();
  toast('✏️ Tap corners on the map — double-tap or tap the ● to close', 't-info');
}

function cancelDrawZone() {
  drawZoneMode   = false;
  drawZonePoints = [];
  _dzClearVisuals_();
  var btn = document.getElementById('btn-draw-zone-top');
  if (btn) { btn.classList.remove('active'); btn.textContent = '🏘 Draw Zone'; }
  document.getElementById('draw-zone-banner').classList.remove('show');
  var mapEl = document.getElementById('map');
  if (mapEl) mapEl.classList.remove('draw-zone-mode');
}

function _dzClearVisuals_() {
  if (!mapObj) return;
  drawZoneVisuals.forEach(function(l) { try { mapObj.removeLayer(l); } catch(e) {} });
  drawZoneVisuals = [];
  if (drawZonePolygon) { try { mapObj.removeLayer(drawZonePolygon); } catch(e) {} drawZonePolygon = null; }
}

function handleDrawZoneClick(latlng) {
  // Snap-to-close: clicking within ~200ft of the first point closes the polygon
  if (drawZonePoints.length >= 3) {
    var first = drawZonePoints[0];
    if (haversineMiles(first.lat, first.lng, latlng.lat, latlng.lng) < 0.04) {
      finalizeDrawZone();
      return;
    }
  }
  drawZonePoints.push({ lat: latlng.lat, lng: latlng.lng });
  _dzUpdateVisuals_();
  // Update hint after first point
  var hint = document.getElementById('draw-zone-banner-text');
  if (hint && drawZonePoints.length === 1) hint.textContent = '✏️ Keep tapping corners — double-tap or tap ● to close';
  if (hint && drawZonePoints.length >= 3)  hint.textContent = '✏️ ' + drawZonePoints.length + ' corners — double-tap or tap ● to close';
}

function _dzUpdateVisuals_() {
  _dzClearVisuals_();
  if (!mapObj || drawZonePoints.length === 0) return;
  var pts = drawZonePoints;
  var lls = pts.map(function(p) { return [p.lat, p.lng]; });

  // Main polyline
  if (pts.length >= 2) {
    var line = L.polyline(lls, { color: '#3b82f6', weight: 2.5, dashArray: '7 4', opacity: .9 }).addTo(mapObj);
    drawZoneVisuals.push(line);
    // Dashed closing preview line
    if (pts.length >= 3) {
      var close = L.polyline([lls[lls.length-1], lls[0]], { color: '#3b82f6', weight: 2, dashArray: '4 6', opacity: .45 }).addTo(mapObj);
      drawZoneVisuals.push(close);
    }
  }

  // Vertex dots
  pts.forEach(function(p, i) {
    var isFirst = i === 0;
    var dot = L.circleMarker([p.lat, p.lng], {
      radius: isFirst ? 9 : 5,
      fillColor: isFirst ? '#10b981' : '#3b82f6',
      color: '#fff', weight: 2.5, fillOpacity: 1,
      interactive: isFirst && pts.length >= 3
    }).addTo(mapObj);
    if (isFirst && pts.length >= 3) {
      dot.bindTooltip('Tap to close', { permanent: false, direction: 'top' });
      dot.on('click', function(e) { L.DomEvent.stopPropagation(e); finalizeDrawZone(); });
    }
    drawZoneVisuals.push(dot);
  });
}

function finalizeDrawZone() {
  if (drawZonePoints.length < 3) { toast('⚠ Need at least 3 corners', 't-err'); return; }
  drawZoneMode = false;
  var btn = document.getElementById('btn-draw-zone-top');
  if (btn) { btn.classList.remove('active'); btn.textContent = '🏘 Draw Zone'; }
  document.getElementById('draw-zone-banner').classList.remove('show');

  // Show filled polygon while scanning
  _dzClearVisuals_();
  var lls = drawZonePoints.map(function(p) { return [p.lat, p.lng]; });
  drawZonePolygon = L.polygon(lls, {
    color: '#3b82f6', weight: 2.5, dashArray: '6 4',
    fillColor: '#3b82f6', fillOpacity: .12
  }).addTo(mapObj);

  toast('🔍 Scanning for houses in zone…', 't-info');
  _dzQueryBuildings_(drawZonePoints.slice());
}

// Point-in-polygon (ray casting)
function pointInPolygon(lat, lng, polygon) {
  var inside = false, n = polygon.length;
  for (var i = 0, j = n - 1; i < n; j = i++) {
    var xi = polygon[i].lat, yi = polygon[i].lng;
    var xj = polygon[j].lat, yj = polygon[j].lng;
    if (((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function _dzQueryBuildings_(points) {
  var polyStr = points.map(function(p) { return p.lat + ' ' + p.lng; }).join(' ');

  // PRIMARY: address nodes — these are what Nominatim resolves when you drop a pin.
  // Far better coverage in US residential areas than building footprint tags.
  // SECONDARY: building ways/nodes as a fallback for areas with footprints but no addr tags.
  var query =
    '[out:json][timeout:90];\n' +
    '(\n' +
    '  node["addr:housenumber"]["addr:street"](poly:"' + polyStr + '");\n' +
    '  way["addr:housenumber"]["addr:street"](poly:"' + polyStr + '");\n' +
    '  way["building"]["building"!~"^(commercial|industrial|retail|office|warehouse|garage|shed|barn|church|school|hospital|hotel|supermarket|mall|civic|public|construction)$"](poly:"' + polyStr + '");\n' +
    '  node["building"="house"](poly:"' + polyStr + '");\n' +
    '  node["building"="residential"](poly:"' + polyStr + '");\n' +
    ');\n' +
    'out center tags;';

  // Try primary endpoint, fall back to mirror on 504/429
  var OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];

  function tryOverpass(endpoints, idx) {
    if (idx >= endpoints.length) {
      _dzClearVisuals_();
      toast('⚠ Zone scan failed: all Overpass endpoints timed out', 't-err');
      return;
    }
    fetch(endpoints[idx], {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query)
    })
    .then(function(r) {
      if (r.status === 504 || r.status === 429 || r.status === 502) {
        toast('⚠ Overpass endpoint ' + (idx+1) + ' slow, trying backup…', 't-info');
        tryOverpass(endpoints, idx + 1);
        return null;
      }
      if (!r.ok) throw new Error('Overpass returned ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (!data) return;
      _dzProcessBuildings_(data.elements || [], points);
    })
    .catch(function(err) {
      if (idx + 1 < endpoints.length) {
        toast('⚠ Overpass endpoint ' + (idx+1) + ' failed, trying backup…', 't-info');
        tryOverpass(endpoints, idx + 1);
      } else {
        _dzClearVisuals_();
        toast('⚠ Zone scan failed: ' + String(err.message || err).substring(0, 60), 't-err');
      }
    });
  }

  tryOverpass(OVERPASS_ENDPOINTS, 0);
}

// US Census Bureau geocoder — free, no API key, best for US residential addresses
// Falls back to Nominatim if Census returns no match
function _dzReverseGeocode_(lat, lng, callback) {
  var censusUrl =
    'https://geocoding.geo.census.gov/geocoder/locations/coordinates' +
    '?x=' + encodeURIComponent(lng) +
    '&y=' + encodeURIComponent(lat) +
    '&benchmark=2020&format=json';

  fetch(censusUrl)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var matches = data &&
                    data.result &&
                    data.result.addressMatches;
      if (matches && matches.length > 0) {
        var m    = matches[0];
        var addr = m.addressComponents || {};
        var streetNum  = (addr.fromAddress || '').split('-')[0].trim();
        var streetName = (addr.streetName || '').trim();
        var suffix     = (addr.suffixType || '').trim();
        var street     = [streetNum, streetName, suffix].filter(Boolean).join(' ');
        if (!street) street = (m.matchedAddress || '').split(',')[0].trim();
        callback({
          address: street,
          city:    (addr.city || '').trim(),
          state:   (addr.state || '').trim(),
          zip:     (addr.zip || '').trim()
        });
      } else {
        // Census had no match — fall back to Nominatim
        _dzNominatimReverse_(lat, lng, callback);
      }
    })
    .catch(function() {
      _dzNominatimReverse_(lat, lng, callback);
    });
}

function _dzNominatimReverse_(lat, lng, callback) {
  var url = 'https://nominatim.openstreetmap.org/reverse?format=json' +
            '&lat=' + encodeURIComponent(lat) +
            '&lon=' + encodeURIComponent(lng) +
            '&zoom=18&addressdetails=1';
  fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'FieldSalesApp/1.0' } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var a  = data && data.address ? data.address : {};
      var hn = (a.house_number || '').trim();
      var rd = (a.road || a.pedestrian || a.path || '').trim();
      var street = hn && rd ? (hn + ' ' + rd) : (rd || (data.display_name ? data.display_name.split(',')[0].trim() : ''));
      callback({
        address: street || ('Building at ' + lat.toFixed(5) + ',' + lng.toFixed(5)),
        city:    a.city || a.town || a.village || a.hamlet || '',
        state:   a.state ? stateAbbr(a.state) : '',
        zip:     a.postcode || ''
      });
    })
    .catch(function() {
      callback({
        address: 'Building at ' + lat.toFixed(5) + ',' + lng.toFixed(5),
        city: '', state: '', zip: ''
      });
    });
}

function _dzProcessBuildings_(elements, polygonPoints) {
  if (!elements.length) {
    _dzClearVisuals_();
    toast('⚠ No buildings found — OSM may not have rooftop data for this area yet', 't-err');
    return;
  }

  var buildings = [];
  elements.forEach(function(el) {
    var lat = el.type === 'node' ? el.lat : (el.center ? el.center.lat : null);
    var lng = el.type === 'node' ? el.lon : (el.center ? el.center.lon : null);
    if (!lat || !lng) return;
    // Precise point-in-polygon check (Overpass poly filter is slightly approximate)
    if (!pointInPolygon(lat, lng, polygonPoints)) return;
    // Skip if close to an existing address pin
    var exists = addresses.some(function(a) {
      return a.lat && a.lng && haversineMiles(a.lat, a.lng, lat, lng) < 0.005;
    });
    if (exists) return;

    var tags     = el.tags || {};
    var houseNum = (tags['addr:housenumber'] || '').trim();
    var street   = (tags['addr:street'] || '').trim();
    var city     = (tags['addr:city'] || '').trim();
    var state    = (tags['addr:state'] || '').trim();
    var zip      = (tags['addr:postcode'] || '').trim();
    var hasAddr  = !!(houseNum && street);

    buildings.push({
      lat: lat, lng: lng,
      address: hasAddr ? (houseNum + ' ' + street) : null,
      city: city, state: state, zip: zip, hasAddress: hasAddr
    });
  });

  if (!buildings.length) {
    _dzClearVisuals_();
    toast('✓ All buildings in this zone are already in your list', 't-info');
    return;
  }

  // Populate confirm modal
  drawZonePending = buildings;
  var withAddr    = buildings.filter(function(b) { return b.hasAddress; }).length;
  var needGeo     = buildings.length - withAddr;

  document.getElementById('dz-count-big').textContent = buildings.length;

  var parts = [];
  if (withAddr) parts.push('<span class="dz-ok">✓ ' + withAddr + ' have street addresses from OSM</span>');
  if (needGeo)  parts.push('<span class="dz-warn">⏳ ' + needGeo + ' will be reverse-geocoded (~' + needGeo + 's)</span>');
  document.getElementById('dz-breakdown').innerHTML = parts.join('');
  document.getElementById('dz-geocode-time').textContent = needGeo
    ? 'Pins appear on the map instantly — addresses fill in as geocoding completes'
    : 'All addresses are ready — homes will pin instantly';

  var terrInput = document.getElementById('dz-territory-input');
  if (terrInput && !terrInput.value) terrInput.value = activeTerritory || '';

  document.getElementById('draw-zone-confirm-modal').classList.add('open');
}

function closeDrawZoneConfirm() {
  document.getElementById('draw-zone-confirm-modal').classList.remove('open');
  _dzClearVisuals_();
  drawZonePending = [];
}

function confirmAddZoneBuildings() {
  document.getElementById('draw-zone-confirm-modal').classList.remove('open');
  var terrInput = document.getElementById('dz-territory-input');
  var zoneTerr  = terrInput ? terrInput.value.trim() : (activeTerritory || '');
  var buildings = drawZonePending.slice();
  drawZonePending = [];

  var withAddr  = buildings.filter(function(b) { return  b.hasAddress; });
  var needGeo   = buildings.filter(function(b) { return !b.hasAddress; });

  // Add OSM-addressed buildings immediately
  withAddr.forEach(function(b) {
    _dzAddBuilding_(b.lat, b.lng, b.address, b.city || '', b.state, b.zip, zoneTerr);
  });
  buildList(); updateStats();

  if (!needGeo.length) {
    _dzClearVisuals_();
    toast('✅ ' + withAddr.length + ' homes added from zone!', 't-ok');
    return;
  }

  // Geocode the rest progressively at 1.2/sec (Census allows ~50 req/s but be polite)
  var total = needGeo.length, done = 0, idx = 0;
  showGeocodeBar(0, total, 0);

  function geocodeNext() {
    if (idx >= needGeo.length) {
      _dzClearVisuals_();
      buildList(); updateStats(); hideGeocodeBar();
      toast('✅ ' + (withAddr.length + done) + ' homes added from zone!', 't-ok');
      return;
    }
    var b = needGeo[idx++];
    _dzReverseGeocode_(b.lat, b.lng, function(result) {
      _dzAddBuilding_(b.lat, b.lng, result.address, result.city, result.state, result.zip, zoneTerr);
      done++;
      showGeocodeBar(done, total, 0);
      if (done % 15 === 0) { buildList(); updateStats(); }
      setTimeout(geocodeNext, 1200);
    });
  }
  geocodeNext();
}

function _dzAddBuilding_(lat, lng, address, city, state, zip, territory) {
  // Deduplicate by address text + proximity
  var dup = addresses.find(function(a) {
    if (a.lat && a.lng && haversineMiles(a.lat, a.lng, lat, lng) < 0.005) return true;
    if (address && a.address && a.address.toLowerCase() === address.toLowerCase() &&
        (a.city || '').toLowerCase() === (city || '').toLowerCase()) return true;
    return false;
  });
  if (dup) return;

  var newId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  var newAddr = {
    id: newId, sheetRow: null,
    address: address, city: city, state: state, zip: zip,
    territory: territory || activeTerritory || '',
    lat: lat, lng: lng, activeCount: '',
    status: 'pending', salesperson: '', note: '', sale: null,
    _manuallyAdded: true, _zoneAdded: true
  };
  addresses.push(newAddr);
  if (mapObj) placeMarker(newAddr);
  maybeWriteNewAddrToSheet(newAddr);
}

// ──────────────────────────────────────────────────────────
//  TOAST
// ──────────────────────────────────────────────────────────
function toast(msg, cls) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = cls + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.classList.remove('show'); }, 3200);
}

// Top Bar Drop Pin Hook
document.addEventListener('DOMContentLoaded', function() {
  var topDropBtn = document.getElementById('btn-drop-pin-top');
  if (topDropBtn) {
    topDropBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (typeof togglePinDropMode === 'function') togglePinDropMode();
    });
  }

  var refreshBtn = document.getElementById('btn-refresh-data');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function(e) {
      e.preventDefault();
      refreshAddressData();
    });
  }
});

// ══════════════════════════════════════════════════════════
//  AI FIELD ANALYSIS
// ══════════════════════════════════════════════════════════

var aiLastResult = null;   // cache last result so tab re-opens instantly

function renderAITab() {}

function aiKeySave() {}

function aiKeyToggle() {}

function renderAIContextPills() {
  var el = document.getElementById('ai-context-pills');
  if (!el) return;
  var terrMap   = buildTerrMap();
  var territories = Object.keys(terrMap);
  var knockable = addresses.filter(isKnockable);
  var worked    = knockable.filter(function(a){
    var s = (a.status||'pending').toLowerCase();
    return s !== 'pending' && s !== '' && s !== 'homes passed';
  }).length;
  var totalSales = knockable.filter(function(a){
    return a.status === 'mega' || a.status === 'gig';
  }).length;
  var staleCount = getStaleAddresses ? getStaleAddresses().length : 0;

  var pills = [
    { dot: 'default', label: territories.length + ' territor' + (territories.length===1?'y':'ies') },
    { dot: 'default', label: knockable.length + ' homes' },
    { dot: 'default', label: worked + ' knocked' },
    { dot: totalSales > 0 ? 'default' : 'dim', label: totalSales + ' sales' },
    { dot: staleCount > 5 ? 'warn' : 'default', label: staleCount + ' follow-ups' }
  ];

  el.innerHTML = pills.map(function(p) {
    return '<div class="ai-pill">' +
      '<div class="ai-pill-dot ' + (p.dot !== 'default' ? p.dot : '') + '"></div>' +
      p.label +
    '</div>';
  }).join('');
}

// ── Build the full data payload ────────────────────────────
function buildAIPayload() {
  var terrMap   = buildTerrMap();
  var knockable = addresses.filter(isKnockable);

  // --- Rep performance from the last manager fetch ---
  var repListEl   = document.getElementById('mgr-rep-list');
  var repCards    = repListEl ? repListEl.querySelectorAll('.mgr-rep-card') : [];
  var repSummary  = [];
  repCards.forEach(function(card) {
    var nameEl  = card.querySelector('.mgr-rep-name');
    var salesEl = card.querySelector('.mgr-rep-sales');
    var isOnline = card.classList.contains('rep-online');
    if (nameEl) {
      repSummary.push({
        name:   nameEl.textContent.trim(),
        online: isOnline,
        sales:  salesEl ? salesEl.textContent.trim() : '0 sales'
      });
    }
  });

  // --- Territory stats ---
  var territoryStats = Object.keys(terrMap).map(function(t) {
    var d  = terrMap[t];
    var cr = d.worked > 0 ? (d.sales / d.worked) : 0;
    var cov = d.total > 0 ? (d.worked / d.total) : 0;
    return {
      name:            t,
      totalHomes:      d.total,
      knocked:         d.worked,
      pending:         d.pending,
      coveragePct:     Math.round(cov * 100),
      sales:           d.sales,
      mega:            d.mega,
      gig:             d.gig,
      closeRatePct:    Math.round(cr * 100),
      notHome:         d.nothome,
      fibercompetitor:     d.fibercompetitor,
      inContract:      d.incontract,
      goBack:          d.goback,
      notInterested:   d.notinterested,
      vacant:          d.vacant,
      business:        d.business,
      existingCustomers: d.existingCustomers
    };
  });

  // --- Overall metrics ---
  var totalWorked = knockable.filter(function(a){
    var s = (a.status||'pending').toLowerCase();
    return s !== 'pending' && s !== '' && s !== 'homes passed';
  }).length;
  var totalSold = knockable.filter(function(a){
    return a.status === 'mega' || a.status === 'gig';
  }).length;
  var totalMega = knockable.filter(function(a){ return a.status === 'mega'; }).length;
  var totalGig  = knockable.filter(function(a){ return a.status === 'gig';  }).length;
  var pending   = knockable.filter(function(a){
    var s = (a.status||'pending').toLowerCase();
    return !s || s === 'pending';
  }).length;
  var globalCR  = totalWorked > 0 ? totalSold / totalWorked : 0;
  var gigMix    = totalSold   > 0 ? totalGig  / totalSold   : 0;

  // --- Stale follow-up summary ---
  var stale = typeof getStaleAddresses === 'function' ? getStaleAddresses() : [];
  var staleByTerritory = {};
  stale.forEach(function(a) {
    var t = (a.territory || 'Unknown').trim();
    if (!staleByTerritory[t]) staleByTerritory[t] = { goBack: 0, notHome: 0 };
    if (a.status === 'goback')   staleByTerritory[t].goBack++;
    else                         staleByTerritory[t].notHome++;
  });

  // --- Forecast ---
  var MEGA_MRR = 29.95 + 5.00 + 1.00;
  var GIG_MRR  = 30.00 + 5.00 + 1.00;
  var currentMRR  = (totalMega * MEGA_MRR) + (totalGig * GIG_MRR);
  var projSales   = Math.round(pending * globalCR);
  var projGig     = Math.round(projSales * (gigMix || 0.40));
  var projMega    = projSales - projGig;
  var projMRR     = currentMRR + (projMega * MEGA_MRR) + (projGig * GIG_MRR);

  return {
    generatedAt:     new Date().toISOString(),
    summary: {
      totalKnockableHomes: knockable.length,
      totalKnocked:        totalWorked,
      totalPending:        pending,
      totalSales:          totalSold,
      megaSales:           totalMega,
      gigSales:            totalGig,
      globalCloseRatePct:  Math.round(globalCR * 100),
      gigMixPct:           Math.round(gigMix * 100),
      currentMRR:          Math.round(currentMRR),
      projectedMRR:        Math.round(projMRR),
      projectedAdditionalSales: projSales,
      totalFollowUps:      stale.length,
      onlineReps:          repSummary.filter(function(r){ return r.online; }).length,
      totalReps:           repSummary.length
    },
    territories:     territoryStats,
    reps:            repSummary,
    followUpsByTerritory: staleByTerritory
  };
}

// ── Run the analysis ───────────────────────────────────────
function runAIAnalysis() {}

// ── Render the structured result ───────────────────────────
function renderAIResult(data) {
  var output = document.getElementById('ai-output');
  if (!output) return;
  output.className = 'ai-output-active';

  var r = data.analysis || {};
  var html = '';

  // ── Summary grid ───────────────────────────────────────
  if (r.headline) {
    html += '<div class="ai-section">' +
      '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px;line-height:1.4">' +
        escHtml(r.headline) +
      '</div>';
    if (r.situation) {
      html += '<div style="font-size:12.5px;color:var(--muted);line-height:1.6;margin-bottom:10px">' +
        escHtml(r.situation) + '</div>';
    }
    html += '</div>';
  }

  // ── Key metrics row ────────────────────────────────────
  if (r.metrics && r.metrics.length) {
    html += '<div class="ai-summary-grid">';
    r.metrics.forEach(function(m) {
      html += '<div class="ai-summary-cell">' +
        '<div class="ai-summary-val">' + escHtml(String(m.value)) + '</div>' +
        '<div class="ai-summary-lbl">' + escHtml(m.label) + '</div>' +
      '</div>';
    });
    html += '</div>';
  }

  // ── Deployment recommendations ─────────────────────────
  if (r.recommendations && r.recommendations.length) {
    html += '<div class="ai-section">' +
      '<div class="ai-section-head">🎯 Deployment Recommendations</div>';
    r.recommendations.forEach(function(rec) {
      var pri = (rec.priority || 'medium').toLowerCase();
      html += '<div class="ai-rec-card priority-' + escHtml(pri) + '">' +
        '<div class="ai-rec-header">' +
          '<span class="ai-rec-priority">' + pri.toUpperCase() + '</span>' +
          '<div>' +
            (rec.territory ? '<div class="ai-rec-territory">📍 ' + escHtml(rec.territory) + '</div>' : '') +
            '<div class="ai-rec-action">' + escHtml(rec.action) + '</div>' +
          '</div>' +
        '</div>' +
        (rec.reasoning ? '<div class="ai-rec-detail">' + escHtml(rec.reasoning) + '</div>' : '') +
      '</div>';
    });
    html += '</div>';
  }

  // ── Insights ───────────────────────────────────────────
  if (r.insights && r.insights.length) {
    html += '<div class="ai-section">' +
      '<div class="ai-section-head">💡 Key Insights</div>';
    r.insights.forEach(function(ins) {
      html += '<div class="ai-insight-row">' +
        '<span class="ai-insight-icon">' + escHtml(ins.icon || '▸') + '</span>' +
        '<span>' + escHtml(ins.text) + '</span>' +
      '</div>';
    });
    html += '</div>';
  }

  // ── Rep coaching ───────────────────────────────────────
  if (r.repCoaching && r.repCoaching.length) {
    html += '<div class="ai-section">' +
      '<div class="ai-section-head">👤 Rep Coaching Notes</div>';
    r.repCoaching.forEach(function(note) {
      html += '<div class="ai-insight-row">' +
        '<span class="ai-insight-icon">•</span>' +
        '<span><strong>' + escHtml(note.rep) + '</strong> — ' + escHtml(note.note) + '</span>' +
      '</div>';
    });
    html += '</div>';
  }

  // ── Today's focus ──────────────────────────────────────
  if (r.todaysFocus) {
    html += '<div class="ai-section">' +
      '<div class="ai-section-head">⚡ Today\'s Focus</div>' +
      '<div style="background:rgba(0,86,150,.1);border:1px solid rgba(0,86,150,.25);border-radius:10px;padding:14px 16px;font-size:13px;color:var(--text);line-height:1.6">' +
        escHtml(r.todaysFocus) +
      '</div>' +
    '</div>';
  }

  output.innerHTML = html || '<div class="ai-output-placeholder"><div class="ai-placeholder-icon">✅</div>Analysis complete but no structured output returned. Check Apps Script logs.</div>';
}

function renderAIError(msg) {
  var output = document.getElementById('ai-output');
  if (output) {
    output.className = 'ai-output-active';
    output.innerHTML = '<div class="ai-error-box">⚠ ' + escHtml(msg) + '</div>';
    output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
