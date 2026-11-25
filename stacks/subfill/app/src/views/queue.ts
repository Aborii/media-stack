// The queue, in the order the nodes will take it: what is being translated
// now, what is ready, what is sitting out a retry delay, what is still giving
// Bazarr time, and what failed.
import type { Item } from '../store.ts';
import { actions, ago, clock, esc, itemLink, page } from './layout.ts';
import { renderNodes } from './overview.ts';
import type { View } from './view.ts';

const SHOWN = 100;

function flags(i: Item, now: number): string {
  const out: string[] = [];
  if (i.held_until && i.held_until > now) out.push(`<span class="badge s-ready">kept for the PC until ${clock(i.held_until)}</span>`);
  if (i.priority) out.push('<span class="badge s-translating">translate now</span>');
  if (i.crashes) out.push(`<span class="badge s-failed">model crashed ${i.crashes}&times;</span>`);
  if (i.attempts) out.push(`<span class="badge s-waiting">attempt ${i.attempts + 1}</span>`);
  return out.join(' ');
}

function table(rows: string, head: string, empty: string): string {
  return `<div class="card flush wrap"><table class="stack"><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td colspan="9" class="dim">${empty}</td></tr>`}</tbody></table></div>`;
}

export function renderQueue(v: View): string {
  const back = '/queue';
  const ready = v.store.readyCount(v.now);
  const counts = v.store.counts();
  const next = v.store.queue(v.now, SHOWN);
  const retrying = v.store.retrying(v.now, 50);
  const waiting = v.store.waitingSoonest(50);
  const failed = v.store.inState('failed', 50);

  const nextRows = next
    .map(
      (i, n) =>
        `<tr><td class="num dim">${n + 1}</td><td>${itemLink(i)} ${flags(i, v.now)}<div class="dim">${esc(i.note ?? '')}</div></td><td class="dim" data-label="Ready">${ago(i.eligible_at, v.now)}</td><td class="num">${actions(i, back)}</td></tr>`,
    )
    .join('');
  const retryRows = retrying
    .map((i) => `<tr><td>${itemLink(i)} ${flags(i, v.now)}<div class="dim">${esc(i.note ?? '')}</div></td><td class="dim" data-label="Tries again">${ago(i.eligible_at, v.now)}</td><td class="num">${actions(i, back)}</td></tr>`)
    .join('');
  const waitRows = waiting
    .map((i) => `<tr><td>${itemLink(i)}</td><td class="dim" data-label="Ready">${ago(i.eligible_at, v.now)}</td><td class="num">${actions(i, back)}</td></tr>`)
    .join('');
  const failRows = failed
    .map((i) => `<tr><td>${itemLink(i)}<div class="dim">${esc(i.note ?? '')}</div></td><td class="dim" data-label="Failed">${ago(i.updated_at, v.now)}</td><td class="num">${actions(i, back)}</td></tr>`)
    .join('');

  const body = `<h1>Queue</h1><p class="dim">${ready} ready, ${counts.translating} translating, ${counts.waiting} giving Bazarr time first, ${counts.failed} failed. Ready items run top to bottom: one kept for the PC, then "translate now", then the ones that crashed the model least, then the newest videos.</p>
<h2>Now</h2><div class="nodes" data-live="nodes">${renderNodes(v, back)}</div>
<h2>Up next${ready > next.length ? ` <span class="dim" style="font-weight:400">the first ${next.length} of ${ready}</span>` : ''}</h2>${table(nextRows, '<th class="num">#</th><th>Title</th><th>Ready since</th><th></th>', 'Nothing is ready to translate.')}
${retryRows ? `<h2>Trying again later</h2>${table(retryRows, '<th>Title</th><th>Tries again</th><th></th>', '')}` : ''}
<h2>Giving Bazarr time${counts.waiting > waiting.length ? ` <span class="dim" style="font-weight:400">the ${waiting.length} soonest of ${counts.waiting}</span>` : ''}</h2>${table(waitRows, '<th>Title</th><th>Ready</th><th></th>', 'Nothing is waiting: every missing Arabic subtitle has had its time.')}
${failRows ? `<h2>Failed <a href="/items?state=failed">All failed</a></h2>${table(failRows, '<th>Title</th><th>Failed</th><th></th>', '')}` : ''}`;
  return page({ title: 'subfill - queue', tab: 'queue', body, queued: ready, live: true });
}
