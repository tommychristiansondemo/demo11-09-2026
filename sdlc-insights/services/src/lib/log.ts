// Minimal structured JSON logger + CloudWatch Embedded Metric Format (EMF).
// NEVER pass prompts, application descriptions or generated reports to this logger.

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export const METRIC_NAMESPACE = 'SdlcClassInsights';

export function createLogger(base: Record<string, unknown>) {
  const write = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    const line = { ts: new Date().toISOString(), level, msg, service: process.env.SERVICE_NAME ?? 'sdlc-insights', ...base, ...fields };
    const out = JSON.stringify(line);
    if (level === 'ERROR') console.error(out);
    else if (level === 'WARN') console.warn(out);
    else console.log(out);
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => { if (process.env.LOG_LEVEL === 'DEBUG') write('DEBUG', m, f); },
    info: (m: string, f?: Record<string, unknown>) => write('INFO', m, f),
    warn: (m: string, f?: Record<string, unknown>) => write('WARN', m, f),
    error: (m: string, f?: Record<string, unknown>) => write('ERROR', m, f),
    metric: (metrics: Record<string, number>, unit: Record<string, string> = {}, dims: Record<string, string> = {}) => {
      const dimKeys = Object.keys(dims);
      console.log(JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{
            Namespace: METRIC_NAMESPACE,
            Dimensions: [dimKeys],
            Metrics: Object.keys(metrics).map((name) => ({ Name: name, Unit: unit[name] ?? 'Count' })),
          }],
        },
        ...dims,
        ...metrics,
        ...base,
      }));
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

const CORRELATION_RE = /^[A-Za-z0-9-]{8,64}$/;
export function correlationIdFrom(headerValue: string | undefined, fallback: string): string {
  return headerValue && CORRELATION_RE.test(headerValue) ? headerValue : fallback;
}
