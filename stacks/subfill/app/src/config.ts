// Every setting subfill reads, from the environment, read once at start.
// compose.yaml sets them; the header there says what each is for.
import { parseHours, type Hours } from './hours.ts';

export type Settings = {
  port: number;
  dataDir: string;
  mediaRoot: string;
  bazarrUrl: string;
  bazarrApiKey: string;
  ollamaUrl: string;
  model: string;
  sourceLanguages: string[];
  waitHours: number;
  activeHours: Hours;
  batchSize: number;
  syncMinutes: number;
  maxAttempts: number;
  loginUrl: string;
};

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number of at least ${min}, not "${raw}"`);
  return n;
}

export function readSettings(env: NodeJS.ProcessEnv): Settings {
  const bazarrApiKey = env.BAZARR_API_KEY ?? '';
  if (!bazarrApiKey) throw new Error('BAZARR_API_KEY is not set');
  const sourceLanguages = (env.SOURCE_LANGUAGES || 'en')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (sourceLanguages.some((l) => !/^[a-z]{2}$/.test(l))) {
    throw new Error(`SOURCE_LANGUAGES must be two-letter codes like en,fr, not "${env.SOURCE_LANGUAGES}"`);
  }
  return {
    port: num(env, 'PORT', 8080, 1),
    dataDir: env.DATA_DIR || '/var/lib/subfill',
    mediaRoot: env.MEDIA_ROOT || '/data',
    bazarrUrl: env.BAZARR_URL || 'http://bazarr:6767',
    bazarrApiKey,
    ollamaUrl: env.OLLAMA_URL || 'http://ollama:11434',
    model: env.MODEL || 'translategemma:12b',
    sourceLanguages,
    waitHours: num(env, 'WAIT_HOURS', 72, 0),
    activeHours: parseHours(env.ACTIVE_HOURS ?? ''),
    batchSize: num(env, 'BATCH_SIZE', 30, 1),
    syncMinutes: num(env, 'SYNC_MINUTES', 30, 1),
    maxAttempts: num(env, 'MAX_ATTEMPTS', 3, 1),
    loginUrl: env.LOGIN_URL || 'http://subfill-login:8000',
  };
}
