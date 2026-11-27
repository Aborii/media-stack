// The PC's power, through the mini's power client: whether the PC itself is
// on, starting, asleep or off, which subfill cannot tell from its model alone
// (a PC can be on with its subtitle Ollama not running), and the button to
// turn it on. subfill may turn the PC on only when the power client grants
// it `on` (POWER_CLIENT_ALLOW); it can never turn it off.

// What the power client calls the PC: on, starting, asleep, off, unknown, switch-unreachable.
export type PowerState = {
  pc: string | null;
  // The power client grants subfill `on`.
  canTurnOn: boolean;
  checkedAt: number | null;
  error: string | null;
  // Why the power client's last wake gave up, if it did.
  wakeError?: string | null;
};

export class PcPower {
  private readonly url: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  state: PowerState = { pc: null, canTurnOn: false, checkedAt: null, error: null };

  constructor(opts: { url: string; token: string; fetcher?: typeof fetch; now?: () => number }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetcher = opts.fetcher ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async get(path: string): Promise<Response> {
    return this.fetcher(`${this.url}${path}`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000) });
  }

  // Asks the power client how the PC is, and what subfill may do. A failure
  // is kept as the reason and never thrown: it only colours the page.
  async refresh(): Promise<PowerState> {
    try {
      const status = await this.get('/status');
      if (!status.ok) throw new Error(`power client answered ${status.status}`);
      const body = (await status.json()) as { pc?: unknown; wake?: { waking?: unknown; lastError?: unknown } };
      // A wake under way counts as starting, though the light may still read off.
      const pc = body.wake?.waking === true && body.pc !== 'on' ? 'starting' : String(body.pc ?? 'unknown');
      const wakeError = typeof body.wake?.lastError === 'string' && body.wake.lastError ? body.wake.lastError : null;
      // An older power client has no /me, and no way for subfill to turn the PC on.
      const me = await this.get('/me');
      const can = me.ok ? (((await me.json()) as { can?: unknown }).can ?? []) : [];
      this.state = { pc, canTurnOn: Array.isArray(can) && can.includes('on'), checkedAt: this.now(), error: null, wakeError };
    } catch (err) {
      // No reading now: an old one shown as if just checked would send the
      // owner to the wrong fix.
      this.state = { pc: null, canTurnOn: false, checkedAt: this.now(), error: `could not ask the power client: ${(err as Error).message}`, wakeError: null };
    }
    return this.state;
  }

  // Wakes the PC. Returns a problem for the page, or null.
  async turnOn(): Promise<string | null> {
    try {
      const res = await this.fetcher(`${this.url}/pc/turn-on`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403) return 'the power client does not allow subfill to turn the PC on (POWER_CLIENT_ALLOW)';
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return `the power client could not turn the PC on: ${body.error ?? `it answered ${res.status}`}`;
      }
      this.state = { ...this.state, pc: 'starting', checkedAt: this.now(), error: null };
      return null;
    } catch (err) {
      return `could not reach the power client: ${(err as Error).message}`;
    }
  }
}
