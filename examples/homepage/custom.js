/* Intentionally empty.
 *
 * A script here once rewrote service links to follow whatever host you arrived
 * on, because href has to hard-code one hostname while the right one seemed to
 * depend on where you were.
 *
 * It turned out to be unnecessary. "aboriis-pi" resolves in every case - the
 * router answers for the DHCP hostname at home, mDNS covers it as a fallback,
 * and tailscale MagicDNS covers it remotely - so one name works everywhere and
 * the links never need rewriting.
 *
 * Use http://aboriis-pi/ rather than the long tailnet name. That also keeps the
 * auth cookie on one host: HOMEPAGE_EXTERNAL_URL pins the login callback to a
 * single hostname, so arriving on a different one logs you straight back out.
 *
 * Worth knowing if you ever do want a script here: Homepage serves custom.js
 * only to authenticated users, so it does nothing at all with auth disabled.
 */
