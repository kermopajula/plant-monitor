// Minimal logger; PM2 adds timestamps (see `time: true` in ecosystem.config.js).
const debugEnabled = /^(1|true|yes)$/i.test(process.env.DEBUG_LOG ?? '');

export function createLogger(scope: string) {
  const fmt = (args: unknown[]) => [`[${scope}]`, ...args];
  return {
    info: (...args: unknown[]) => console.log(...fmt(args)),
    warn: (...args: unknown[]) => console.warn(...fmt(args)),
    error: (...args: unknown[]) => console.error(...fmt(args)),
    debug: (...args: unknown[]) => {
      if (debugEnabled) console.log(...fmt(args));
    },
  };
}
