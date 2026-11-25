// Shows: every series in the library with how its episodes stand for Arabic,
// and a page per show with each episode's subtitles.
import { seriesKey } from '../bazarr.ts';
import type { Entry, Show } from '../library.ts';
import {
  actions,
  ago,
  badge,
  coverageBar,
  epCode,
  esc,
  excludeButton,
  GROUPS,
  legend,
  page,
  pageHeader,
  subtitleChips,
  sum,
} from './layout.ts';
import type { View } from './view.ts';

// Shows marked not to translate appear only under their own filter.
const FILTERS = {
  '': ['All', (s: Show) => !s.excluded],
  needs: ['Missing Arabic', (s: Show) => !s.excluded && sum(s.counts, GROUPS.needs) > 0],
  queue: ['In the queue', (s: Show) => !s.excluded && sum(s.counts, GROUPS.queue) > 0],
  machine: ['Has machine Arabic', (s: Show) => !s.excluded && s.counts.machine > 0],
  complete: ['Complete', (s: Show) => !s.excluded && s.episodes > 0 && sum(s.counts, [...GROUPS.needs, ...GROUPS.queue]) === 0],
  excluded: ['Not translated', (s: Show) => s.excluded],
} as const satisfies Record<string, readonly [string, (s: Show) => boolean]>;
type Filter = keyof typeof FILTERS;

// Episodes that want Arabic: not those Bazarr's profile skips, nor those set
// aside by the owner's mark.
function wantedOf(s: Show): number {
  return s.episodes - s.counts.not_wanted - s.counts.excluded;
}

function libraryNote(v: View): string {
  const lib = v.library.freshness();
  if (!lib.at) {
    return lib.error
      ? `<div class="bad">Could not read the library from Bazarr: ${esc(lib.error)}</div>`
      : '<div class="note">The library has not been read from Bazarr yet. It is read at start and every sync; try again in a minute.</div>';
  }
  return lib.error
    ? `<div class="bad">The last read of the library failed (${esc(lib.error)}). This is the copy from ${ago(lib.at, v.now)}.</div>`
    : '';
}

export function renderShows(v: View, query: URLSearchParams): string {
  const all = v.library.shows();
  const f = query.get('f') ?? '';
  const filter: Filter = Object.hasOwn(FILTERS, f) ? (f as Filter) : '';
  const folders = [...new Set(all.map((s) => s.folder))].sort();
  const folder = folders.find((f) => f === query.get('folder')) ?? '';
  const q = (query.get('q') ?? '').slice(0, 100);
  const sort = query.get('sort') === 'missing' ? 'missing' : 'name';
  const link = (over: Record<string, string>) => {
    const p = new URLSearchParams({ ...(q ? { q } : {}), ...(filter ? { f: filter } : {}), ...(folder ? { folder } : {}), ...(sort !== 'name' ? { sort } : {}), ...over });
    for (const [k, val] of [...p]) if (!val) p.delete(k);
    return `/shows${p.size ? `?${p}` : ''}`;
  };
  let shows = all.filter((s) => (!folder || s.folder === folder) && (!q || s.title.toLowerCase().includes(q.toLowerCase())));
  const chips = (Object.keys(FILTERS) as Filter[])
    .map((f) => `<a class="${f === filter ? 'on' : ''}" href="${esc(link({ f }))}">${FILTERS[f][0]}<span class="c">${shows.filter(FILTERS[f][1]).length}</span></a>`)
    .join('');
  shows = shows.filter(FILTERS[filter][1]);
  if (sort === 'missing') shows.sort((a, b) => sum(b.counts, GROUPS.needs) - sum(a.counts, GROUPS.needs) || a.title.localeCompare(b.title));

  const rows = shows
    .map((s) => {
      const has = sum(s.counts, GROUPS.has);
      const wanted = wantedOf(s);
      const needs = sum(s.counts, GROUPS.needs);
      const queued = sum(s.counts, GROUPS.queue);
      return `<tr><td><a href="/show?id=${s.id}">${esc(s.title)}</a>${s.year ? ` <span class="dim">${esc(s.year)}</span>` : ''}<span class="tag">${esc(s.folder)}</span></td>
<td style="min-width:200px">${coverageBar(s.counts)}<span class="cov-sub">${s.excluded ? 'not translated, by you' : wanted ? `${has} of ${wanted} have Arabic` : 'Arabic not wanted'}</span></td>
<td class="num" data-label="Episodes">${s.episodes}</td><td class="num" data-label="Human">${s.counts.human}</td><td class="num" data-label="Machine">${s.counts.machine}</td>
<td class="num" data-label="Queued">${queued || '<span class="dim">0</span>'}</td><td class="num" data-label="Missing">${needs ? `<span style="color:var(--missing);font-weight:600">${needs}</span>` : '<span class="dim">0</span>'}</td></tr>`;
    })
    .join('');

  const folderChips = folders.length > 1 ? `<div class="seg">${['', ...folders].map((f) => `<a class="${f === folder ? 'on' : ''}" href="${esc(link({ folder: f }))}">${f ? esc(f) : 'All folders'}</a>`).join('')}</div>` : '';
  const body = `${pageHeader('Shows', `${all.filter((s) => !s.excluded).length} shows. Each bar splits a show's episodes by their Arabic subtitle. Shows you marked not to translate are under "Not translated".`)}
${libraryNote(v)}
<div class="toolbar"><form class="row" method="get" action="/shows">${filter ? `<input type="hidden" name="f" value="${esc(filter)}">` : ''}${folder ? `<input type="hidden" name="folder" value="${esc(folder)}">` : ''}<input type="search" name="q" value="${esc(q)}" placeholder="Search shows"><select name="sort" onchange="this.form.submit()"><option value="name"${sort === 'name' ? ' selected' : ''}>Sort by name</option><option value="missing"${sort === 'missing' ? ' selected' : ''}>Most missing first</option></select></form>${folderChips}</div>
<div class="toolbar"><div class="seg">${chips}</div></div>
<div class="card flush wrap"><table class="stack"><thead><tr><th>Show</th><th>Arabic</th><th class="num">Episodes</th><th class="num">Human</th><th class="num">Machine</th><th class="num">Queued</th><th class="num">Missing</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="dim">${all.length ? 'No show matches.' : 'No shows yet.'}</td></tr>`}</tbody></table></div>`;
  return page({ title: 'subfill - shows', tab: 'shows', body, v });
}

// `more` goes after the item's own buttons.
export function entryRow(e: Entry, back: string, now: number, first: string, more = ''): string {
  const note = e.item?.note && e.status !== 'human' && e.status !== 'excluded' ? `<div class="dim">${esc(e.item.note)}</div>` : '';
  const when =
    e.item && e.status === 'waiting' ? `<div class="dim">ready ${ago(e.item.eligible_at, now)}</div>` : e.item && e.status === 'machine' ? `<div class="dim">written ${ago(e.item.finished_at, now)}</div>` : '';
  const status = e.item ? `<a href="/item?key=${encodeURIComponent(e.key)}">${badge(e.status)}</a>` : badge(e.status);
  return `<tr>${first}<td data-label="Subtitles">${subtitleChips(e.subtitles, e.status === 'machine')}</td><td class="inl">${status}${when}${note}</td><td class="num inl"><span class="acts">${e.item && !e.marked ? actions(e.item, back) : ''}${more}</span></td></tr>`;
}

export function renderShow(v: View, id: number): string | null {
  const found = v.library.show(id);
  if (!found) return null;
  const { show, episodes } = found;
  const back = `/show?id=${id}`;
  const seasons = new Map<number, Entry[]>();
  for (const e of episodes) seasons.set(e.season ?? 0, [...(seasons.get(e.season ?? 0) ?? []), e]);
  const sections = [...seasons]
    .map(([season, eps]) => {
      const has = eps.filter((e) => (GROUPS.has as readonly string[]).includes(e.status)).length;
      const wanted = eps.filter((e) => e.status !== 'not_wanted' && e.status !== 'excluded').length;
      const rows = eps
        .map((e) => entryRow(e, back, v.now, `<td class="dim inl" style="white-space:nowrap">${epCode(e.season, e.episode)}</td><td class="inl">${esc(e.title || '-')}</td>`))
        .join('');
      return `<h2>${season === 0 ? 'Specials' : `Season ${season}`} <span class="dim">${wanted ? `${has} of ${wanted} have Arabic` : `${eps.length} episodes`}</span></h2>
<div class="card flush wrap"><table class="stack"><thead><tr><th style="width:90px">Episode</th><th>Title</th><th>Subtitles</th><th>Arabic</th><th class="num">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join('');
  const has = sum(show.counts, GROUPS.has);
  const wanted = wantedOf(show);
  const tile = (label: string, value: string | number, c: string, sub = '') =>
    `<div class="card kpi"><span class="l"><i class="s-${c}"></i>${label}</span><b>${value}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
  const body = `<p class="crumb"><a href="/shows">Shows</a> / ${esc(show.title)}</p>
${pageHeader(`${esc(show.title)}${show.year ? ` <span class="dim">${esc(show.year)}</span>` : ''}`, '', `<span class="tag">${esc(show.folder)}</span><span class="tag">${show.ended ? 'ended' : 'continuing'}</span>${excludeButton(seriesKey(show.id), show.excluded, back, 'show')}`)}
${show.excluded ? '<div class="note">You marked this show not to translate. Its episodes are set aside, new ones too, and it is listed only under "Not translated" on the shows page. Machine subtitles written before stay.</div>' : ''}
${libraryNote(v)}
<div class="kpis">${tile('Coverage', wanted ? `${Math.round((has / wanted) * 100)}%` : '-', 'human', `${has} of ${wanted} that want Arabic`)}${tile('Episodes', show.episodes, 'not_wanted')}${tile('Machine Arabic', show.counts.machine, 'machine')}${tile('In the queue', sum(show.counts, GROUPS.queue), 'ready')}${tile('Missing', sum(show.counts, GROUPS.needs), 'missing')}</div>
<div class="card" style="margin-top:16px">${coverageBar(show.counts)}${legend(show.counts)}</div>
${sections || '<p class="dim">Bazarr lists no episode files for this show.</p>'}`;
  return page({ title: `subfill - ${show.title}`, tab: 'shows', body, v });
}
