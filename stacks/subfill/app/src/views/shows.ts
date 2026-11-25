// Shows: every series in the library with how its episodes stand for Arabic,
// and a page per show with each episode's subtitles.
import type { Entry, Show } from '../library.ts';
import {
  actions,
  ago,
  badge,
  coverageBar,
  epCode,
  esc,
  GROUPS,
  legend,
  page,
  subtitleChips,
  sum,
} from './layout.ts';
import type { View } from './view.ts';

const FILTERS = {
  '': ['All', () => true],
  needs: ['Missing Arabic', (s: Show) => sum(s.counts, GROUPS.needs) > 0],
  queue: ['In the queue', (s: Show) => sum(s.counts, GROUPS.queue) > 0],
  machine: ['Has machine Arabic', (s: Show) => s.counts.machine > 0],
  complete: ['Complete', (s: Show) => s.episodes > 0 && sum(s.counts, [...GROUPS.needs, ...GROUPS.queue]) === 0],
} as const satisfies Record<string, readonly [string, (s: Show) => boolean]>;
type Filter = keyof typeof FILTERS;

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
    .map((f) => `<a class="${f === filter ? 'on' : ''}" href="${esc(link({ f }))}">${FILTERS[f][0]} ${shows.filter(FILTERS[f][1]).length}</a>`)
    .join('');
  shows = shows.filter(FILTERS[filter][1]);
  if (sort === 'missing') shows.sort((a, b) => sum(b.counts, GROUPS.needs) - sum(a.counts, GROUPS.needs) || a.title.localeCompare(b.title));

  const rows = shows
    .map((s) => {
      const has = sum(s.counts, GROUPS.has);
      const wanted = s.episodes - s.counts.not_wanted;
      const needs = sum(s.counts, GROUPS.needs);
      const queued = sum(s.counts, GROUPS.queue);
      return `<tr><td><a class="show-title" href="/show?id=${s.id}">${esc(s.title)}</a>${s.year ? ` <span class="dim">${esc(s.year)}</span>` : ''}<span class="tag">${esc(s.folder)}</span></td>
<td style="min-width:180px">${coverageBar(s.counts)}<small class="dim">${wanted ? `${has} of ${wanted} have Arabic` : 'Arabic not wanted'}</small></td>
<td class="num" data-label="Episodes">${s.episodes}</td><td class="num" data-label="Human">${s.counts.human}</td><td class="num" data-label="Machine">${s.counts.machine}</td>
<td class="num" data-label="Queued">${queued || '<span class="dim">0</span>'}</td><td class="num" data-label="Missing">${needs ? `<b style="color:var(--missing)">${needs}</b>` : '<span class="dim">0</span>'}</td></tr>`;
    })
    .join('');

  const folderChips = folders.length > 1 ? `<div class="chips">${['', ...folders].map((f) => `<a class="${f === folder ? 'on' : ''}" href="${esc(link({ folder: f }))}">${f ? esc(f) : 'every folder'}</a>`).join('')}</div>` : '';
  const body = `<h1>Shows</h1><p class="dim">${all.length} shows. Each bar is one show's episodes by Arabic subtitle: green has a human one, violet ours, blue and grey are in the queue, orange and red have none.</p>
${libraryNote(v)}
<form class="row" method="get" action="/shows">${filter ? `<input type="hidden" name="f" value="${esc(filter)}">` : ''}${folder ? `<input type="hidden" name="folder" value="${esc(folder)}">` : ''}<input type="search" name="q" value="${esc(q)}" placeholder="Search shows"><select name="sort" onchange="this.form.submit()"><option value="name"${sort === 'name' ? ' selected' : ''}>By name</option><option value="missing"${sort === 'missing' ? ' selected' : ''}>Most missing first</option></select><button>Search</button></form>
<div class="chips">${chips}</div>${folderChips}
<div class="card flush wrap"><table class="stack"><thead><tr><th>Show</th><th>Arabic</th><th class="num">Episodes</th><th class="num">Human</th><th class="num">Machine</th><th class="num">Queued</th><th class="num">Missing</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="dim">${all.length ? 'No show matches.' : 'No shows yet.'}</td></tr>`}</tbody></table></div>`;
  return page({ title: 'subfill - shows', tab: 'shows', body, queued: v.store.readyCount(v.now) });
}

export function entryRow(e: Entry, back: string, now: number, first: string): string {
  const note = e.item?.note && e.status !== 'human' ? `<div class="dim">${esc(e.item.note)}</div>` : '';
  const when =
    e.item && e.status === 'waiting' ? `<div class="dim">ready ${ago(e.item.eligible_at, now)}</div>` : e.item && e.status === 'machine' ? `<div class="dim">written ${ago(e.item.finished_at, now)}</div>` : '';
  const status = e.item ? `<a href="/item?key=${encodeURIComponent(e.key)}">${badge(e.status)}</a>` : badge(e.status);
  return `<tr>${first}<td data-label="Subtitles">${subtitleChips(e.subtitles, e.status === 'machine')}</td><td class="inl">${status}${when}${note}</td><td class="num inl">${e.item ? actions(e.item, back) : ''}</td></tr>`;
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
      const wanted = eps.filter((e) => e.status !== 'not_wanted').length;
      const rows = eps
        .map((e) => entryRow(e, back, v.now, `<td class="dim inl" style="white-space:nowrap">${epCode(e.season, e.episode)}</td><td class="inl">${esc(e.title || '-')}</td>`))
        .join('');
      return `<h2>${season === 0 ? 'Specials' : `Season ${season}`} <span class="dim" style="font-weight:400;font-size:13px">${wanted ? `${has} of ${wanted} have Arabic` : `${eps.length} episodes`}</span></h2>
<div class="card flush wrap"><table class="stack"><thead><tr><th>Episode</th><th>Title</th><th>Subtitles</th><th>Arabic</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join('');
  const body = `<p><a href="/shows">&larr; All shows</a></p><div class="row"><h1 class="grow">${esc(show.title)} ${show.year ? `<span class="dim" style="font-weight:400">${esc(show.year)}</span>` : ''}</h1><span class="tag">${esc(show.folder)}</span><span class="tag">${show.ended ? 'ended' : 'continuing'}</span></div>
${libraryNote(v)}
<div class="card"><div class="row"><b class="grow">${show.episodes} episodes</b><span class="dim">${sum(show.counts, GROUPS.has)} have Arabic, ${sum(show.counts, GROUPS.queue)} in the queue, ${sum(show.counts, GROUPS.needs)} missing</span></div><div style="margin-top:8px">${coverageBar(show.counts)}</div>${legend(show.counts)}</div>
${sections || '<p class="dim">Bazarr lists no episode files for this show.</p>'}`;
  return page({ title: `subfill - ${show.title}`, tab: 'shows', body, queued: v.store.readyCount(v.now) });
}
