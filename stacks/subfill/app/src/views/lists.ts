// The flat lists: films, every item subfill tracks, one item with its log,
// and the activity across all of them.
import { STATES, type State } from '../store.ts';
import {
  actions,
  ago,
  badge,
  dateTime,
  epCode,
  esc,
  excludeButton,
  GROUPS,
  itemLink,
  page,
  pageHeader,
  STATE_LABEL,
  stateBadge,
  subtitleChips,
} from './layout.ts';
import { entryRow } from './shows.ts';
import type { View } from './view.ts';

const SHOWN = 300;

// Films marked not to translate appear only under their own filter.
const MOVIE_FILTERS = {
  '': ['All', null],
  needs: ['Missing Arabic', GROUPS.needs],
  queue: ['In the queue', GROUPS.queue],
  machine: ['Machine Arabic', ['machine']],
  human: ['Human Arabic', ['human']],
  excluded: ['Not translated', null],
} as const;
type MovieFilter = keyof typeof MOVIE_FILTERS;

export function renderMovies(v: View, query: URLSearchParams): string {
  const f = query.get('f') ?? '';
  const filter: MovieFilter = Object.hasOwn(MOVIE_FILTERS, f) ? (f as MovieFilter) : '';
  const q = (query.get('q') ?? '').slice(0, 100);
  const filterOf = (f: MovieFilter) => {
    const s = MOVIE_FILTERS[f][1];
    return { statuses: s ? [...s] : undefined, marked: f === 'excluded' };
  };
  const { movies, total } = v.library.movies({ ...filterOf(filter), q, limit: SHOWN });
  const count = (f: MovieFilter) => v.library.movies({ ...filterOf(f), limit: 0 }).total;
  const chips = (Object.keys(MOVIE_FILTERS) as MovieFilter[])
    .map((f) => {
      const p = new URLSearchParams({ ...(q ? { q } : {}), ...(f ? { f } : {}) });
      return `<a class="${f === filter ? 'on' : ''}" href="/movies${p.size ? `?${p}` : ''}">${MOVIE_FILTERS[f][0]}<span class="c">${count(f).toLocaleString('en')}</span></a>`;
    })
    .join('');
  const back = `/movies?${query.toString()}`;
  const rows = movies
    .map((m) => entryRow(m, back, v.now, `<td>${m.item ? itemLink({ key: m.key, title: m.title }) : esc(m.title)}</td>`, excludeButton(m.key, m.marked, back, 'film')))
    .join('');
  const lib = v.library.freshness();
  const body = `${pageHeader('Films', `${count('').toLocaleString('en')} films, by title. Films you marked not to translate are under "Not translated".`)}
${lib.error ? `<div class="bad">The last read of the library failed (${esc(lib.error)}).${lib.at ? ` This is the copy from ${ago(lib.at, v.now)}.` : ''}</div>` : !lib.at ? '<div class="note">The library has not been read from Bazarr yet.</div>' : ''}
<div class="toolbar"><form class="row" method="get" action="/movies">${filter ? `<input type="hidden" name="f" value="${esc(filter)}">` : ''}<input type="search" name="q" value="${esc(q)}" placeholder="Search films"></form><div class="seg">${chips}</div></div>
<div class="card flush wrap"><table class="stack"><thead><tr><th>Film</th><th>Subtitles</th><th>Arabic</th><th class="num">Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="dim">No film matches.</td></tr>'}</tbody></table></div>
${total > movies.length ? `<p class="dim">Showing ${movies.length} of ${total}, by title. Search or filter to find the rest.</p>` : ''}`;
  return page({ title: 'subfill - films', tab: 'movies', body, v });
}

export function renderItems(v: View, query: URLSearchParams): string {
  const counts = v.store.counts();
  const state = STATES.find((x) => x === query.get('state'));
  const q = (query.get('q') ?? '').slice(0, 100);
  const { items, total } = v.store.list({ state, q, limit: 200 });
  const back = `/items?${query.toString()}`;
  const chip = (value: State | '', label: string, n: number) => {
    const p = new URLSearchParams(q ? { q } : {});
    if (value) p.set('state', value);
    return `<a class="${(state ?? '') === value ? 'on' : ''}" href="/items${p.size ? `?${p}` : ''}">${esc(label)}<span class="c">${n.toLocaleString('en')}</span></a>`;
  };
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const chips = [chip('', 'All', all), ...STATES.filter((x) => counts[x] || x === state).map((x) => chip(x, STATE_LABEL[x], counts[x]))].join('');
  const rows = items
    .map(
      (i) =>
        `<tr><td>${itemLink(i)}<div class="dim">${esc(i.note ?? '')}</div></td><td>${stateBadge(i.state)}${i.node && i.state !== 'waiting' ? `<div class="dim">${esc(i.node)}</div>` : ''}</td><td class="dim" data-label="Changed">${ago(i.updated_at, v.now)}</td><td class="num">${actions(i, back)}</td></tr>`,
    )
    .join('');
  const body = `${pageHeader('All items', 'Every episode and film subfill tracks: the ones Bazarr has no Arabic for, and what became of them.')}
<div class="toolbar"><form class="row" method="get" action="/items">${state ? `<input type="hidden" name="state" value="${esc(state)}">` : ''}<input type="search" name="q" value="${esc(q)}" placeholder="Search titles"></form></div>
<div class="toolbar"><div class="seg">${chips}</div></div>
<div class="card flush wrap"><table class="stack"><thead><tr><th>Title</th><th>State</th><th>Changed</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="dim">Nothing here.</td></tr>'}</tbody></table></div>
${total > items.length ? `<p class="dim">Showing the ${items.length} most recently changed of ${total}. Search or filter to find the rest.</p>` : ''}`;
  return page({ title: 'subfill - items', tab: 'items', body, v });
}

export function renderItem(v: View, key: string): string | null {
  const item = v.store.get(key);
  if (!item) return null;
  const entry = v.library.entry(key);
  const show = entry?.showId ? v.library.show(entry.showId)?.show : undefined;
  const log = v.store
    .logFor(key)
    .map((l) => `<tr><td class="dim" style="white-space:nowrap">${esc(dateTime(l.at))}</td><td><pre>${esc(l.message)}</pre></td></tr>`)
    .join('');
  const facts: [string, string | null][] = [
    ['Note', item.note],
    ['Node', item.node],
    ['Video', item.video_path],
    ['Translated from', item.source_path],
    ['Machine subtitle', item.out_path],
    [item.eligible_at > v.now ? 'Ready' : 'Ready since', ago(item.eligible_at, v.now)],
    ['Attempts', String(item.attempts)],
    ['Model crashes', item.crashes ? String(item.crashes) : null],
    ['First seen', dateTime(item.first_seen)],
  ];
  const back = `/item?key=${encodeURIComponent(key)}`;
  const crumb = show
    ? `<a href="/shows">Shows</a> / <a href="/show?id=${show.id}">${esc(show.title)}</a>${entry ? ` / ${epCode(entry.season, entry.episode)}` : ''}`
    : entry?.kind === 'movie'
      ? '<a href="/movies">Films</a>'
      : '<a href="/items">All items</a>';
  const human = entry?.status === 'human' && item.state !== 'replaced' ? ` ${badge('human')} <span class="dim">Bazarr found one; the next sync tidies up</span>` : '';
  const body = `<p class="crumb">${crumb}</p>
${pageHeader(esc(item.title), '', `${actions(item, back)}${entry?.kind === 'movie' ? excludeButton(entry.key, entry.marked, back, 'film') : ''}`)}
<div class="row" style="margin:-10px 0 18px">${stateBadge(item.state)}${human}</div>
${entry ? `<div class="card" style="margin-bottom:16px"><div class="card-h">Subtitles beside the video</div>${subtitleChips(entry.subtitles, entry.status === 'machine')}</div>` : ''}
<div class="card flush wrap"><table class="facts">${facts
    .filter(([, val]) => val !== null && val !== '')
    .map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`)
    .join('')}</table></div>
<h2>Log</h2><div class="card flush wrap"><table>${log || '<tr><td class="dim">No entries.</td></tr>'}</table></div>`;
  return page({ title: `subfill - ${item.title}`, tab: entry?.kind === 'movie' ? 'movies' : show ? 'shows' : 'items', body, v });
}

export function renderActivity(v: View): string {
  const lines = v.store.recentLog(200);
  let day = '';
  const rows = lines
    .map((l) => {
      const d = new Date(l.at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      const head = d !== day ? `<tr><th colspan="3">${esc(d)}</th></tr>` : '';
      day = d;
      const what = l.title ? itemLink({ key: l.key, title: l.title }) : `<span class="dim">${esc(l.key)} (no longer tracked)</span>`;
      return `${head}<tr><td class="dim num" style="width:70px">${esc(new Date(l.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</td><td>${what}</td><td><pre>${esc(l.message)}</pre></td></tr>`;
    })
    .join('');
  const body = `${pageHeader('Activity', `The latest ${lines.length} things subfill did or was told, newest first.`)}
<div class="card flush wrap"><table>${rows || '<tr><td class="dim">Nothing yet.</td></tr>'}</table></div>`;
  return page({ title: 'subfill - activity', tab: 'activity', body, v });
}
