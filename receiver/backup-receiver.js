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

const DEST     = process.env.BACKUP_DEST || 'D:\\Backups\\pi';
const BIND     = process.env.BACKUP_BIND || '100.72.210.100';
const PORT     = parseInt(process.env.BACKUP_PORT || '8899', 10);
const KEEP     = parseInt(process.env.BACKUP_KEEP || '7', 10);
const KEY_FILE = process.env.BACKUP_KEY_FILE || path.join(DEST, 'receiver.key');

const MIN_BYTES = 1 * 1024 * 1024;          // smaller than this is not a real backup
const MAX_BYTES = 4 * 1024 * 1024 * 1024;   // refuse to be used as a disk filler
const NAME_RE   = /^media-stack-\d{8}-\d{6}\.tar\.gz$/;

const INCOMING = path.join(DEST, '.incoming');
fs.mkdirSync(INCOMING, { recursive: true });

const KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
if (KEY.length < 32) { console.error('key too short - refusing to start'); process.exit(1); }

function log(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(DEST, 'receiver.log'), line + '\n');
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
  const files = fs.readdirSync(DEST).filter((f) => NAME_RE.test(f)).sort().reverse();
  for (const f of files.slice(KEEP)) {
    fs.unlinkSync(path.join(DEST, f));
    log(`rotated out ${f}`);
  }
  return Math.min(files.length, KEEP);
}

const server = http.createServer((req, res) => {
  const reply = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg + '\n'); };

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
  // the write confined to DEST no matter what the sender claims.
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

  const scrap = (code, msg) => {
    aborted = true;
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    log(`REFUSED ${name}: ${msg}`);
    reply(code, msg);
  };

  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BYTES) return scrap(413, 'too large');
    hash.update(c);
    out.write(c);
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

      fs.renameSync(tmp, path.join(DEST, name));
      const kept = rotate();
      const mb = (size / 1048576).toFixed(0);
      log(`OK ${name}  ${mb} MB  verified  (${kept} kept)`);
      reply(200, 'ok');
    });
  });
});

server.listen(PORT, BIND, () => log(`listening on ${BIND}:${PORT}, writing to ${DEST}`));
