// One translation's two subtitles side by side, every line: the original
// and subfill's Arabic, with the time each appears, a filter, and both files
// to download.
import type { Pair } from '../subtitles.ts';
import type { Item } from '../store.ts';
import { ago, esc, itemLink, page, pageHeader, stateBadge } from './layout.ts';
import type { View } from './view.ts';

// Lines as the page shows them: tags and positions off, one line each.
function lines(text: string[] | null): string {
  if (!text) return '<span class="dim">-</span>';
  return text
    .map((l) => esc(l.replace(/<\/?(?:i|b|u|font\b[^>]*)>|\{\\[^}]*\}/gi, '').replace(/‏/g, '')))
    .join('<br>');
}

// "00:01:02,500 --> 00:01:04,000" as "1:02".
function start(timing: string): string {
  const m = timing.match(/^(\d+):(\d+):(\d+)/);
  if (!m) return esc(timing);
  const [h, mm, ss] = [Number(m[1]), m[2], m[3]];
  return h ? `${h}:${mm}:${ss}` : `${Number(mm)}:${ss}`;
}

const FILTER = `<script>
(() => {
  const box = document.getElementById('find');
  const rows = [...document.querySelectorAll('#subs tbody tr')];
  const count = document.getElementById('shown');
  box.addEventListener('input', () => {
    const q = box.value.trim().toLowerCase();
    let n = 0;
    for (const r of rows) { const hit = !q || r.textContent.toLowerCase().includes(q); r.hidden = !hit; if (hit) n++; }
    count.textContent = q ? n + ' of ' + rows.length + ' lines' : rows.length + ' lines';
  });
})();
</script>`;

export function renderSubtitles(v: View, item: Item, pair: Pair): string {
  const key = encodeURIComponent(item.key);
  const both = pair.rows.filter((r) => r.source && r.target).length;
  const oneSided = pair.rows.length - both;
  const downloads = [
    pair.targetProblem ? '' : `<a class="btn primary" href="/subtitles/file?key=${key}&amp;which=arabic">Download Arabic</a>`,
    pair.sourceProblem ? '' : `<a class="btn" href="/subtitles/file?key=${key}&amp;which=original">Download original</a>`,
  ].join('');
  const facts = [
    pair.sourceFrom ? `Translated from ${esc(pair.sourceFrom)}` : '',
    item.finished_at ? `written ${ago(item.finished_at, v.now)}${item.node ? ` on the ${esc(item.node)}` : ''}` : '',
    item.note ? esc(item.note) : '',
  ].filter(Boolean);
  const problems = [
    pair.sourceProblem ? `<div class="note">Could not read the original: ${esc(pair.sourceProblem)}.</div>` : '',
    pair.targetProblem ? `<div class="note">Could not read the Arabic: ${esc(pair.targetProblem)}.</div>` : '',
    oneSided && !pair.sourceProblem && !pair.targetProblem
      ? `<div class="note">${oneSided} lines have no partner on the other side, most likely because the original has changed since it was translated.</div>`
      : '',
  ].join('');
  const rows = pair.rows
    .map(
      (r) =>
        `<tr${r.source && r.target ? '' : ' class="lone"'}><td class="num dim">${r.n}</td><td class="dim" style="white-space:nowrap" title="${esc(r.timing)}">${start(r.timing)}</td><td>${lines(r.source)}</td><td dir="rtl" lang="ar" class="ar">${lines(r.target)}</td></tr>`,
    )
    .join('');
  const body = `<p class="crumb"><a href="/items?state=done">Machine subtitles</a> / ${itemLink(item)}</p>
${pageHeader(`Subtitles: ${esc(item.title)}`, facts.join(' &middot; '), downloads)}
<div class="row" style="margin:-8px 0 16px">${stateBadge(item.state)}</div>
${problems}
${
  pair.rows.length
    ? `<div class="toolbar"><input type="search" id="find" placeholder="Find a word in either language"><span class="dim" id="shown">${pair.rows.length} lines</span></div>
<div class="card flush wrap"><table id="subs" class="subs"><thead><tr><th class="num">#</th><th>Time</th><th>Original</th><th style="text-align:right">Arabic</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="dim">Nothing to show.</p>'
}`;
  return page({ title: `subfill - subtitles - ${item.title}`, tab: 'items', body: body + FILTER, v });
}
