// subfill's entry point: the sync loop, one loop per node, and the page.
//
// The sync loop reads Bazarr every SYNC_MINUTES. Each node translates one item
// at a time from the same queue: the mini inside ACTIVE_HOURS, the PC whenever
// its Ollama answers (PC_OLLAMA_URL). They are separate loops so an hour-long
// translation on the mini never holds up the PC, or the sync that notices a
// human subtitle arrived.
import path from 'node:path';
import { Bazarr, BazarrError } from './bazarr.ts';
import { readSettings } from './config.ts';
import { Lease } from './lease.ts';
import { NodeRunner } from './nodes.ts';
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
const mini = new Ollama({ url: settings.ollamaUrl, model: settings.model });
const worker = new Worker({
  store,
  bazarr,
  generate: (prompt) => mini.generate(prompt),
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

const nodes: NodeRunner[] = [
  new NodeRunner({
    name: 'mini',
    label: 'Mini (CPU)',
    model: { problem: () => mini.problem(), generate: (p) => mini.generate(p) },
    worker,
    store,
    hours: settings.activeHours,
  }),
];
if (settings.pcOllamaUrl) {
  // A batch takes seconds on the GPU, so a PC that has not answered in three
  // minutes has gone to sleep, not slowed down.
  const pc = new Ollama({ url: settings.pcOllamaUrl, model: settings.model, timeoutMs: 3 * 60_000 });
  const lease = settings.powerClientToken ? new Lease({ url: settings.powerClientUrl, token: settings.powerClientToken }) : null;
  if (!lease) console.log('no POWER_CLIENT_TOKEN: the PC may hibernate in the middle of an episode, which then starts again later');
  nodes.push(
    new NodeRunner({
      name: 'pc',
      label: 'PC (GPU)',
      model: { problem: () => pc.problem(), generate: (p) => pc.generate(p) },
      worker,
      store,
      lease,
      takesHeld: true,
    }),
  );
}

const status: Pick<Status, 'bazarrError' | 'lastSync'> = { bazarrError: null, lastSync: null };
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

const server = startWeb(
  {
    store,
    worker,
    loginUrl: settings.loginUrl,
    apiToken: settings.apiToken,
    status: () => ({ ...status, nodes: nodes.map((n) => n.status()), model: settings.model }),
    setNodePaused: (name, paused) => {
      const node = nodes.find((n) => n.name === name);
      if (!node) return `no node called ${name}`;
      node.setPaused(paused);
      return null;
    },
  },
  settings.port,
);
console.log(
  `subfill on :${settings.port}, model ${settings.model}, from ${settings.sourceLanguages.join(',')}, nodes ${nodes.map((n) => n.name).join(', ')}`,
);

void syncLoop();
for (const node of nodes) void node.run();

// Once only: a second signal must not close the store before the first stop
// has given the PC's lease back.
let stopped: Promise<void> | null = null;
function stop(): Promise<void> {
  stopped ??= (async () => {
    stopping = true;
    server.close();
    await Promise.all(nodes.map((n) => n.stop()));
    store.close();
    process.exit(0);
  })();
  return stopped;
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
