// Live updates for the Glance dashboard.
//
// Glance renders every widget on the server when the page loads and then
// does nothing until the next load - its FAQ says so. This script closes
// that gap for the tiles that change by the second, without a second copy
// of any template and without an API key ever reaching the browser: every
// few seconds it re-fetches Glance's own rendered page content and swaps in
// the tiles marked data-live. Each tile's `cache` in glance.yml is still
// what decides how often the server actually re-fetches its source, so
// the heavy tiles cost nothing extra.
//
// How it gets here: Glance inserts widget HTML with innerHTML, which never
// runs a <script> tag but does keep on* attributes - so the prayer tile
// carries a hidden image whose onload does `import('/assets/live.js')`.
// Served from the assets-path in glance.yml. The import is a no-op after
// the first time, so the tile being replaced by itself is harmless.

const CONTENT = '/api/pages/home/content/';
const EVERY   = 5000;
const BACKUP  = 'http://aboriis-pi:9101/';   // the browser's route to it
const PCSW    = 'http://aboriis-pi:9102/';   // the power switch proxy

// Replaces every [data-live] element, and the server-stats widget, with the
// freshly rendered copy. Skipped while the tab is hidden: a dashboard left
// open in a background tab should not poll the Pi all night.
async function refresh() {
  if (document.hidden) return;
  let doc;
  try {
    const r = await fetch(CONTENT, { cache: 'no-store' });
    if (!r.ok) return;
    doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  } catch {
    return;                                   // the Pi will be back
  }
  for (const el of document.querySelectorAll('[data-live]')) {
    const fresh = doc.querySelector(`[data-live="${el.dataset.live}"]`);
    if (fresh) el.replaceWith(fresh);
  }
  // Glance's own widget, so there is no template to put a marker in.
  const stats = document.querySelector('.widget-type-server-stats');
  const freshStats = doc.querySelector('.widget-type-server-stats');
  if (stats && freshStats) stats.replaceWith(freshStats);
}

// "19 hours ago", the same wording the templates use.
function ago(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  const n = m < 60 ? m : m < 1440 ? Math.floor(m / 60) : Math.floor(m / 1440);
  const unit = m < 60 ? 'minute' : m < 1440 ? 'hour' : 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

// The Run button on the Backups tile. Posts the same /run the status page
// posts, shows the service's reply on the button, then follows the run by
// polling the status JSON every few seconds and writing the fields into
// the tile until the backup has finished.
async function runBackup(btn) {
  const tile = btn.closest('.widget') || document;
  const set = (k, v) => tile.querySelectorAll(`[data-backup="${k}"]`).forEach((e) => { e.textContent = v; });

  // The button is small and sits beside the state, so it only ever says
  // Run; what the service answered goes in the msg span next to it.
  btn.disabled = true;
  set('msg', 'starting…');
  let reply;
  try {
    const r = await fetch(BACKUP + 'run', { method: 'POST' });
    reply = (await r.text()).trim();
  } catch {
    // No CORS header yet: the POST still landed, the reply is unreadable.
    reply = 'requested';
  }
  set('msg', reply);

  const started = Date.now();
  let sawRunning = false;
  const poll = setInterval(async () => {
    let d;
    try {
      d = await (await fetch(BACKUP, { cache: 'no-store' })).json();
    } catch {
      return;
    }
    set('state', d.state);
    set('onpc', d.pc_archives);
    set('built', ago(d.last_backup + '+04:00'));
    set('delivered', ago(d.last_sent));
    if (d.backing_up) {
      sawRunning = true;
      set('msg', 'running…');
      return;
    }
    // Finished - or never started (refused, cooldown): give up after a
    // minute either way and hand the button back.
    if (sawRunning || Date.now() - started > 60000) {
      clearInterval(poll);
      btn.disabled = false;
      set('msg', sawRunning ? 'done' : reply);
    }
  }, 3000);
}

// The Desktop tile's buttons. Presses through the proxy - the token lives
// there, not here - then watches the state until it settles.
//
// The watch is the point. The PC's own power LED takes about six seconds to
// be classified (the switch counts edges to tell a sleep blink from a boot),
// so pressing and then waiting for the tile's ordinary refresh would look
// like nothing happened. This polls every 2 s for a minute and stops the
// moment the state changes, which is the "detected refetch" a boot deserves.
// `state` is what the tile last read, so the question names what will
// actually happen rather than "send a press". Every action asks, including
// powering on: the point of a confirmation here is that these buttons sit on
// a dashboard being scrolled past, where a stray tap is the likely way any of
// them ever gets pressed.
const PC_ASK = {
  'off':     'Power on the desktop?',
  'on':      'Ask the desktop to shut down?\n\nIt closes programs first, like tapping the case button - but anything unsaved will prompt, and it may sit waiting.',
  'sleep':   'Wake the desktop from sleep?',
  'unknown': 'Send a power press to the desktop?\n\nIts state is unknown, so this either boots it or asks it to shut down.',
};

async function pcPress(btn, what, state) {
  const tile = btn.closest('.widget') || document;
  const set = (k, v) => tile.querySelectorAll(`[data-pc="${k}"]`).forEach((e) => { e.textContent = v; });
  const buttons = [...tile.querySelectorAll('[data-pc="press"],[data-pc="force"]')];

  const ask = what === 'force-off'
    ? 'Force off the desktop?\n\nThis cuts power like holding the button in for six seconds. Unsaved work is lost and the disk is not unmounted cleanly.'
    : (PC_ASK[state] || PC_ASK.unknown);
  if (!confirm(ask)) return;

  buttons.forEach((b) => { b.disabled = true; });
  set('msg', what === 'force-off' ? 'holding 6s…' : 'pressing…');

  let before = null;
  try {
    before = (await (await fetch(PCSW, { cache: 'no-store' })).json()).power;
  } catch { /* the press is worth trying anyway */ }

  try {
    const r = await fetch(PCSW + what, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) { set('msg', j.error || 'the switch refused'); buttons.forEach((b) => { b.disabled = false; }); return; }
    if (j.dry) {
      // Test mode: the proxy answered but sent nothing on, so there is no
      // state change coming and watching for one would just time out.
      set('msg', j.message || 'test mode: nothing sent');
      buttons.forEach((b) => { b.disabled = false; });
      return;
    }
  } catch {
    set('msg', 'proxy unreachable');
    buttons.forEach((b) => { b.disabled = false; });
    return;
  }
  set('msg', 'sent, watching…');

  const started = Date.now();
  const poll = setInterval(async () => {
    let d;
    try {
      d = await (await fetch(PCSW, { cache: 'no-store' })).json();
    } catch {
      return;
    }
    if (d.ok) {
      set('power', d.power || 'unknown');
      set('rssi', d.rssi + ' dBm');
    }
    const changed = d.ok && d.power && d.power !== before && d.power !== 'unknown';
    if (changed || Date.now() - started > 60000) {
      clearInterval(poll);
      buttons.forEach((b) => { b.disabled = false; });
      // The next 5 s swap redraws the whole tile from the server, which is
      // what puts the right label back on the button.
      set('msg', changed ? 'now ' + d.power : 'no change yet');
    }
  }, 2000);
}

// Replace whatever was here rather than standing aside for it. A page open
// since before an edit holds the old module - Glance serves this with a
// two-hour cache - and the tiles call these functions by name, so an old
// object still in place means a button that silently does nothing. Clearing
// the previous timer first is what stops two of them polling at once.
if (window.glanceLive && window.glanceLive.timer) clearInterval(window.glanceLive.timer);
window.glanceLive = { refresh, runBackup, pcPress, timer: setInterval(refresh, EVERY) };
