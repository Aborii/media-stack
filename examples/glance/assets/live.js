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

// True while the desktop tile has a dialog open or a press in flight, so the
// refresh below leaves that one tile alone.
let pcBusy = false;

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
    // The desktop tile is left alone while one of its buttons is mid-flow:
    // a swap there would close a dialog being read, or wipe the progress
    // message with the server's own idea of the tile.
    if (el.dataset.live === 'pc' && pcBusy) continue;
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
/* ----------------------------------------------------------- confirm --- */

// A confirmation dialog in the page, rather than the browser's own.
//
// The native confirm() works, but it renders as the browser's chrome, cannot
// say which button is the dangerous one, and on some browsers is suppressed
// entirely after a few uses - which for a button that powers a machine off is
// the wrong failure. This is styled from Glance's own theme variables, so it
// belongs to the dashboard, and the destructive action is visibly red.
//
// It lives on <body>, not inside the tile, so the five-second tile swap
// cannot pull it out from under a decision being made.
let modalOpen = false;

function ask({ title, body, confirmText, danger }) {
  return new Promise((resolve) => {
    if (modalOpen) return resolve(false);          // one question at a time
    modalOpen = true;
    const returnTo = document.activeElement;

    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
      'justify-content:center;padding:20px;background:rgba(0,0,0,.6);backdrop-filter:blur(2px)';

    const box = document.createElement('div');
    box.style.cssText = 'max-width:420px;width:100%;padding:22px;border-radius:var(--border-radius,6px);' +
      'background:var(--color-widget-background,#1b1f24);border:1px solid var(--color-separator,#333);' +
      'box-shadow:0 18px 50px rgba(0,0,0,.55);color:var(--color-text-base,#e8ecf1)';

    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-size:var(--font-size-h3,1.1rem);font-weight:600;margin-bottom:8px;' +
      (danger ? 'color:var(--color-negative,#e5544d)' : 'color:var(--color-text-highlight,#fff)');

    const p = document.createElement('div');
    p.textContent = body;
    p.style.cssText = 'font-size:var(--font-size-h5,.9rem);line-height:1.5;white-space:pre-line;' +
      'color:var(--color-text-paragraph,#9aa4b0)';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:20px';

    const mk = (label, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:inherit;padding:8px 16px;border-radius:6px;cursor:pointer;' +
        'border:1px solid var(--color-separator,#3a444f);background:transparent;color:inherit' +
        (primary
          ? `;border-color:${danger ? 'var(--color-negative,#e5544d)' : 'var(--color-primary,#2fbf87)'}` +
            `;color:${danger ? 'var(--color-negative,#e5544d)' : 'var(--color-primary,#2fbf87)'};font-weight:600`
          : ';color:var(--color-text-paragraph,#9aa4b0)');
      row.appendChild(b);
      return b;
    };

    const cancel = mk('Cancel', false);
    const go = mk(confirmText, true);

    const done = (answer) => {
      if (!modalOpen) return;
      modalOpen = false;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      if (returnTo && returnTo.isConnected) returnTo.focus();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };

    cancel.onclick = () => done(false);
    go.onclick = () => done(true);
    // A click on the backdrop is a cancel; one inside the box is not.
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    document.addEventListener('keydown', onKey, true);

    box.append(h, p, row);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    // The safe button takes focus when the action is destructive, so a
    // reflexive Enter cancels rather than cuts the power.
    (danger ? cancel : go).focus();
  });
}

// `state` is what the tile last read, so the question names what will
// actually happen rather than "send a press". Every action asks, including
// powering on: these buttons sit on a dashboard being scrolled past, where a
// stray tap is the likeliest way any of them is ever pressed.
const PC_ASK = {
  'off':     { title: 'Power on the desktop?',
               body: 'Taps the power button for 300 ms, the same as pressing the case button.',
               confirmText: 'Power on' },
  'on':      { title: 'Shut down the desktop?',
               body: 'Asks Windows to shut down, the same as tapping the case button. It closes programs first, so anything unsaved will prompt and it may sit waiting.',
               confirmText: 'Shut down' },
  'sleep':   { title: 'Wake the desktop?',
               body: 'Taps the power button for 300 ms to bring it out of sleep.',
               confirmText: 'Wake' },
  'unknown': { title: 'Send a power press?',
               body: 'The switch cannot tell what the desktop is doing, so this either boots it or asks it to shut down.',
               confirmText: 'Press' },
};

const PC_ASK_FORCE = {
  title: 'Force off the desktop?',
  body: 'Holds the power button for six seconds, cutting power outright. Unsaved work is lost and the disk is not unmounted cleanly. Use this only when it has stopped responding.',
  confirmText: 'Force off',
  danger: true,
};

async function pcPress(btn, what, state) {
  const tile = btn.closest('.widget') || document;
  const set = (k, v) => tile.querySelectorAll(`[data-pc="${k}"]`).forEach((e) => { e.textContent = v; });
  const buttons = [...tile.querySelectorAll('[data-pc="press"],[data-pc="force"]')];

  // The tile must stop being swapped from under this: the dialog is a
  // decision in progress, and the messages below are written into elements
  // that a refresh would replace with the server's own copy.
  pcBusy = true;
  // Hands the buttons back at once, but holds the tile still for a moment
  // longer so the last message can be read before the server's copy of the
  // tile replaces it. Every exit goes through here - one that forgot would
  // leave this tile frozen for as long as the page stayed open.
  const finish = (holdMs = 4000) => {
    buttons.forEach((b) => { b.disabled = false; });
    if (holdMs) setTimeout(() => { pcBusy = false; }, holdMs);
    else pcBusy = false;
  };

  if (!await ask(what === 'force-off' ? PC_ASK_FORCE : (PC_ASK[state] || PC_ASK.unknown))) {
    pcBusy = false;
    return;
  }

  buttons.forEach((b) => { b.disabled = true; });
  set('msg', what === 'force-off' ? 'holding 6s…' : 'pressing…');

  let before = null;
  try {
    before = (await (await fetch(PCSW, { cache: 'no-store' })).json()).power;
  } catch { /* the press is worth trying anyway */ }

  try {
    const r = await fetch(PCSW + what, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) { set('msg', j.error || 'the switch refused'); finish(); return; }
    if (j.dry) {
      // Test mode: the proxy answered but sent nothing on, so there is no
      // state change coming and watching for one would just time out.
      set('msg', j.message || 'test mode: nothing sent');
      finish(6000);
      return;
    }
  } catch {
    set('msg', 'proxy unreachable');
    finish();
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
      // Once this releases, the next 5 s swap redraws the whole tile from
      // the server, which is what puts the right label back on the button.
      set('msg', changed ? 'now ' + d.power : 'no change yet');
      finish();
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
