// Periodically evaluates plant status and sends notifications for problems
// that persist longer than the configured time. State lives in the DB, so
// restarts do not cause repeat alerts.

import { config } from '../config';
import { SETTINGS, type Store } from '../db';
import { planAlerts, type AlertState } from '../lib/alerts';
import { createLogger } from '../lib/log';
import type { Notification, Notifier } from '../lib/notifiers';
import { errorMessage } from '../lib/retry';
import { PROBLEM_LABELS, type Metric, type Problem } from '../lib/status';
import { buildPlantView, intervalMinutes, type PlantView } from '../plants';

const log = createLogger('alerts');

const UNITS: Record<Metric, string> = { moisture: '%', conductivity: ' µS/cm', lux: ' lx', temperature: ' °C' };
const PROBLEM_METRIC: Partial<Record<Problem, Metric>> = {
  needs_water: 'moisture',
  too_wet: 'moisture',
  needs_fertilizer: 'conductivity',
  too_much_fertilizer: 'conductivity',
  too_dark: 'lux',
  too_bright: 'lux',
  too_cold: 'temperature',
  too_hot: 'temperature',
};

export function alertAfterMinutes(store: Store): number {
  return store.getNumberSetting(SETTINGS.alertAfterMinutes, config.defaultAlertAfterMinutes);
}

function describe(p: PlantView, a: AlertState): string {
  const metric = PROBLEM_METRIC[a.problem];
  if (!metric) return `${PROBLEM_LABELS[a.problem]}: no readings since ${new Date(p.lastReadingAt ?? 0).toLocaleString()}`;
  const value = metric === 'lux' ? p.lightPeak24h : p.values[metric];
  const r = p.ranges[metric];
  const ideal = `${r.min ?? '–'}–${r.max ?? '–'}${UNITS[metric]}`;
  const what = metric === 'lux' ? 'brightest in 24 h' : 'now';
  return `${PROBLEM_LABELS[a.problem]}: ${value ?? '?'}${UNITS[metric]} ${what} (ideal ${ideal})`;
}

export class Alerter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly notifiers: Notifier[],
  ) {}

  start(everyMs = 5 * 60_000) {
    if (!this.notifiers.length) {
      log.info('no notifier configured (NTFY_URL / WEBHOOK_URL), alerts disabled');
      return;
    }
    log.info(`alerts enabled via ${this.notifiers.map((n) => n.name).join(', ')}`);
    setTimeout(() => void this.check(), 30_000);
    this.timer = setInterval(() => void this.check(), everyMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async send(n: Notification): Promise<string[]> {
    const errors: string[] = [];
    await Promise.all(
      this.notifiers.map((x) =>
        x.send(n).catch((err) => {
          errors.push(`${x.name}: ${errorMessage(err)}`);
        }),
      ),
    );
    for (const e of errors) log.error(`send failed: ${e}`);
    if (errors.length === this.notifiers.length && errors.length) throw new Error(errors.join('; '));
    return errors;
  }

  async check(now = Date.now()) {
    if (this.running || !this.notifiers.length) return;
    this.running = true;
    try {
      const holdMs = alertAfterMinutes(this.store) * 60_000;
      const interval = intervalMinutes(this.store);
      for (const s of this.store.listSensors(true)) {
        const view = buildPlantView(this.store, s, now, interval);
        const existing = this.store.alertStates(s.mac);
        let current = view.status.problems;
        // While offline we know nothing new, so keep the earlier problems open
        // instead of reporting them as resolved.
        if (current.includes('offline')) current = [...new Set([...existing.map((e) => e.problem), 'offline' as const])];

        const plan = planAlerts(s.mac, existing, current, now, holdMs);
        if (plan.notify.length) {
          try {
            await this.send({
              kind: 'problem',
              title: `🪴 ${view.name}: ${plan.notify.map((a) => PROBLEM_LABELS[a.problem]).join(', ')}`,
              message: plan.notify.map((a) => describe(view, a)).join('\n'),
              url: config.dashboardUrl || undefined,
            });
            log.info(`notified ${view.name}: ${plan.notify.map((a) => a.problem).join(', ')}`);
          } catch {
            // Nothing was delivered: leave them un-notified so the next check retries.
            for (const a of plan.notify) a.notifiedAt = null;
          }
        }
        if (plan.resolved.length && config.alertSendResolved) {
          await this.send({
            kind: 'resolved',
            title: `✅ ${view.name}: back to normal`,
            message: plan.resolved.map((a) => `${PROBLEM_LABELS[a.problem]} resolved`).join('\n'),
            url: config.dashboardUrl || undefined,
          }).catch(() => undefined);
        }
        this.store.replaceAlertStates(s.mac, plan.state);
      }
    } catch (err) {
      log.error(`alert check failed: ${errorMessage(err)}`);
    } finally {
      this.running = false;
    }
  }
}
