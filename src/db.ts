import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AlertState } from './lib/alerts';
import type { DigestEntry } from './lib/digest';
import type { Measurement } from './lib/miflora';
import { METRICS, type Metric, type Ranges } from './lib/status';

export interface SensorRow {
  mac: string;
  adopted: number;
  name: string | null;
  species: string | null;
  plant_pid: string | null;
  ranges_source: 'plantbook' | 'custom' | null;
  min_moisture: number | null;
  max_moisture: number | null;
  min_conductivity: number | null;
  max_conductivity: number | null;
  min_lux: number | null;
  max_lux: number | null;
  min_temperature: number | null;
  max_temperature: number | null;
  firmware: string | null;
  battery: number | null;
  battery_at: number | null;
  device_info_at: number | null;
  mode: 'passive' | 'active' | null;
  first_seen: number;
  last_seen: number | null;
  rssi: number | null;
  ble_name: string | null;
  last_error: string | null;
  last_error_at: number | null;
}

export interface ReadingRow extends Measurement {
  ts: number;
}

export interface SpeciesRow {
  pid: string;
  display_pid: string;
  data: string;
  fetched_at: number;
}

export type SensorUpdate = Partial<
  Pick<SensorRow, 'adopted' | 'name' | 'species' | 'plant_pid' | 'ranges_source'>
> & { ranges?: Ranges };

const MIGRATIONS = [
  `CREATE TABLE sensors (
     mac TEXT PRIMARY KEY,
     adopted INTEGER NOT NULL DEFAULT 0,
     name TEXT, species TEXT, plant_pid TEXT, ranges_source TEXT,
     min_moisture REAL, max_moisture REAL,
     min_conductivity REAL, max_conductivity REAL,
     min_lux REAL, max_lux REAL,
     min_temperature REAL, max_temperature REAL,
     firmware TEXT, battery INTEGER, battery_at INTEGER, device_info_at INTEGER,
     mode TEXT,
     first_seen INTEGER NOT NULL, last_seen INTEGER, rssi INTEGER, ble_name TEXT,
     last_error TEXT, last_error_at INTEGER
   );
   CREATE TABLE readings (
     id INTEGER PRIMARY KEY,
     mac TEXT NOT NULL,
     ts INTEGER NOT NULL,
     temperature REAL, moisture REAL, conductivity REAL, lux REAL,
     source TEXT NOT NULL
   );
   CREATE INDEX readings_mac_ts ON readings (mac, ts);
   CREATE TABLE species_cache (
     pid TEXT PRIMARY KEY, display_pid TEXT NOT NULL, data TEXT NOT NULL, fetched_at INTEGER NOT NULL
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE alert_state (
     mac TEXT NOT NULL, problem TEXT NOT NULL,
     since INTEGER NOT NULL, notified_at INTEGER, cleared_since INTEGER,
     PRIMARY KEY (mac, problem)
   );`,
  `CREATE TABLE digest_queue (
     id INTEGER PRIMARY KEY,
     mac TEXT NOT NULL, plant TEXT NOT NULL, problem TEXT NOT NULL, detail TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
];

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // Collector and web server are separate processes sharing this file.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close() {
    this.db.close();
  }

  // --- settings ---

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  getNumberSetting(key: string, fallback: number): number {
    const n = Number(this.getSetting(key));
    return this.getSetting(key) != null && Number.isFinite(n) ? n : fallback;
  }

  setSetting(key: string, value: string | number) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  // --- sensors ---

  getSensor(mac: string): SensorRow | undefined {
    return this.db.prepare('SELECT * FROM sensors WHERE mac = ?').get(mac) as SensorRow | undefined;
  }

  listSensors(adopted?: boolean): SensorRow[] {
    if (adopted == null) return this.db.prepare('SELECT * FROM sensors ORDER BY name, mac').all() as SensorRow[];
    return this.db
      .prepare('SELECT * FROM sensors WHERE adopted = ? ORDER BY name COLLATE NOCASE, mac')
      .all(adopted ? 1 : 0) as SensorRow[];
  }

  /** Record that a sensor was heard during a scan (creates unadopted rows for new sensors). */
  markSeen(mac: string, ts: number, rssi: number | null, bleName: string | null) {
    this.db
      .prepare(
        `INSERT INTO sensors (mac, first_seen, last_seen, rssi, ble_name) VALUES (@mac, @ts, @ts, @rssi, @bleName)
         ON CONFLICT(mac) DO UPDATE SET last_seen = @ts, rssi = @rssi, ble_name = COALESCE(@bleName, ble_name)`,
      )
      .run({ mac, ts, rssi, bleName });
  }

  updateSensor(mac: string, u: SensorUpdate) {
    const fields: Record<string, unknown> = {};
    for (const k of ['adopted', 'name', 'species', 'plant_pid', 'ranges_source'] as const) {
      if (k in u) fields[k] = u[k];
    }
    if (u.ranges) {
      for (const m of METRICS) {
        fields[`min_${m}`] = u.ranges[m]?.min ?? null;
        fields[`max_${m}`] = u.ranges[m]?.max ?? null;
      }
    }
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE sensors SET ${set} WHERE mac = @mac`).run({ ...fields, mac });
  }

  setDeviceInfo(mac: string, info: { battery?: number | null; firmware?: string | null }, ts: number) {
    if (info.firmware != null) {
      this.db.prepare('UPDATE sensors SET firmware = ?, device_info_at = ? WHERE mac = ?').run(info.firmware, ts, mac);
    }
    if (info.battery != null) {
      this.db.prepare('UPDATE sensors SET battery = ?, battery_at = ? WHERE mac = ?').run(info.battery, ts, mac);
    }
  }

  setMode(mac: string, mode: 'passive' | 'active') {
    this.db.prepare('UPDATE sensors SET mode = ? WHERE mac = ?').run(mode, mac);
  }

  setError(mac: string, error: string | null, ts: number) {
    this.db.prepare('UPDATE sensors SET last_error = ?, last_error_at = ? WHERE mac = ?').run(error, error ? ts : null, mac);
  }

  forgetSensor(mac: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM readings WHERE mac = ?').run(mac);
      this.db.prepare('DELETE FROM alert_state WHERE mac = ?').run(mac);
      this.db.prepare('DELETE FROM digest_queue WHERE mac = ?').run(mac);
      this.db.prepare('DELETE FROM sensors WHERE mac = ?').run(mac);
    })();
  }

  // --- readings ---

  insertReading(mac: string, ts: number, m: Partial<Measurement>, source: 'passive' | 'active' | 'demo') {
    this.db
      .prepare(
        `INSERT INTO readings (mac, ts, temperature, moisture, conductivity, lux, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(mac, ts, m.temperature ?? null, m.moisture ?? null, m.conductivity ?? null, m.lux ?? null, source);
  }

  /**
   * Latest value of each metric (readings may be partial when only some
   * advertisements were heard), looking back at most to `since`.
   */
  latestValues(mac: string, since: number): { values: Record<Metric, number | null>; at: number | null } {
    const rows = this.db
      .prepare('SELECT * FROM readings WHERE mac = ? AND ts >= ? ORDER BY ts DESC LIMIT 12')
      .all(mac, since) as ReadingRow[];
    const values = { moisture: null, conductivity: null, lux: null, temperature: null } as Record<Metric, number | null>;
    for (const r of rows) {
      for (const m of METRICS) if (values[m] == null && r[m] != null) values[m] = r[m];
    }
    return { values, at: rows[0]?.ts ?? null };
  }

  lastReadingAt(mac: string): number | null {
    const row = this.db.prepare('SELECT MAX(ts) AS ts FROM readings WHERE mac = ?').get(mac) as { ts: number | null };
    return row.ts;
  }

  maxLux(mac: string, since: number): number | null {
    const row = this.db.prepare('SELECT MAX(lux) AS v FROM readings WHERE mac = ? AND ts >= ?').get(mac, since) as {
      v: number | null;
    };
    return row.v;
  }

  /** History averaged into buckets of `bucketMs`. */
  history(mac: string, since: number, bucketMs: number): ReadingRow[] {
    return this.db
      .prepare(
        `SELECT CAST(ts / @b AS INTEGER) * @b AS ts,
                ROUND(AVG(temperature), 1) AS temperature, ROUND(AVG(moisture), 1) AS moisture,
                ROUND(AVG(conductivity)) AS conductivity, ROUND(MAX(lux)) AS lux
         FROM readings WHERE mac = @mac AND ts >= @since
         GROUP BY CAST(ts / @b AS INTEGER) ORDER BY 1`,
      )
      .all({ mac, since, b: Math.max(1, Math.round(bucketMs)) }) as ReadingRow[];
  }

  // --- species cache ---

  getSpecies(pid: string): SpeciesRow | undefined {
    return this.db.prepare('SELECT * FROM species_cache WHERE pid = ?').get(pid) as SpeciesRow | undefined;
  }

  putSpecies(pid: string, displayPid: string, data: unknown, ts: number) {
    this.db
      .prepare(
        `INSERT INTO species_cache (pid, display_pid, data, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(pid) DO UPDATE SET display_pid = excluded.display_pid, data = excluded.data, fetched_at = excluded.fetched_at`,
      )
      .run(pid, displayPid, JSON.stringify(data), ts);
  }

  // --- alerts ---

  alertStates(mac: string): AlertState[] {
    const rows = this.db.prepare('SELECT * FROM alert_state WHERE mac = ?').all(mac) as {
      mac: string;
      problem: AlertState['problem'];
      since: number;
      notified_at: number | null;
      cleared_since: number | null;
    }[];
    return rows.map((r) => ({
      mac: r.mac,
      problem: r.problem,
      since: r.since,
      notifiedAt: r.notified_at,
      clearedSince: r.cleared_since,
    }));
  }

  replaceAlertStates(mac: string, states: AlertState[]) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM alert_state WHERE mac = ?').run(mac);
      const ins = this.db.prepare(
        'INSERT INTO alert_state (mac, problem, since, notified_at, cleared_since) VALUES (?, ?, ?, ?, ?)',
      );
      for (const s of states) ins.run(mac, s.problem, s.since, s.notifiedAt, s.clearedSince);
    })();
  }

  // --- daily digest queue ---

  enqueueDigest(entries: Omit<DigestEntry, 'id'>[]) {
    const ins = this.db.prepare(
      'INSERT INTO digest_queue (mac, plant, problem, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const e of entries) ins.run(e.mac, e.plant, e.problem, e.detail, e.createdAt);
    })();
  }

  digestQueue(): DigestEntry[] {
    return this.db
      .prepare('SELECT id, mac, plant, problem, detail, created_at AS createdAt FROM digest_queue ORDER BY created_at, id')
      .all() as DigestEntry[];
  }

  deleteDigestEntries(ids: number[]) {
    const del = this.db.prepare('DELETE FROM digest_queue WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) del.run(id);
    })();
  }
}

export function rangesOf(s: SensorRow): Ranges {
  return {
    moisture: { min: s.min_moisture, max: s.max_moisture },
    conductivity: { min: s.min_conductivity, max: s.max_conductivity },
    lux: { min: s.min_lux, max: s.max_lux },
    temperature: { min: s.min_temperature, max: s.max_temperature },
  };
}

export const SETTINGS = {
  intervalMinutes: 'interval_minutes',
  alertAfterMinutes: 'alert_after_minutes',
  scanRequestedAt: 'scan_requested_at',
  collectorStatus: 'collector_status',
  digestLastDay: 'digest_last_day',
} as const;
