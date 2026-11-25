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
  page,
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
      const pace = w ? `<div class="dim">This week: ${w.count} done, about ${span(Math.round(w.avgSeconds))} each</div>` : '';
      const problem = n.lease?.error ? `<div class="bad" style="margin:8px 0 0">${esc(n.lease.error)}</div>` : '';
      const toggle = n.paused ? button(n.name, 'resume-node', 'Resume', back, 'primary') : button(n.name, 'pause-node', 'Pause', back);
      // A paused node still finishes the item it is on.
      const label = n.paused && n.state === 'working' ? 'pauses after this item' : NODE_LABEL[n.state];
      return `<div class="card node"><div class="row" style="justify-content:space-between"><h3><span class="dot ${n.state}"></span>${esc(n.label)}</h3>${toggle}</div><div class="dim">${esc(label)}${facts.length ? ` &middot; ${facts.join(' &middot; ')}` : ''}</div>${pace}${problem}${doing}</div>`;
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
  const tiles: [string, string | number, string, string][] = [
    ['good', pct, 'have Arabic', wanted ? `${has} of ${wanted} that want it` : 'library not read yet'],
    ['', both.human, 'human Arabic', 'found by Bazarr'],
    ['', both.machine, 'machine Arabic', `${counts.replaced} replaced by human since`],
    ['', ready, 'ready in the queue', `${counts.waiting} waiting for Bazarr`],
    ['', day.count, 'translated today', `${week.count} this week`],
    [counts.failed ? 'bad' : '', counts.failed, 'failed', counts.failed ? 'see below' : 'none'],
    [counts.no_source ? 'warn' : '', counts.no_source, 'nothing to translate from', 'no English beside the video'],
  ];
  return tiles
    .map(
      ([kind, value, label, sub]) =>
        `<div class="card kpi${kind ? ` ${kind}` : ''}"><b>${esc(value)}</b><span>${esc(label)}</span><span class="sub">${esc(sub)}</span></div>`,
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
  if (!items.length) return '<p class="dim">Nothing is ready to translate.</p>';
  return `<ol class="list">${items
    .map(
      (i, n) =>
        `<li><span class="rank">${n + 1}</span><span class="grow">${itemLink(i)}${i.held_until && i.held_until > v.now ? ' <span class="badge s-ready">kept for the PC</span>' : ''}${i.priority ? ' <span class="badge s-translating">translate now</span>' : ''}</span></li>`,
    )
    .join('')}</ol>`;
}

function finished(v: View, items: Item[]): string {
  if (!items.length) return '<p class="dim">Nothing translated yet.</p>';
  return `<ul class="list">${items
    .map((i) => `<li><span class="grow">${itemLink(i)}<div class="dim">${esc(i.note ?? '')}</div></span><span class="dim" style="white-space:nowrap">${ago(i.finished_at, v.now)}</span></li>`)
    .join('')}</ul>`;
}

export function renderOverview(v: View): string {
  const cov = v.library.coverage();
  const failed = v.store.inState('failed', 10);
  const lib = v.library.freshness();
  const libraryCard = lib.at
    ? `<div class="cols"><div class="card"><div class="row"><b class="grow">Episodes</b><a href="/shows">By show</a></div><div style="margin-top:8px">${coverageBar(cov.episode)}</div>${legend(cov.episode)}</div><div class="card"><div class="row"><b class="grow">Films</b><a href="/movies">All films</a></div><div style="margin-top:8px">${coverageBar(cov.movie)}</div>${legend(cov.movie)}</div></div><p class="dim">Library read from Bazarr ${ago(lib.at, v.now)}; subfill last checked what is missing ${ago(v.status.lastSync, v.now)}.</p>`
    : `<div class="note">The library has not been read from Bazarr yet. It is read at start and every sync.</div>`;
  const body = `${problems(v)}
<h2>Nodes</h2><div class="nodes" data-live="nodes">${renderNodes(v)}</div>
<div class="kpis" data-live="kpis">${renderKpis(v)}</div>
<h2>Library</h2>${libraryCard}
<div class="cols" style="margin-top:6px">
<div><h2>Up next <a href="/queue">Whole queue</a></h2><div class="card">${upNext(v, v.store.queue(v.now, 8))}</div></div>
<div><h2>Recently finished <a href="/items?state=done">All machine subtitles</a></h2><div class="card">${finished(v, v.store.recentlyFinished(8))}</div></div>
</div>
${failed.length ? `<h2>Needs a look <a href="/items?state=failed">All failed</a></h2><div class="card flush wrap"><table class="stack">${failed.map((i) => `<tr><td>${itemLink(i)}<div class="dim">${esc(i.note ?? '')}</div></td><td>${stateBadge(i.state)}</td><td class="num dim">${ago(i.updated_at, v.now)}</td><td class="num">${actions(i, '/')}</td></tr>`).join('')}</table></div>` : ''}`;
  return page({ title: 'subfill', tab: 'overview', body, queued: v.store.readyCount(v.now), live: true });
}
