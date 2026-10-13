import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTimeOfDay } from './lib/digest';

/** Project root (this file compiles to dist/src/config.js). */
export const ROOT = resolve(__dirname, '..', '..');

const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

const str = (name: string, fallback = '') => process.env[name]?.trim() || fallback;

export const config = {
  dbPath: resolve(ROOT, str('DB_PATH', 'data/plants.db')),

  // Web
  host: str('HOST', '0.0.0.0'),
  port: num('PORT', 3000),

  // Collector
  /** Default read interval; can be changed on the setup page (stored in the DB). */
  defaultIntervalMinutes: num('READ_INTERVAL_MINUTES', 20),
  scanSeconds: num('SCAN_SECONDS', 90),
  connectTimeoutMs: num('CONNECT_TIMEOUT_MS', 15000),
  gattTimeoutMs: num('GATT_TIMEOUT_MS', 10000),
  pollAttempts: num('POLL_ATTEMPTS', 3),
  batteryReadHours: num('BATTERY_READ_HOURS', 24),

  // Open Plant Book
  plantbookApiKey: str('PLANTBOOK_API_KEY'),
  plantbookBaseUrl: str('PLANTBOOK_BASE_URL', 'https://open.plantbook.io/api/v1'),

  // Alerts
  defaultAlertAfterMinutes: num('ALERT_AFTER_MINUTES', 120),
  alertSendResolved: /^(1|true|yes)$/i.test(str('ALERT_SEND_RESOLVED')),
  ntfyUrl: str('NTFY_URL'),
  ntfyToken: str('NTFY_TOKEN'),
  webhookUrl: str('WEBHOOK_URL'),
  resendApiKey: str('RESEND_API_KEY'),
  resendFrom: str('RESEND_FROM'),
  /** Comma-separated recipients. */
  resendTo: str('RESEND_TO'),
  /** Local time (HH:MM) of the daily email digest. */
  resendDigestTime: parseTimeOfDay(str('RESEND_DIGEST_TIME', '08:00')),
  dashboardUrl: str('DASHBOARD_URL'),
};

export type Config = typeof config;
