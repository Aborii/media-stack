// The Ollama calls subfill makes: is the model there, and translate one prompt.
//
// Temperature 0 because a subtitle wants the most likely translation, not a
// creative one. The deadline is long on purpose: a 12B model on the mini's CPU
// takes a minute or two per batch, and a slow answer is still a good one.
import { Unavailable } from './errors.ts';

// An answer from Ollama that is an error: counted against the item.
export class OllamaError extends Error {}
// No answer at all (stopped, restarting, or past the deadline): an outage.
export class OllamaDown extends Unavailable {}

export class Ollama {
  private readonly base: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { url: string; model: string; fetcher?: typeof fetch; timeoutMs?: number }) {
    this.base = opts.url.replace(/\/+$/, '');
    this.model = opts.model;
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  }

  // null when the model is pulled, otherwise what is wrong, for the page.
  async problem(): Promise<string | null> {
    try {
      const res = await this.fetcher(`${this.base}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return `Ollama answered ${res.status}`;
      const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
      const names = (body.models ?? []).flatMap((m) => [m.name, m.model]);
      const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
      return names.includes(wanted) ? null : `model ${this.model} is not pulled into Ollama`;
    } catch (err) {
      return `Ollama unreachable: ${(err as Error).message}`;
    }
  }

  async generate(prompt: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          keep_alive: '5m',
          options: { temperature: 0, num_ctx: 4096, num_predict: 2048 },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new OllamaDown(`Ollama call failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new OllamaError(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { response?: string };
    return body.response ?? '';
  }
}
