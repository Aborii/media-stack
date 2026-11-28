// The machines that translate, Tdarr-style: the mini, always on and slow, and
// the PC, fast whenever it is awake. Each runs its own loop over the one
// queue; the store's guarded claim keeps two of them off the same item.
//
// A loop step, in order:
//   paused by the owner   -> nothing, and the PC's lease goes back
//   outside its hours     -> nothing (the mini only: the hours protect it)
//   its Ollama not there  -> offline: asleep, paused on the PC, or no model
//   no work it may take   -> idle, and the lease goes back
//   otherwise             -> translate one item; the PC takes its lease first
//                            only if the owner woke it for subtitles
// A node that drops in the middle of an item hands it back without using an
// attempt (Worker.translateNext), and the next node to look takes it. When
// that keeps happening (Bazarr down, a GPU too busy to answer in time) the
// lease goes back and the node waits longer each time, up to MAX_BACKOFF_MS.
//
// Why the lease only after a wake. pc-power hibernates the PC when the last
// thing to happen was an app finishing, not the owner's own input, and a lease
// ending counts as an app finishing. A PC the owner turned on and is watching a
// film on would then sleep the moment subfill let go. So when the PC is awake
// for anything else, the PC node uses it without a lease and can cause no sleep;
// if pc-power sleeps it anyway, the item in progress simply starts again later.
// Only after ▶️ Wake PC (Worker.markPcWoken) does it hold the lease, until it
// runs out of work: then the PC was woken for this, and may sleep after it.
import { inHours, type Hours } from './hours.ts';
import type { Lease, LeaseState } from './lease.ts';
import type { PcPower, PowerState } from './power.ts';
import { OllamaCrash } from './ollama.ts';
import type { Store } from './store.ts';
import type { Generate } from './translate.ts';
import type { Current, Worker } from './worker.ts';

// checking: just resumed, finding out whether its model answers.
export const NODE_STATES = ['working', 'idle', 'offline', 'paused', 'outside_hours', 'checking'] as const;
export type NodeState = (typeof NODE_STATES)[number];

export const MAX_BACKOFF_MS = 15 * 60_000;
export const SEEN_SAVE_MS = 10 * 60_000;
// Crashes in a row a woken PC keeps its lease through: Ollama starts a new
// runner on the next request, so one crash does not mean the work is over.
export const CRASHES_HELD = 3;

export type NodeStatus = {
  name: string;
  label: string;
  state: NodeState;
  // The owner's pause, which a working node obeys after its current item.
  paused: boolean;
  problem: string | null;
  current: Current | null;
  lease: LeaseState | null;
  // When its Ollama last answered, across restarts; null if it never has.
  lastSeen: number | null;
  // The PC's own power, from the power client (the PC node only).
  power?: PowerState | null;
};

export type Model = { problem(): Promise<string | null>; generate: Generate };

export class NodeRunner {
  readonly name: string;
  readonly label: string;
  private readonly model: Model;
  private readonly worker: Worker;
  private readonly store: Store;
  private readonly lease: Lease | null;
  private readonly power: PcPower | null;
  private readonly powerEveryMs: number;
  // Wake the loop's sleep, and the power watcher's, early.
  private wakeStep: (() => void) | null = null;
  private wakePower: (() => void) | null = null;
  private readonly hours: Hours;
  private readonly takesHeld: boolean;
  private readonly waitMs: { idle: number; offline: number; paused: number };
  private readonly now: () => number;
  private state: NodeState = 'idle';
  private problem: string | null = null;
  private lastSeen: number | null = null;
  // Outages in a row while the model answered: Bazarr down, or a batch
  // past its deadline. Each doubles the wait.
  private misses = 0;
  private stopped = false;
  private stopping: Promise<void> | null = null;

  constructor(opts: {
    name: string;
    label: string;
    model: Model;
    worker: Worker;
    store: Store;
    lease?: Lease | null;
    power?: PcPower | null;
    // How often the PC's power is asked, paused or not.
    powerEveryMs?: number;
    hours?: Hours;
    takesHeld?: boolean;
    waitMs?: { idle: number; offline: number; paused: number };
    now?: () => number;
  }) {
    this.name = opts.name;
    this.label = opts.label;
    this.model = opts.model;
    this.worker = opts.worker;
    this.store = opts.store;
    this.lease = opts.lease ?? null;
    this.power = opts.power ?? null;
    this.powerEveryMs = opts.powerEveryMs ?? 30_000;
    this.hours = opts.hours ?? null;
    this.takesHeld = opts.takesHeld ?? false;
    this.waitMs = opts.waitMs ?? { idle: 60_000, offline: 30_000, paused: 15_000 };
    this.now = opts.now ?? Date.now;
    const saved = Number(this.store.getMeta(`seen:${this.name}`));
    this.lastSeen = saved > 0 ? saved : null;
  }

  // When its Ollama last answered, kept in the database so a restart still
  // knows the node has worked. Malak asks to wake the PC only for a PC node
  // that has answered at least once: before the PC's subtitle Ollama is
  // installed, waking the PC would do nothing. Written at most every
  // SEEN_SAVE_MS, since a node answers every minute.
  private markSeen(): void {
    const now = this.now();
    const saved = Number(this.store.getMeta(`seen:${this.name}`) ?? 0);
    if (now - saved >= SEEN_SAVE_MS) this.store.setMeta(`seen:${this.name}`, String(now));
    this.lastSeen = now;
  }

  // The owner's pause, kept in the database so it survives a restart.
  get paused(): boolean {
    return this.store.getMeta(`paused:${this.name}`) === '1';
  }

  // Pause and Resume only decide whether subfill uses this node; they never
  // turn the PC on or off. Either takes effect now, not after the loop's
  // sleep: a resumed node that finds its model away waits for it, and starts
  // by itself once it answers.
  setPaused(paused: boolean): void {
    if (paused) this.store.setMeta(`paused:${this.name}`, '1');
    else this.store.deleteMeta(`paused:${this.name}`);
    if (paused && this.state !== 'working') this.state = 'paused';
    if (!paused && this.state === 'paused') this.state = 'checking';
    this.poke();
  }

  // Look again now: at the model (the loop) and at the PC's power.
  poke(): void {
    this.wakeStep?.();
    this.wakePower?.();
  }

  private sleep(ms: number, slot: 'step' | 'power'): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (slot === 'step') this.wakeStep = null;
        else this.wakePower = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      if (slot === 'step') this.wakeStep = done;
      else this.wakePower = done;
    });
  }

  // The PC's power, asked on its own clock, paused or not: whether the PC
  // is on is the PC's business, not the node's.
  private async watchPower(): Promise<void> {
    while (this.power && !this.stopped) {
      await this.power.refresh();
      if (!this.stopped) await this.sleep(this.powerEveryMs, 'power');
    }
  }

  status(): NodeStatus {
    return {
      name: this.name,
      label: this.label,
      state: this.state,
      paused: this.paused,
      problem: this.problem,
      current: this.worker.currentOf(this.name),
      lease: this.lease?.state ?? null,
      lastSeen: this.lastSeen,
      power: this.power?.state ?? null,
    };
  }

  // Gives the lease back. If it was held, the wake it served is over: the
  // next stretch of work on the PC runs without one until the next wake.
  private async letGo(): Promise<void> {
    if (!this.lease?.state.held) return;
    await this.lease.release();
    this.worker.clearPcWoken();
  }

  // One turn of the loop. Returns how long to wait before the next.
  async step(): Promise<number> {
    if (this.paused) {
      this.state = 'paused';
      await this.letGo();
      return this.waitMs.paused;
    }
    if (!inHours(this.hours, new Date(this.now()))) {
      this.state = 'outside_hours';
      return this.waitMs.idle;
    }
    this.problem = await this.model.problem();
    if (this.problem) {
      // Just found away: ask about the PC's power now, not at the next tick.
      if (this.state !== 'offline') this.wakePower?.();
      this.state = 'offline';
      await this.letGo();
      return this.waitMs.offline;
    }
    this.markSeen();
    if (!this.store.next(this.now(), this.takesHeld)) {
      this.state = 'idle';
      this.misses = 0;
      await this.letGo();
      return this.waitMs.idle;
    }
    if (this.stopped) return 0;
    if (this.lease && this.worker.pcWoken()) await this.lease.hold();
    this.state = 'working';
    let crashed = false;
    const generate: Generate = async (prompt) => {
      try {
        return await this.model.generate(prompt);
      } catch (err) {
        if (err instanceof OllamaCrash) crashed = true;
        throw err;
      }
    };
    try {
      const worked = await this.worker.translateNext({ name: this.name, generate, takesHeld: this.takesHeld });
      if (worked) {
        this.misses = 0;
        return 0;
      }
      this.misses++;
      // An outage while the model looked fine: nothing to keep the PC up for.
      // A crashed runner is the exception for a few in a row, since the next
      // request starts a new one: letting go would end the owner's wake and
      // let pc-power hibernate the PC with the work still there.
      if (!crashed || this.misses > CRASHES_HELD) await this.letGo();
      return Math.min(this.waitMs.offline * 2 ** this.misses, MAX_BACKOFF_MS);
    } finally {
      this.state = 'idle';
    }
  }

  async run(): Promise<void> {
    const watching = this.watchPower();
    while (!this.stopped) {
      let wait = this.waitMs.idle;
      try {
        wait = await this.step();
      } catch (err) {
        console.error(`${this.name} node:`, (err as Error).message);
      }
      if (wait > 0 && !this.stopped) await this.sleep(wait, 'step');
    }
    await watching;
  }

  // Once only: a second signal waits for the first stop rather than racing it.
  stop(): Promise<void> {
    this.stopped = true;
    this.poke();
    this.stopping ??= this.lease ? this.lease.release() : Promise.resolve();
    return this.stopping;
  }
}
