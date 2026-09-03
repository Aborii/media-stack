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

  btn.disabled = true;
  btn.textContent = 'Starting…';
  let reply;
  try {
    const r = await fetch(BACKUP + 'run', { method: 'POST' });
    reply = (await r.text()).trim();
  } catch {
    // No CORS header yet: the POST still landed, the reply is unreadable.
    reply = 'Requested';
  }
  btn.textContent = reply;

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
      btn.textContent = 'Backup running…';
      return;
    }
    // Finished - or never started (refused, cooldown): give up after a
    // minute either way and hand the button back.
    if (sawRunning || Date.now() - started > 60000) {
      clearInterval(poll);
      btn.disabled = false;
      btn.textContent = sawRunning ? 'Done - run again' : reply;
    }
  }, 3000);
}

if (!window.glanceLive) {
  window.glanceLive = { refresh, runBackup, timer: setInterval(refresh, EVERY) };
}
