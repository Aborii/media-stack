/* Make service links follow whatever host you arrived on.
 *
 * href in services.yaml has to hard-code one hostname, but the right one
 * depends on where you are:
 *
 *   http://aboriis-pi/                    -> links should stay aboriis-pi
 *   http://aboriis-pi.tail54d520.ts.net/  -> links should use that name too
 *
 * Nothing about the tailnet is hard-coded below - it reads whatever is in the
 * address bar, so it keeps working if the tailnet name ever changes.
 *
 * Homepage loads this via <Script src="/api/config/custom.js"> on the dashboard
 * page, and serves it ONLY to authenticated users - with auth off it is fetched
 * by nothing and does nothing.
 *
 * Progressive enhancement: if it never runs, links stay on aboriis-pi, which
 * resolves everywhere anyway. Nothing breaks, you just get the old behaviour.
 */
(function () {
  var CANON = "aboriis-pi";   // the hostname written into services.yaml
  var pending = false;

  function rewrite() {
    pending = false;
    var here = window.location.hostname;
    if (!here || here === CANON) return;   // already correct, nothing to do

    var links = document.getElementsByTagName("a");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (!a.href || a.href.indexOf(CANON) === -1) continue;
      try {
        var u = new URL(a.href, window.location.href);
        // Only service tiles: this Pi, and an explicit port. Leave anything
        // else alone so internal navigation is untouched.
        if (u.hostname === CANON && u.port) {
          u.hostname = here;
          a.href = u.toString();
        }
      } catch (e) { /* unparseable href - skip */ }
    }
  }

  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(rewrite, 50);   // coalesce bursts of DOM updates
  }

  function start() {
    rewrite();
    // Homepage is a single-page app: tiles render and re-render after load, so
    // a single pass at DOMContentLoaded catches almost nothing.
    if (window.MutationObserver && document.body) {
      new MutationObserver(schedule).observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
