// subfill's entry point: the sync loop (which also reads Bazarr's library for
// the page), one loop per node, and the page.
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
import { LibraryStore } from './library.ts';
import { NodeRunner } from './nodes.ts';
import { PcPower } from './power.ts';
import { Ollama } from './ollama.ts';
import { Store } from './store.ts';
import { ARABIC } from './translate.ts';
import { startWeb, type Status } from './web.ts';
import { Worker } from './worker.ts';

const settings = readSettings(process.env);
const store = new Store(path.join(settings.dataDir, 'subfill.db'));
const library = new LibraryStore(store.db);
const recovered = store.recoverInterrupted();
if (recovered) console.log(`picked up ${recovered} translation(s) interrupted by the last stop`);
// Before crashes were told apart, a dead model runner used up an episode's
// attempts. Those episodes did nothing wrong; give them another go.
const requeued = store.requeueCrashFailures();
for (const key of requeued) store.log(key, 'tried again: it failed only because the model crashed');
if (requeued.length) console.log(`put back ${requeued.length} episode(s) that failed only because the model crashed`);

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
let pcPower: PcPower | null = null;
if (settings.pcOllamaUrl) {
  // A batch takes seconds on the GPU, so a PC that has not answered in three
  // minutes has gone to sleep, not slowed down.
  const pc = new Ollama({ url: settings.pcOllamaUrl, model: settings.model, timeoutMs: 3 * 60_000 });
  const lease = settings.powerClientToken ? new Lease({ url: settings.powerClientUrl, token: settings.powerClientToken }) : null;
  pcPower = settings.powerClientToken ? new PcPower({ url: settings.powerClientUrl, token: settings.powerClientToken }) : null;
  if (!lease) console.log('no POWER_CLIENT_TOKEN: the PC may hibernate in the middle of an episode, which then starts again later');
  nodes.push(
    new NodeRunner({
      name: 'pc',
      label: 'PC (GPU)',
      model: { problem: () => pc.problem(), generate: (p) => pc.generate(p) },
      worker,
      store,
      lease,
      power: pcPower,
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
    // After the sync, so the page's shows already know about any new item.
    const libraryProblem = await library.refresh(() => bazarr.library(), ARABIC.code);
    if (libraryProblem) console.error('library read failed:', libraryProblem);
    await sleep(settings.syncMinutes * 60_000);
  }
}

const server = startWeb(
  {
    store,
    library,
    worker,
    subtitles: { mediaRoot: settings.mediaRoot, targetCode: ARABIC.code, sourceLanguages: settings.sourceLanguages },
    loginUrl: settings.loginUrl,
    apiToken: settings.apiToken,
    status: () => ({ ...status, nodes: nodes.map((n) => n.status()), model: settings.model }),
    // The PC card's Turn on: wakes the PC through the power client, and marks
    // the wake as subfill's own, so the PC node holds its lease while it works.
    turnOnPc: async () => {
      if (!pcPower) return 'there is no PC node, or no power client token';
      // Only the PC's power: a paused PC node stays paused, so the queue can
      // be reordered before anything starts.
      const problem = await pcPower.turnOn();
      if (!problem) worker.markPcWoken(30);
      nodes.find((n) => n.name === 'pc')?.poke();
      return problem;
    },
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
