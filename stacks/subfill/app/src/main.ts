// subfill's entry point: two loops and the page.
//
// The sync loop reads Bazarr every SYNC_MINUTES. The work loop translates one
// item at a time, inside ACTIVE_HOURS, whenever the model is there. They are
// separate so a translation that takes most of an hour does not hold up the
// sync that notices a human subtitle arrived.
import path from 'node:path';
import { Bazarr, BazarrError } from './bazarr.ts';
import { readSettings } from './config.ts';
import { inHours } from './hours.ts';
import { Ollama } from './ollama.ts';
import { Store } from './store.ts';
import { ARABIC } from './translate.ts';
import { startWeb, type Status } from './web.ts';
import { Worker } from './worker.ts';

const settings = readSettings(process.env);
const store = new Store(path.join(settings.dataDir, 'subfill.db'));
const recovered = store.recoverInterrupted();
if (recovered) console.log(`picked up ${recovered} translation(s) interrupted by the last stop`);

const bazarr = new Bazarr({ url: settings.bazarrUrl, apiKey: settings.bazarrApiKey });
const ollama = new Ollama({ url: settings.ollamaUrl, model: settings.model });
const worker = new Worker({
  store,
  bazarr,
  generate: (prompt) => ollama.generate(prompt),
  config: {
    target: ARABIC,
    sourceLanguages: settings.sourceLanguages,
    waitMs: settings.waitHours * 3600_000,
    batchSize: settings.batchSize,
    maxAttempts: settings.maxAttempts,
    retryDelayMs: 3600_000,
    mediaRoot: settings.mediaRoot,
  },
});

const status: Omit<Status, 'current' | 'outsideHours' | 'model'> = { bazarrError: null, ollamaProblem: null, lastSync: null };
const savedSync = store.getMeta('last_sync');
status.lastSync = savedSync ? Number(savedSync) : null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

async function syncLoop(): Promise<void> {
  while (!stopping) {
    try {
      const r = await worker.sync();
      status.bazarrError = null;
      status.lastSync = Date.now();
      store.setMeta('last_sync', String(status.lastSync));
      console.log(`sync: ${r.wanted} items want Arabic, ${r.tracked} tracked`);
    } catch (err) {
      const message = (err as Error).message;
      status.bazarrError =
        err instanceof BazarrError
          ? `Could not read Bazarr: ${message}. Nothing was changed; trying again in ${settings.syncMinutes} min.`
          : `The sync stopped partway: ${message}. Trying again in ${settings.syncMinutes} min.`;
      console.error('sync failed:', message);
    }
    await sleep(settings.syncMinutes * 60_000);
  }
}

async function workLoop(): Promise<void> {
  while (!stopping) {
    let worked = false;
    try {
      status.ollamaProblem = await ollama.problem();
      if (!status.ollamaProblem && inHours(settings.activeHours, new Date())) worked = await worker.translateNext();
    } catch (err) {
      console.error('work loop:', (err as Error).message);
    }
    if (!worked) await sleep(60_000);
  }
}

const server = startWeb(
  {
    store,
    worker,
    loginUrl: settings.loginUrl,
    status: () => ({
      ...status,
      current: worker.current,
      outsideHours: !inHours(settings.activeHours, new Date()),
      model: settings.model,
    }),
  },
  settings.port,
);
console.log(`subfill on :${settings.port}, model ${settings.model}, from ${settings.sourceLanguages.join(',')}`);

void syncLoop();
void workLoop();

function stop(): void {
  stopping = true;
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
