// The overview: problems first, then the nodes and what each is doing, the
// numbers that say how the library stands, what runs next, what just finished
// and what needs a look.
import type { NodeState, NodeStatus } from '../nodes.ts';
import type { Item } from '../store.ts';
import {
  actions,
  ago,
  button,
  clock,
  coverageBar,
  esc,
  GROUPS,
  itemLink,
  legend,
  liveMark,
  page,
  pageHeader,
  span,
  stateBadge,
  sum,
} from './layout.ts';
import type { View } from './view.ts';

const NODE_LABEL: Record<NodeState, string> = {
  working: 'translating',
  idle: 'idle',
  offline: 'offline',
  paused: 'paused by you',
  outside_hours: 'outside its hours',
};

// `back` is the page the Pause and Resume buttons return to.
export function renderNodes(v: View, back = '/'): string {
  const held = v.store.heldNow(v.now);
  const week = new Map(v.store.finishedByNode(v.now - 7 * 86400_000).map((r) => [r.node, r]));
  return v.status.nodes
    .map((n: NodeStatus) => {
      const doing = n.current
        ? `<div class="doing"><b>${itemLink({ key: n.current.key, title: n.current.title })}</b><div class="meter"><i style="width:${n.current.total ? Math.round((n.current.done / n.current.total) * 100) : 0}%"></i></div><span class="dim">${n.current.done} of ${n.current.total} lines &middot; started ${ago(n.current.startedAt, v.now)}${eta(n, v.now)}</span></div>`
        : '';
      const facts = [
        n.state === 'offline' && n.problem ? esc(n.problem) : '',
        n.lastSeen ? `last answered ${ago(n.lastSeen, v.now)}` : n.state === 'offline' ? 'has never answered' : '',
        n.lease?.held ? 'keeping the PC awake while it works' : '',
        n.name !== 'mini' && held ? `${esc(held.title)} is kept for it until ${clock(held.held_until ?? 0)}` : '',
      ].filter(Boolean);
      const w = week.get(n.name);
      const pace = w ? `<div class="meta">This week: ${w.count} done, about ${span(Math.round(w.avgSeconds))} each</div>` : '';
      const problem = n.lease?.error ? `<div class="bad" style="margin:10px 0 0">${esc(n.lease.error)}</div>` : '';
      const toggle = n.paused ? button(n.name, 'resume-node', 'Resume', back, 'primary') : button(n.name, 'pause-node', 'Pause', back);
      // A paused node still finishes the item it is on.
      const label = n.paused && n.state === 'working' ? 'pauses after this item' : NODE_LABEL[n.state];
      return `<div class="card node"><div class="row" style="justify-content:space-between"><h3><span class="dot ${n.state}"></span>${esc(n.label)}</h3>${toggle}</div><div class="meta">${esc(label)}${facts.length ? ` &middot; ${facts.join(' &middot; ')}` : ''}</div>${pace}${problem}${doing}</div>`;
    })
    .join('');
}

// Time left on the item, from the pace so far.
function eta(n: NodeStatus, now: number): string {
  const c = n.current;
  if (!c || c.done < 1 || c.done >= c.total) return '';
  const left = ((now - c.startedAt) / c.done) * (c.total - c.done);
  return ` &middot; about ${span(Math.round(left / 1000))} left`;
}

export function renderKpis(v: View): string {
  const counts = v.store.counts();
  const day = v.store.finishedSince(v.now - 86400_000);
  const week = v.store.finishedSince(v.now - 7 * 86400_000);
  const cov = v.library.coverage();
  const both = Object.fromEntries(Object.keys(cov.episode).map((k) => [k, cov.episode[k as keyof typeof cov.episode] + cov.movie[k as keyof typeof cov.movie]])) as typeof cov.episode;
  const wanted = sum(both, [...GROUPS.has, ...GROUPS.queue, ...GROUPS.needs]);
  const has = sum(both, GROUPS.has);
  const pct = wanted ? `${Math.round((has / wanted) * 100)}%` : '-';
  const ready = v.store.readyCount(v.now);
  // [colour, label, value, line under it]
  const tiles: [string, string, string | number, string][] = [
    ['human', 'Coverage', pct, wanted ? `${has.toLocaleString('en')} of ${wanted.toLocaleString('en')} that want Arabic, ${both.machine.toLocaleString('en')} of them ours` : 'library not read yet'],
    ['ready', 'Ready in the queue', ready, `${counts.waiting} giving Bazarr time`],
    ['translating', 'Translated today', day.count, `${week.count} this week, ${counts.replaced} replaced by human so far`],
    [counts.failed ? 'failed' : 'no_source', 'Needs a look', counts.failed, `failed; ${counts.no_source.toLocaleString('en')} have nothing to translate from`],
  ];
  return tiles
    .map(
      ([c, label, value, sub], n) =>
        `<div class="card kpi"><span class="l"><i class="s-${c}"></i>${esc(label)}</span><b>${esc(value)}</b><span class="sub">${esc(sub)}</span>${n === 0 && wanted ? `<div class="meter"><i style="width:${Math.round((has / wanted) * 100)}%;background:var(--human)"></i></div>` : ''}</div>`,
    )
    .join('');
}

function problems(v: View): string {
  const out: string[] = [];
  if (v.status.bazarrError) out.push(`<div class="bad">${esc(v.status.bazarrError)}</div>`);
  const lib = v.library.freshness();
  if (lib.error) {
    const age = lib.at ? ` The shows and films shown are from ${ago(lib.at, v.now)}.` : '';
    out.push(`<div class="bad">Could not read the library from Bazarr: ${esc(lib.error)}.${age}</div>`);
  }
  return out.join('');
}

function upNext(v: View, items: Item[]): string {
  if (!items.length) return '<p class="dim" style="padding:14px 18px;margin:0">Nothing is ready to translate.</p>';
  return `<ol class="list">${items
    .map(
      (i, n) =>
        `<li><span class="rank">${n + 1}</span><span class="grow">${itemLink(i)}${i.held_until && i.held_until > v.now ? ' <span class="badge s-ready">kept for the PC</span>' : ''}</span></li>`,
    )
    .join('')}</ol>`;
}

function finished(v: View, items: Item[]): string {
  if (!items.length) return '<p class="dim" style="padding:14px 18px;margin:0">Nothing translated yet.</p>';
  return `<ul class="list">${items
    .map((i) => `<li><span class="grow">${itemLink(i)}<div class="dim" style="font-size:12.5px">${esc(i.note ?? '')}</div></span><span class="dim" style="white-space:nowrap;font-size:12.5px">${ago(i.finished_at, v.now)} &middot; <a href="/subtitles?key=${encodeURIComponent(i.key)}">view</a></span></li>`)
    .join('')}</ul>`;
}

export function renderOverview(v: View): string {
  const cov = v.library.coverage();
  const failed = v.store.inState('failed', 10);
  const lib = v.library.freshness();
  const covCard = (label: string, counts: typeof cov.episode, href: string, link: string) =>
    `<div class="card"><div class="card-h">${label}<a href="${href}">${link} &rarr;</a></div>${coverageBar(counts)}${legend(counts)}</div>`;
  const libraryCard = lib.at
    ? `<div class="cols">${covCard('Episodes', cov.episode, '/shows', 'By show')}${covCard('Films', cov.movie, '/movies', 'All films')}</div>`
    : `<div class="note">The library has not been read from Bazarr yet. It is read at start and every sync.</div>`;
  const right = `${liveMark()}<span>&middot;</span><span>Synced ${ago(v.status.lastSync, v.now)}</span>${lib.at ? `<span>&middot;</span><span>Library ${ago(lib.at, v.now)}</span>` : ''}`;
  const body = `${pageHeader('Overview', `Arabic subtitles from ${esc(v.status.model)} wherever Bazarr finds none.`, right)}${problems(v)}
<div class="kpis" data-live="kpis">${renderKpis(v)}</div>
<h2>Nodes</h2><div class="nodes" data-live="nodes">${renderNodes(v)}</div>
<h2>Library</h2>${libraryCard}
<div class="cols">
<div><h2>Up next <a href="/queue">Whole queue &rarr;</a></h2><div class="card flush">${upNext(v, v.store.queue(v.now, 8))}</div></div>
<div><h2>Recently finished <a href="/items?state=done">All machine subtitles &rarr;</a></h2><div class="card flush">${finished(v, v.store.recentlyFinished(8))}</div></div>
</div>
${failed.length ? `<h2>Needs a look <a href="/items?state=failed">All failed &rarr;</a></h2><div class="card flush wrap"><table class="stack"><thead><tr><th>Title</th><th>State</th><th class="num">Changed</th><th></th></tr></thead><tbody>${failed.map((i) => `<tr><td>${itemLink(i)}<div class="dim">${esc(i.note ?? '')}</div></td><td>${stateBadge(i.state)}</td><td class="num dim">${ago(i.updated_at, v.now)}</td><td class="num">${actions(i, '/')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  return page({ title: 'subfill', tab: 'overview', body, v, live: true });
}
