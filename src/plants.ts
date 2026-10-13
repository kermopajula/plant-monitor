// Builds the per-plant view used by the dashboard API and the alert loop.

import { config } from './config';
import { rangesOf, SETTINGS, type SensorRow, type Store } from './db';
import { describeFirmware, type FirmwareInfo } from './lib/firmware';
import { DEFAULT_RANGES, evaluateStatus, hasAnyRange, type Metric, type Ranges, type StatusResult } from './lib/status';

const HOUR = 3600_000;

export interface PlantView {
  mac: string;
  name: string;
  species: string | null;
  plantPid: string | null;
  imageUrl: string | null;
  values: Record<Metric, number | null>;
  lastReadingAt: number | null;
  lightPeak24h: number | null;
  ranges: Ranges;
  rangesSource: 'plantbook' | 'custom' | 'default';
  status: StatusResult;
  battery: number | null;
  batteryAt: number | null;
  firmware: FirmwareInfo;
  mode: SensorRow['mode'];
  lastSeen: number | null;
  rssi: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export function intervalMinutes(store: Store): number {
  return store.getNumberSetting(SETTINGS.intervalMinutes, config.defaultIntervalMinutes);
}

/** A plant is "offline" after missing about three reads (at least one hour). */
export function staleAfterMs(intervalMin: number): number {
  return Math.max(HOUR, 3 * intervalMin * 60_000 + config.scanSeconds * 1000);
}

export function buildPlantView(store: Store, s: SensorRow, now: number, intervalMin: number): PlantView {
  const stale = staleAfterMs(intervalMin);
  const latest = store.latestValues(s.mac, now - stale);
  const lastReadingAt = store.lastReadingAt(s.mac);
  const lightPeak24h = store.maxLux(s.mac, now - 24 * HOUR);
  const own = rangesOf(s);
  const custom = hasAnyRange(own);
  const ranges = custom ? own : DEFAULT_RANGES;
  let imageUrl: string | null = null;
  if (s.plant_pid) {
    const cached = store.getSpecies(s.plant_pid);
    if (cached) imageUrl = (JSON.parse(cached.data).image_url as string | undefined) ?? null;
  }
  return {
    mac: s.mac,
    name: s.name || s.mac,
    species: s.species,
    plantPid: s.plant_pid,
    imageUrl,
    values: latest.values,
    lastReadingAt,
    lightPeak24h,
    ranges,
    rangesSource: custom ? (s.ranges_source ?? 'custom') : 'default',
    status: evaluateStatus({
      values: latest.values,
      lightPeak24h,
      ranges,
      lastReadingAt,
      now,
      staleAfterMs: stale,
    }),
    battery: s.battery,
    batteryAt: s.battery_at,
    firmware: describeFirmware(s.firmware),
    mode: s.mode,
    lastSeen: s.last_seen,
    rssi: s.rssi,
    lastError: s.last_error,
    lastErrorAt: s.last_error_at,
  };
}
