// The machines that translate, Tdarr-style: the mini, always on and slow, and
// the PC, fast whenever it is awake. Each runs its own loop over the one
// queue; the store's guarded claim keeps two of them off the same item.
//
// A loop step, in order:
//   paused by the owner   -> nothing, and the PC's lease goes back
//   outside its hours     -> nothing (the mini only: the hours protect it)
//   its Ollama not there  -> offline: asleep, paused on the PC, or no model
//   no work it may take   -> idle, and the lease goes back
//   otherwise             -> take the lease (PC), translate one item
// A node that drops in the middle of an item hands it back without using an
// attempt (Worker.translateNext), and the next node to look takes it.
import { inHours, type Hours } from './hours.ts';
import type { Lease, LeaseState } from './lease.ts';
import type { Store } from './store.ts';
import type { Generate } from './translate.ts';
import type { Current, Worker } from './worker.ts';

export const NODE_STATES = ['working', 'idle', 'offline', 'paused', 'outside_hours'] as const;
export type NodeState = (typeof NODE_STATES)[number];

export type NodeStatus = {
  name: string;
  label: string;
  state: NodeState;
  problem: string | null;
  current: Current | null;
  lease: LeaseState | null;
  // When its Ollama last answered.
  lastSeen: number | null;
};

export type Model = { problem(): Promise<string | null>; generate: Generate };

export class NodeRunner {
  readonly name: string;
  readonly label: string;
  private readonly model: Model;
  private readonly worker: Worker;
  private readonly store: Store;
  private readonly lease: Lease | null;
  private readonly hours: Hours;
  private readonly takesHeld: boolean;
  private readonly waitMs: { idle: number; offline: number; paused: number };
  private readonly now: () => number;
  private state: NodeState = 'idle';
  private problem: string | null = null;
  private lastSeen: number | null = null;
  private stopped = false;

  constructor(opts: {
    name: string;
    label: string;
    model: Model;
    worker: Worker;
    store: Store;
    lease?: Lease | null;
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
    this.hours = opts.hours ?? null;
    this.takesHeld = opts.takesHeld ?? false;
    this.waitMs = opts.waitMs ?? { idle: 60_000, offline: 30_000, paused: 15_000 };
    this.now = opts.now ?? Date.now;
  }

  // The owner's pause, kept in the database so it survives a restart.
  get paused(): boolean {
    return this.store.getMeta(`paused:${this.name}`) === '1';
  }

  setPaused(paused: boolean): void {
    if (paused) this.store.setMeta(`paused:${this.name}`, '1');
    else this.store.deleteMeta(`paused:${this.name}`);
  }

  status(): NodeStatus {
    return {
      name: this.name,
      label: this.label,
      state: this.state,
      problem: this.problem,
      current: this.worker.currentOf(this.name),
      lease: this.lease?.state ?? null,
      lastSeen: this.lastSeen,
    };
  }

  // One turn of the loop. Returns how long to wait before the next.
  async step(): Promise<number> {
    if (this.paused) {
      this.state = 'paused';
      await this.lease?.release();
      return this.waitMs.paused;
    }
    if (!inHours(this.hours, new Date(this.now()))) {
      this.state = 'outside_hours';
      return this.waitMs.idle;
    }
    this.problem = await this.model.problem();
    if (this.problem) {
      this.state = 'offline';
      await this.lease?.release();
      return this.waitMs.offline;
    }
    this.lastSeen = this.now();
    if (!this.store.next(this.now(), this.takesHeld)) {
      this.state = 'idle';
      await this.lease?.release();
      return this.waitMs.idle;
    }
    await this.lease?.hold();
    this.state = 'working';
    try {
      const worked = await this.worker.translateNext({ name: this.name, generate: this.model.generate, takesHeld: this.takesHeld });
      return worked ? 0 : this.waitMs.idle;
    } finally {
      this.state = 'idle';
    }
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      let wait = this.waitMs.idle;
      try {
        wait = await this.step();
      } catch (err) {
        console.error(`${this.name} node:`, (err as Error).message);
      }
      if (wait > 0 && !this.stopped) await new Promise((r) => setTimeout(r, wait));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.lease?.release();
  }
}
