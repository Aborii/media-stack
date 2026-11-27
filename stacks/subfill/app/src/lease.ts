// subfill's lease on the PC, through the mini's power client: held while the
// PC node is translating, so pc-power does not hibernate the PC under an
// episode, and dropped as soon as the PC has nothing left to do.
//
// It never asks for a wake (no `wake: true`). Waking the PC is the owner's
// call, made through Malak or the Turn on button (power.ts); this only keeps
// an awake PC from sleeping while it works. pc-power still decides when to
// sleep once the lease is gone.
//
// The power client forgets a registration not renewed within 180 s, so it is
// renewed every RENEW_MS while held. A failed call is logged and shown on the
// page; it never stops a translation.

export const RENEW_MS = 120_000;

export type LeaseState = { held: boolean; error: string | null };

export class Lease {
  private readonly url: string;
  private readonly token: string;
  private readonly app: string;
  private readonly fetcher: typeof fetch;
  private readonly renewMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  // The last PUT, so a release waits for it: a renewal landing after the
  // DELETE would register the lease again for another 180 s.
  private putting: Promise<boolean> | null = null;
  state: LeaseState = { held: false, error: null };

  constructor(opts: { url: string; token: string; app?: string; fetcher?: typeof fetch; renewMs?: number }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    this.app = opts.app ?? 'subfill';
    this.fetcher = opts.fetcher ?? fetch;
    this.renewMs = opts.renewMs ?? RENEW_MS;
  }

  private async call(method: 'PUT' | 'DELETE'): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.url}/apps/${this.app}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({}) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`power client answered ${res.status}`);
      this.state = { ...this.state, error: null };
      return true;
    } catch (err) {
      this.state = { ...this.state, error: `lease ${method === 'PUT' ? 'renewal' : 'release'} failed: ${(err as Error).message}` };
      console.error(this.state.error);
      return false;
    }
  }

  private put(): Promise<boolean> {
    this.putting = this.call('PUT');
    return this.putting;
  }

  // Takes the lease if it is not held, and keeps it renewed.
  async hold(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.timer) void this.put();
    }, this.renewMs);
    this.timer.unref?.();
    this.state = { ...this.state, held: true };
    await this.put();
  }

  // Gives the lease back if it is held, after any PUT still on its way.
  async release(): Promise<void> {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.state = { ...this.state, held: false };
    await this.putting;
    await this.call('DELETE');
  }
}
