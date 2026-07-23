(function() {
  'use strict';

  const SUPABASE_URL = window.FIELDOS_SUPABASE_URL || 'https://zyioicczczmlsksxysqw.supabase.co';
  const SUPABASE_ANON_KEY = window.FIELDOS_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5aW9pY2N6Y3ptbHNrc3h5c3F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MzYyODMsImV4cCI6MjA5ODMxMjI4M30.Wfcn5_JA73k-Dq6YX0KpHZ3HLNsWa87v7TE3owDpOyM';
  const SESSION_KEY = 'fieldos_user_activity_session_id';
  const HEARTBEAT_MS = 60 * 1000;

  if (!window.supabase || !SUPABASE_URL || !SUPABASE_ANON_KEY) return;

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'sess-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function sessionId() {
    try {
      let id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = uuid();
        sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (e) {
      if (!window.__fieldosActivitySessionId) window.__fieldosActivitySessionId = uuid();
      return window.__fieldosActivitySessionId;
    }
  }

  function valueFromEl(selector) {
    const el = document.querySelector(selector);
    return el && 'value' in el ? String(el.value || '').trim() : '';
  }

  function localValue(key) {
    try { return String(localStorage.getItem(key) || '').trim(); } catch (e) { return ''; }
  }

  function urlTeam() {
    try { return String(new URLSearchParams(window.location.search).get('team') || '').trim().toLowerCase(); } catch (e) { return ''; }
  }

  function detectTeam() {
    const fromUrl = urlTeam();
    if (fromUrl) return fromUrl;
    if (window.FIELDOS_TEAM_SLUG) return String(window.FIELDOS_TEAM_SLUG || '').trim().toLowerCase();
    const fromSelect = valueFromEl('#team-select') || valueFromEl('#team-filter');
    if (fromSelect && fromSelect !== 'all') return fromSelect.toLowerCase();
    const stored = localValue('fieldos_team');
    if (stored) return stored.toLowerCase();
    if (location.pathname.indexOf('team-dashboard') >= 0 || location.pathname.indexOf('company-sales-dashboard') >= 0) return 'all';
    return '';
  }

  function detectRepName() {
    return localValue('zito_rep_name') || valueFromEl('#rep-name') || valueFromEl('#rep-filter') || '';
  }

  function detectRole() {
    const p = location.pathname.toLowerCase();
    if (p.includes('admin')) return 'company_admin_dashboard';
    if (p.includes('live-activity')) return 'company_admin_live_activity';
    if (p.includes('sales-review')) return 'company_admin_sales_review';
    if (p.includes('setup')) return 'company_admin_setup';
    if (p.includes('pricing')) return 'company_admin_pricing';
    if (p.includes('management')) return 'company_admin_management';
    if (p.includes('team-dashboard') || p.includes('company-sales-dashboard') || p.includes('fiber-dashboard') || p.includes('sfi-dashboard') || p.includes('lynxx-dashboard')) return 'sales_dashboard';
    return 'field_app';
  }

  function detectPageName() {
    const p = location.pathname.toLowerCase();
    if (p.includes('live-activity')) return 'Live User Activity';
    if (p.includes('admin')) return 'Company Admin Dashboard';
    if (p.includes('sales-review')) return 'Sales Review';
    if (p.includes('setup')) return 'Setup Center';
    if (p.includes('pricing')) return 'Pricing Center';
    if (p.includes('management')) return 'Management Overview';
    if (p.includes('fiber-dashboard')) return 'Fiber Sales Team Dashboard';
    if (p.includes('sfi-dashboard')) return 'Sales Focus Inc. Dashboard';
    if (p.includes('lynxx-dashboard')) return 'Lynxx Dashboard';
    if (p.includes('team-dashboard') || p.includes('company-sales-dashboard')) return 'Company Sales Dashboard';
    return 'FieldOS Field App';
  }

  async function getUserEmail() {
    try {
      const sessionRes = await client.auth.getSession();
      const email = sessionRes && sessionRes.data && sessionRes.data.session && sessionRes.data.session.user && sessionRes.data.session.user.email;
      if (email) return String(email).trim().toLowerCase();
    } catch (e) {}
    return localValue('zito_rep_email') || '';
  }

  async function ping() {
    try {
      await client.rpc('fieldos_user_activity_upsert', {
        p_session_id: sessionId(),
        p_user_email: await getUserEmail(),
        p_rep_name: detectRepName(),
        p_team_slug: detectTeam(),
        p_role: detectRole(),
        p_page_name: detectPageName(),
        p_page_url: window.location.href,
        p_user_agent: navigator.userAgent || ''
      });
    } catch (e) {
      // Tracking should never interrupt the app.
      if (window.FIELDOS_ACTIVITY_DEBUG) console.warn('FieldOS activity tracking skipped:', e);
    }
  }

  async function end() {
    try { await client.rpc('fieldos_user_activity_end', { p_session_id: sessionId() }); } catch (e) {}
  }

  window.FieldOSUserActivity = { ping, end, sessionId };

  function scheduleInitialPings() {
    setTimeout(ping, 1200);
    setTimeout(ping, 10000);
    setTimeout(ping, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInitialPings);
  } else {
    scheduleInitialPings();
  }

  setInterval(ping, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) ping();
  });
  window.addEventListener('focus', ping);

  try {
    client.auth.onAuthStateChange(function(event) {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') ping();
      if (event === 'SIGNED_OUT') end();
    });
  } catch (e) {}
})();
