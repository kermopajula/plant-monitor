// Web process: dashboard, setup pages, JSON API and the alert loop.

import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { config, ROOT } from '../config';
import { rangesOf, SETTINGS, Store, type SensorRow } from '../db';
import { UPDATE_STEPS, UPDATE_WARNINGS, describeFirmware } from '../lib/firmware';
import { createLogger } from '../lib/log';
import { normalizeMac } from '../lib/miflora';
import { createNotifiers } from '../lib/notifiers';
import { PlantbookClient, PlantbookError, rangesFromPlantbook, type PlantDetail } from '../lib/plantbook';
import { errorMessage } from '../lib/retry';
import { METRICS, type Ranges } from '../lib/status';
import { buildPlantView, intervalMinutes } from '../plants';
import { Alerter, alertAfterMinutes } from './alerter';
import { HttpError, Router, sendFile } from './http';

const log = createLogger('web');
const store = new Store(config.dbPath);
const plantbook = new PlantbookClient(config.plantbookApiKey, config.plantbookBaseUrl);
const notifiers = createNotifiers(config, (msg) => log.warn(msg));
const alerter = new Alerter(store, notifiers);

const PUBLIC = join(ROOT, 'public');
const CHART_JS = join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
const DAY = 86400_000;
const SPECIES_CACHE_MS = 30 * DAY;

function requireSensor(mac: string): SensorRow {
  const s = store.getSensor(normalizeMac(mac));
  if (!s) throw new HttpError(404, `Unknown sensor ${mac}`);
  return s;
}

function obj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body as Record<string, unknown>;
}

function optString(v: unknown, field: string, max = 100): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return t || null;
}

function optNumber(v: unknown, field: string): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  return n;
}

function intInRange(v: unknown, field: string, min: number, max: number): number {
  const n = optNumber(v, field);
  if (n == null || !Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function parseRanges(v: unknown): Ranges {
  const o = obj(v);
  const out = {} as Ranges;
  for (const m of METRICS) {
    const r = o[m] == null ? {} : obj(o[m]);
    const min = optNumber(r.min, `${m}.min`);
    const max = optNumber(r.max, `${m}.max`);
    if (min != null && max != null && min > max) throw new HttpError(400, `${m}: min must not be above max`);
    out[m] = { min, max };
  }
  return out;
}

function sensorSummary(s: SensorRow) {
  return {
    mac: s.mac,
    adopted: !!s.adopted,
    name: s.name,
    species: s.species,
    plantPid: s.plant_pid,
    rangesSource: s.ranges_source,
    ranges: rangesOf(s),
    firmware: describeFirmware(s.firmware),
    battery: s.battery,
    mode: s.mode,
    firstSeen: s.first_seen,
    lastSeen: s.last_seen,
    rssi: s.rssi,
    bleName: s.ble_name,
    lastError: s.last_error,
    lastErrorAt: s.last_error_at,
  };
}

async function speciesDetail(pid: string): Promise<PlantDetail> {
  const cached = store.getSpecies(pid);
  if (cached && Date.now() - cached.fetched_at < SPECIES_CACHE_MS) return JSON.parse(cached.data) as PlantDetail;
  try {
    const d = await plantbook.detail(pid);
    store.putSpecies(d.pid, d.display_pid || d.pid, d, Date.now());
    return d;
  } catch (err) {
    if (cached) {
      log.warn(`Open Plant Book refresh failed, using cached ${pid}: ${errorMessage(err)}`);
      return JSON.parse(cached.data) as PlantDetail;
    }
    throw err;
  }
}

function plantbookError(err: unknown): never {
  if (err instanceof PlantbookError) {
    throw new HttpError(err.status === 404 ? 404 : 502, err.message);
  }
  throw new HttpError(502, `Open Plant Book request failed: ${errorMessage(err)}`);
}

const router = new Router()
  .on('GET', '/api/plants', () => {
    const now = Date.now();
    const interval = intervalMinutes(store);
    return {
      now,
      intervalMinutes: interval,
      plants: store.listSensors(true).map((s) => buildPlantView(store, s, now, interval)),
      firmwareHelp: { steps: UPDATE_STEPS, warnings: UPDATE_WARNINGS },
    };
  })
  .on('GET', '/api/plants/:mac/history', ({ params, query }) => {
    const s = requireSensor(params.mac);
    const days = query.get('days') === '30' ? 30 : 7;
    const bucketMs = days === 30 ? 2 * 3600_000 : 30 * 60_000;
    const now = Date.now();
    return { mac: s.mac, days, bucketMs, now, points: store.history(s.mac, now - days * DAY, bucketMs) };
  })
  .on('GET', '/api/sensors', () => {
    const all = store.listSensors();
    return {
      adopted: all.filter((s) => s.adopted).map(sensorSummary),
      discovered: all.filter((s) => !s.adopted).map(sensorSummary),
    };
  })
  .on('PUT', '/api/sensors/:mac', ({ params, body }) => {
    const s = requireSensor(params.mac);
    const b = obj(body);
    const update: Parameters<Store['updateSensor']>[1] = {};
    if ('adopted' in b) update.adopted = b.adopted ? 1 : 0;
    if ('name' in b) update.name = optString(b.name, 'name');
    if ('species' in b) {
      update.species = optString(b.species, 'species');
      if (!update.species) update.plant_pid = null;
    }
    if ('ranges' in b) {
      update.ranges = parseRanges(b.ranges);
      update.ranges_source = 'custom';
    }
    store.updateSensor(s.mac, update);
    return sensorSummary(store.getSensor(s.mac)!);
  })
  .on('DELETE', '/api/sensors/:mac', ({ params, query }) => {
    const s = requireSensor(params.mac);
    if (query.get('forget') === '1') store.forgetSensor(s.mac);
    else store.updateSensor(s.mac, { adopted: 0 });
    return { ok: true };
  })
  .on('POST', '/api/sensors/:mac/species', async ({ params, body }) => {
    const s = requireSensor(params.mac);
    const pid = optString(obj(body).pid, 'pid', 200);
    if (!pid) throw new HttpError(400, 'pid is required');
    const d = await speciesDetail(pid).catch(plantbookError);
    store.updateSensor(s.mac, {
      species: d.display_pid || d.pid,
      plant_pid: d.pid,
      ranges: rangesFromPlantbook(d),
      ranges_source: 'plantbook',
    });
    return sensorSummary(store.getSensor(s.mac)!);
  })
  .on('GET', '/api/species/search', async ({ query }) => {
    const q = (query.get('q') ?? '').trim();
    if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters');
    if (!plantbook.configured) throw new HttpError(503, 'PLANTBOOK_API_KEY is not set on the Pi (see README)');
    return { results: await plantbook.search(q).catch(plantbookError) };
  })
  .on('GET', '/api/settings', () => {
    const raw = store.getSetting(SETTINGS.collectorStatus);
    return {
      intervalMinutes: intervalMinutes(store),
      alertAfterMinutes: alertAfterMinutes(store),
      scanSeconds: config.scanSeconds,
      plantbookConfigured: plantbook.configured,
      notifiers: notifiers.map((n) => n.name),
      collector: raw ? JSON.parse(raw) : null,
      scanRequestedAt: store.getNumberSetting(SETTINGS.scanRequestedAt, 0) || null,
    };
  })
  .on('PUT', '/api/settings', ({ body }) => {
    const b = obj(body);
    if ('intervalMinutes' in b) store.setSetting(SETTINGS.intervalMinutes, intInRange(b.intervalMinutes, 'intervalMinutes', 5, 1440));
    if ('alertAfterMinutes' in b) {
      store.setSetting(SETTINGS.alertAfterMinutes, intInRange(b.alertAfterMinutes, 'alertAfterMinutes', 0, 10080));
    }
    return { ok: true };
  })
  .on('POST', '/api/scan', () => {
    store.setSetting(SETTINGS.scanRequestedAt, Date.now());
    return { ok: true };
  })
  .on('POST', '/api/alerts/test', async () => {
    if (!notifiers.length) throw new HttpError(400, 'No notifier configured (set NTFY_URL, WEBHOOK_URL or RESEND_API_KEY)');
    try {
      const errors = await alerter.send({
        kind: 'test',
        title: '🪴 Plant monitor test',
        message: 'Notifications are working.',
        url: config.dashboardUrl || undefined,
      });
      return { ok: true, errors };
    } catch (err) {
      throw new HttpError(502, errorMessage(err));
    }
  });

const server = createServer(async (req, res) => {
  try {
    if (await router.handle(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    let ok = false;
    if (path === '/' || path === '/index.html') ok = await sendFile(res, join(PUBLIC, 'index.html'));
    else if (path === '/setup') ok = await sendFile(res, join(PUBLIC, 'setup.html'));
    else if (path === '/static/chart.umd.min.js') ok = await sendFile(res, CHART_JS, 86400);
    else if (path.startsWith('/static/')) ok = await sendFile(res, join(PUBLIC, basename(path)));
    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(err instanceof Error ? err.message : 'Error');
  }
});

server.listen(config.port, config.host, () => {
  log.info(`dashboard on http://${config.host}:${config.port} (db=${config.dbPath})`);
  if (!plantbook.configured) log.warn('PLANTBOOK_API_KEY not set: species search is disabled');
  alerter.start();
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    alerter.stop();
    server.close();
    store.close();
    process.exit(0);
  });
}
