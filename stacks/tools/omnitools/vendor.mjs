// Runs after `npm run build`. See the Dockerfile for why.
//
// 1. Copies every file the tools would fetch from a CDN into dist/vendor/,
//    laid out the way the CDN lays it out, so a URL only needs its host swapped.
// 2. Rewrites those CDN addresses in the built files to the page's own origin.
// 3. Fails the build if any of the outside hosts below is still mentioned.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const APP = '/app';
const DIST = join(APP, 'dist');
const VENDOR = join(DIST, 'vendor');
const NM = join(APP, 'node_modules');
const tmp = mkdtempSync(join(tmpdir(), 'vendor-'));

const pkgVersion = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;

function textFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) textFiles(path, out);
    else if (/\.(m?js|css|html)$/.test(name)) out.push(path);
  }
  return out;
}

const built = textFiles(DIST);
const builtText = built.map((f) => readFileSync(f, 'utf8')).join('\n');

// The version a URL in the built app asks for, e.g. "monaco-editor@0.52.2".
function versionIn(text, prefix) {
  const match = text.match(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([0-9][\\w.-]*)`));
  if (!match) throw new Error(`no version found after "${prefix}" in the built app`);
  return match[1];
}

// Unpacks a package from the npm registry and copies `sub` of it to `dest`.
function pack(spec, dest, sub = '.') {
  const tarball = execSync(`npm pack ${spec} --silent --pack-destination ${tmp}`).toString().trim();
  const dir = join(tmp, tarball.replace(/\.tgz$/, ''));
  execSync(`mkdir -p ${dir} && tar -xzf ${join(tmp, tarball)} -C ${dir}`);
  copy(join(dir, 'package', sub), dest);
}

function copy(from, dest) {
  mkdirSync(dirname(join(VENDOR, dest)), { recursive: true });
  cpSync(from, join(VENDOR, dest), { recursive: true, dereference: true });
  console.log(`vendored: ${dest}`);
}

// ── 1. The files ─────────────────────────────────────────────────────────────

// PDF editor (EmbedPDF): its engine, the fallback fonts for scripts a PDF does
// not embed, and the stamp library. The fonts are asked for both by version and
// as "latest", depending on the caller.
copy(join(NM, '@embedpdf/pdfium'), `npm/@embedpdf/pdfium@${versionIn(builtText, '@embedpdf/pdfium@')}`);
for (const script of ['jp', 'kr', 'sc', 'tc', 'arabic', 'hebrew', 'latin']) {
  const from = join(NM, `@embedpdf/fonts-${script}`);
  const versioned = `npm/@embedpdf/fonts-${script}@${pkgVersion(from)}`;
  copy(from, versioned);
  symlinkSync(`fonts-${script}@${pkgVersion(from)}`, join(VENDOR, `npm/@embedpdf/fonts-${script}@latest`));
}
pack('@embedpdf/default-stamps', 'npm/@embedpdf/default-stamps');

// Code editor (Monaco) used by the JSON, XML and similar tools.
const monaco = versionIn(builtText, 'monaco-editor@');
pack(`monaco-editor@${monaco}`, `npm/monaco-editor@${monaco}/min`, 'min');

// Image compression runs in a worker that loads the library again by URL.
const compression = versionIn(builtText, 'browser-image-compression@');
pack(`browser-image-compression@${compression}`, `npm/browser-image-compression@${compression}`);

// OCR (Tesseract): the worker, its engine, and the languages the tool offers.
// The worker asks for the engine as "tesseract.js-core@v" plus its own
// dependency range minus the first character, so "^6.0.0" becomes "v6.0.0".
const tesseract = join(NM, 'tesseract.js');
const tesseractPkg = JSON.parse(readFileSync(join(tesseract, 'package.json'), 'utf8'));
copy(join(tesseract, 'dist'), `npm/tesseract.js@v${tesseractPkg.version}/dist`);
copy(
  join(NM, 'tesseract.js-core'),
  `npm/tesseract.js-core@v${tesseractPkg.dependencies['tesseract.js-core'].substring(1)}`
);
const ocrService = readFileSync(join(APP, 'src/pages/tools/image/generic/image-to-text/service.ts'), 'utf8');
const languages = [...ocrService.matchAll(/value: '([a-z_]+)'/g)].map((m) => m[1]);
if (!languages.length) throw new Error('no OCR languages found in image-to-text/service.ts');
for (const lang of languages) {
  pack(`@tesseract.js-data/${lang}`, `npm/@tesseract.js-data/${lang}/4.0.0_best_int`, '4.0.0_best_int');
}

// Video and audio tools (ffmpeg). The built URL is assembled at run time, so
// the version comes from the source.
const ffmpeg = versionIn(readFileSync(join(APP, 'src/lib/ffmpeg.ts'), 'utf8'), "CORE_VERSION = '");
pack(`@ffmpeg/core@${ffmpeg}`, `npm/@ffmpeg/core@${ffmpeg}/dist`, 'dist');

// Background removal: the models and their runtime. npm stops at an older
// data release, so these come from img.ly's own host: resources.json lists
// every file as hash-named chunks, and each chunk is checked against its hash.
const imgly = pkgVersion(join(NM, '@imgly/background-removal'));
const imglyBase = `https://staticimgly.com/@imgly/background-removal-data/${imgly}/dist/`;
const imglyDir = join(VENDOR, `staticimgly/@imgly/background-removal-data/${imgly}/dist`);
mkdirSync(imglyDir, { recursive: true });
const resourcesRes = await fetch(`${imglyBase}resources.json`);
if (!resourcesRes.ok) throw new Error(`resources.json: HTTP ${resourcesRes.status}`);
const resources = await resourcesRes.text();
writeFileSync(join(imglyDir, 'resources.json'), resources);
for (const { chunks } of Object.values(JSON.parse(resources))) {
  for (const { hash, name } of chunks) {
    const res = await fetch(imglyBase + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(body).digest('hex') !== hash) throw new Error(`${name}: hash mismatch`);
    writeFileSync(join(imglyDir, name), body);
  }
}
console.log(`vendored: staticimgly/@imgly/background-removal-data/${imgly}/dist`);

// PDF compress and protect (Ghostscript). Not on npm; only on this CDN.
const gs = await fetch('https://cdn-wasm.b-cdn.net/gs-worker.wasm');
if (!gs.ok) throw new Error(`gs-worker.wasm: HTTP ${gs.status}`);
mkdirSync(join(VENDOR, 'bcdn'), { recursive: true });
writeFileSync(join(VENDOR, 'bcdn/gs-worker.wasm'), Buffer.from(await gs.arrayBuffer()));
console.log('vendored: bcdn/gs-worker.wasm');

// PDF form filler: pdf.js's worker, from the copy react-pdf was built with.
const pdfjs = versionIn(builtText, 'ajax/libs/pdf.js/');
const pdfjsDir = [join(NM, 'react-pdf/node_modules/pdfjs-dist'), join(NM, 'pdfjs-dist')]
  .find((dir) => statSync(dir, { throwIfNoEntry: false }) && pkgVersion(dir) === pdfjs);
if (!pdfjsDir) throw new Error(`no pdfjs-dist ${pdfjs} in node_modules`);
copy(join(pdfjsDir, 'build/pdf.worker.min.js'), `cdnjs/pdf.js/${pdfjs}/pdf.worker.min.js`);

// Google Fonts stylesheets the PDF editor adds for its UI and signatures.
// Each is saved with its font files beside it.
const fontSheets = new Map();
for (const [url] of builtText.matchAll(/https:\/\/fonts\.googleapis\.com\/css2\?[^"'`\\\s]+/g)) {
  if (fontSheets.has(url)) continue;
  const name = createHash('sha1').update(url).digest('hex').slice(0, 12);
  const res = await fetch(url, {
    // Without a current browser's user agent Google serves TTF, not WOFF2.
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  let css = await res.text();
  mkdirSync(join(VENDOR, 'gfonts/files'), { recursive: true });
  for (const [, fontUrl] of css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)) {
    const file = fontUrl.split('/').slice(3).join('_');
    const font = await fetch(fontUrl);
    if (!font.ok) throw new Error(`${fontUrl}: HTTP ${font.status}`);
    writeFileSync(join(VENDOR, 'gfonts/files', file), Buffer.from(await font.arrayBuffer()));
    css = css.replaceAll(fontUrl, `files/${file}`);
  }
  writeFileSync(join(VENDOR, `gfonts/${name}.css`), css);
  fontSheets.set(url, `/vendor/gfonts/${name}.css`);
  console.log(`vendored: gfonts/${name}.css`);
}

// ── 2. The addresses ─────────────────────────────────────────────────────────

// Outside address -> local path. The blocked ones are services this build
// turns off (see patch-source.mjs); pointing them at nothing makes sure.
const REWRITES = [
  ...fontSheets,
  ['https://cdn.jsdelivr.net/npm/', '/vendor/npm/'],
  ['https://unpkg.com/', '/vendor/npm/'],
  ['https://staticimgly.com/', '/vendor/staticimgly/'],
  ['https://cdn-wasm.b-cdn.net/', '/vendor/bcdn/'],
  ['//cdnjs.cloudflare.com/ajax/libs/pdf.js/', '/vendor/cdnjs/pdf.js/'],
  ['https://neo.wordplex.io/', '/vendor/blocked/'],
  ['https://i18n-fastly.ultrafast.io/', '/vendor/blocked/'],
  ['https://api.iconify.design', '/vendor/blocked'],
  ['https://api.simplesvg.com', '/vendor/blocked'],
  ['https://api.unisvg.com', '/vendor/blocked']
];

// A URL that starts a string literal gets the page's origin in front, written
// in that literal's own quoting: several of these run in workers started from
// blob: URLs, where a bare "/vendor/..." has nothing to resolve against.
// `self` is the window on the page and the global scope in a worker.
function rewrite(text, from, to) {
  let out = '';
  let last = 0;
  for (let i = text.indexOf(from); i >= 0; i = text.indexOf(from, i + from.length)) {
    const quote = text[i - 1];
    const escaped = text[i - 2] === '\\';
    let origin = '';
    if (quote === '`') origin = '\\${self.location.origin}'.slice(escaped ? 0 : 1);
    else if (quote === '"' || quote === "'") {
      const q = (escaped ? '\\' : '') + quote;
      origin = `${q}+self.location.origin+${q}`;
    }
    out += text.slice(last, i) + origin + to;
    last = i + from.length;
  }
  return out + text.slice(last);
}

let changed = 0;
for (const file of textFiles(DIST)) {
  const before = readFileSync(file, 'utf8');
  let text = before;
  for (const [from, to] of REWRITES) text = rewrite(text, from, to);
  if (text !== before) {
    writeFileSync(file, text);
    changed++;
  }
}
console.log(`rewrote addresses in ${changed} files`);

// ── 3. The check ─────────────────────────────────────────────────────────────

const FORBIDDEN = [
  'cdn.jsdelivr.net', 'unpkg.com', 'staticimgly.com', 'b-cdn.net', 'cdnjs.cloudflare.com/ajax/libs/pdf.js',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'api.iconify.design', 'api.simplesvg.com', 'api.unisvg.com',
  'ghbtns.com', 'wordplex.io', 'ultrafast.io'
];
const left = [];
for (const file of textFiles(DIST)) {
  const text = readFileSync(file, 'utf8');
  for (const host of FORBIDDEN) if (text.includes(host)) left.push(`${relative(DIST, file)}: ${host}`);
}
if (left.length) throw new Error(`outside addresses still in the build:\n  ${left.join('\n  ')}`);
console.log('no outside addresses left');
