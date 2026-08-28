/*
 * Receives the Pi's nightly backup archive and files it away.
 *
 * WHAT THIS IS FOR
 *
 * The Pi's backups live on the same disk they are backing up, which covers a
 * bad delete or a corrupted database but not the disk dying - and that disk has
 * already dropped offline once under load. So a copy comes here.
 *
 * The Pi uploads; this machine never reaches into the Pi. That means nothing on
 * this PC needs standing credentials to the Pi, and nothing here runs on a
 * timer.
 *
 * WHY NOT FTP, AND WHY NOT SSH
 *
 * An FTP or SSH server accepts whatever it is handed and writes it wherever the
 * account can reach. This accepts exactly one thing - a gzipped tar whose name
 * matches the Pi's archive pattern and whose checksum the sender declared up
 * front - and can write to exactly one directory. Anything else is refused
 * before a byte is kept.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never extracts the archive. Unpacking untrusted tars is where path
 * traversal bugs live, and there is no reason to unpack: the file only needs to
 * sit here until someone needs it. It also serves nothing - there is no GET, no
 * listing, no way to read a backup back out over this port.
 *
 * BINDING
 *
 * It listens on the Tailscale address only, never 0.0.0.0. The wifi this
 * machine sits on is not ours, and a port bound to every interface would be
 * reachable by anyone else on it. Tailscale also means the transport is already
 * encrypted and the peer is already authenticated - the shared key below is a
 * second lock, not the only one.
 *
 *   node backup-receiver.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// HOME is where this program and its key and log live. ARCHIVES is where the
// backups land, and nothing else does - so the folder you open when you need a
// restore contains backups and only backups, sorted by name into date order.
// Mixing the two means the thing you are looking for is buried among a script,
// a key file and a log.
const HOME     = process.env.BACKUP_HOME || 'D:\\Backups\\pi';
const ARCHIVES = process.env.BACKUP_DEST || path.join(HOME, 'archives');
const BIND     = process.env.BACKUP_BIND || '100.72.210.100';
const PORT     = parseInt(process.env.BACKUP_PORT || '8899', 10);
const KEEP     = parseInt(process.env.BACKUP_KEEP || '7', 10);
const KEY_FILE = process.env.BACKUP_KEY_FILE || path.join(HOME, 'receiver.key');

const MIN_BYTES = 1 * 1024 * 1024;          // smaller than this is not a real backup
const MAX_BYTES = 4 * 1024 * 1024 * 1024;   // refuse to be used as a disk filler
const NAME_RE   = /^media-stack-\d{8}-\d{6}\.tar\.gz$/;

const INCOMING = path.join(ARCHIVES, '.incoming');
fs.mkdirSync(INCOMING, { recursive: true });

const KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
if (KEY.length < 32) { console.error('key too short - refusing to start'); process.exit(1); }

function log(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(HOME, 'receiver.log'), line + '\n');
}

// Length-independent compare. A plain === leaks how much of the key matched
// through timing, which is worth avoiding even behind Tailscale.
function keyOk(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Is this actually a gzipped tar? Two checks, because the checksum only proves
// the bytes arrived as the sender described them - not that the sender sent a
// backup. Gzip magic first, then the ustar marker that sits at offset 257 of a
// tar's first header block.
function looksLikeTarGz(file) {
  return new Promise((resolve) => {
    const head = Buffer.alloc(2);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, head, 0, 2, 0);
    } catch { return resolve(false); } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (head[0] !== 0x1f || head[1] !== 0x8b) return resolve(false);

    const chunks = [];
    let seen = 0, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const rs = fs.createReadStream(file);
    const gz = zlib.createGunzip();
    gz.on('data', (c) => {
      chunks.push(c); seen += c.length;
      if (seen >= 512) {
        const b = Buffer.concat(chunks, 512);
        rs.destroy(); gz.destroy();
        finish(b.slice(257, 262).toString('ascii') === 'ustar');
      }
    });
    gz.on('error', () => finish(false));
    rs.on('error', () => finish(false));
    gz.on('end', () => finish(false));
    rs.pipe(gz);
  });
}

function rotate() {
  const files = fs.readdirSync(ARCHIVES).filter((f) => NAME_RE.test(f)).sort().reverse();
  for (const f of files.slice(KEEP)) {
    fs.unlinkSync(path.join(ARCHIVES, f));
    log(`rotated out ${f}`);
  }
  return Math.min(files.length, KEEP);
}

// What is arriving right now, for GET /status. The receiver is the only thing
// that knows how many bytes have actually landed - the sender only knows what
// it has handed to the kernel - so live upload progress has to come from here.
let inflight = null;

const server = http.createServer((req, res) => {
  const reply = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg + '\n'); };

  // Read-only status, for the dashboard on the Pi. This is the ONE thing this
  // server answers besides an upload. It still requires the key, still writes
  // nothing, and still reveals nothing but counts and sizes - so "the Pi
  // pushes, the PC never reaches in" holds: the PC initiates nothing here
  // either, it only answers a question the Pi asked.
  if (req.method === 'GET' && req.url === '/status') {
    if (!keyOk(req.headers['x-backup-key'])) return reply(401, 'no');
    let files = [];
    try {
      files = fs.readdirSync(ARCHIVES)
        .filter((f) => NAME_RE.test(f))
        .map((f) => ({ name: f, st: fs.statSync(path.join(ARCHIVES, f)) }))
        .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    } catch { /* fall through to an empty report rather than a 500 */ }
    const body = {
      archives: files.length,
      bytes: files.reduce((n, f) => n + f.st.size, 0),
      newest: files.length ? files[0].name : null,
      newestAt: files.length ? new Date(files[0].st.mtimeMs).toISOString() : null,
      keep: KEEP,
      uploading: Boolean(inflight),
      uploadName: inflight ? inflight.name : null,
      uploadReceived: inflight ? inflight.received : 0,
      uploadTotal: inflight ? inflight.total : 0,
      uploadPercent: inflight && inflight.total
        ? Math.round((inflight.received / inflight.total) * 100) : 0,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }

  // PUT as well as POST: curl -T streams the file straight off disk, where
  // --data-binary @file reads the whole thing into memory first. On a Pi with
  // 8GB and a half-gigabyte archive that difference is worth having.
  const method = req.method === 'POST' || req.method === 'PUT';
  if (!method || req.url !== '/upload') return reply(404, 'no');
  if (!keyOk(req.headers['x-backup-key'])) {
    log(`REFUSED bad key from ${req.socket.remoteAddress}`);
    return reply(401, 'no');
  }

  // basename only, and it must match the Pi's own naming. This is what keeps
  // the write confined to ARCHIVES no matter what the sender claims.
  const name = path.basename(String(req.headers['x-backup-name'] || ''));
  const want = String(req.headers['x-backup-sha256'] || '').toLowerCase();
  // Log these too. A rejected name is the signature of someone probing for a
  // path traversal, and a refusal nobody can see afterwards is not much of a
  // refusal.
  if (!NAME_RE.test(name)) {
    log(`REFUSED bad name '${name}' from ${req.socket.remoteAddress}`);
    return reply(400, 'bad name');
  }
  if (!/^[0-9a-f]{64}$/.test(want)) {
    log(`REFUSED bad checksum header for ${name}`);
    return reply(400, 'bad checksum');
  }

  const tmp = path.join(INCOMING, `${process.pid}-${Date.now()}.part`);
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  let size = 0, aborted = false;
  inflight = {
    name,
    received: 0,
    total: Number(req.headers['content-length'] || 0),
    startedAt: Date.now(),
  };

  const scrap = (code, msg) => {
    aborted = true;
    inflight = null;
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    log(`REFUSED ${name}: ${msg}`);
    reply(code, msg);
  };

  // Destroying `out` inside scrap() makes it emit ERR_STREAM_DESTROYED. With
  // no listener that is an unhandled stream error, which takes the WHOLE
  // process down - which is precisely how this receiver died on 26 and again
  // on 28 August, leaving the task gone and nothing receiving. The aborted
  // guard keeps scrap() from re-entering itself when it destroys the stream.
  out.on('error', (e) => {
    if (!aborted) scrap(500, `write failed: ${e.code || e.message}`);
  });

  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (inflight) inflight.received = size;
    if (size > MAX_BYTES) return scrap(413, 'too large');
    hash.update(c);
    // Respect backpressure. Ignoring the return value buffers the whole
    // upload in memory when the disk cannot keep up, which on a multi-gigabyte
    // archive is how a receiver runs itself out of heap.
    if (!out.write(c)) {
      req.pause();
      out.once('drain', () => req.resume());
    }
  });

  req.on('error', () => { if (!aborted) scrap(400, 'transfer error'); });

  req.on('end', async () => {
    if (aborted) return;
    out.end();
    out.on('close', async () => {
      if (size < MIN_BYTES) return scrap(400, `too small (${size} bytes)`);
      const got = hash.digest('hex');
      if (got !== want) return scrap(400, 'checksum mismatch');
      if (!(await looksLikeTarGz(tmp))) return scrap(400, 'not a gzipped tar');

      fs.renameSync(tmp, path.join(ARCHIVES, name));
      const kept = rotate();
      const mb = (size / 1048576).toFixed(0);
      log(`OK ${name}  ${mb} MB  verified  (${kept} kept)`);
      inflight = null;
      reply(200, 'ok');
    });
  });
});

// Started at boot, this races Tailscale: the address it wants to bind to does
// not exist until tailscaled has come up and been assigned it, and a bind to a
// missing address fails immediately with EADDRNOTAVAIL. Without a retry the
// service would die seconds into every boot and nothing would ever be received
// - silently, because the failure happens before anything is listening to
// complain about.
// Node defaults server.requestTimeout to 300s, which silently caps every
// upload at five minutes. The 288M and 1.1G archives finished inside that and
// were delivered; 1.8G and 2.5G never could, so each attempt died at 408 and
// the queue grew without ever draining. Match the sender, which already bounds
// itself with curl --max-time 3600.
server.requestTimeout = 3600 * 1000;

let announced = false;
function start() {
  server.listen(PORT, BIND, () => {
    announced = true;
    log(`listening on ${BIND}:${PORT}, writing to ${ARCHIVES}`);
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRNOTAVAIL' || e.code === 'EADDRINUSE') {
    if (!announced) {
      // Log the first attempt only. Retrying every 10s for a few minutes would
      // otherwise fill the log with the same line before Tailscale is ready.
      if (!start.warned) { log(`waiting for ${BIND} (${e.code})`); start.warned = true; }
      setTimeout(start, 10000);
      return;
    }
  }
  log(`FATAL ${e.code || e.message}`);
  process.exit(1);
});

start();
