import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, GetMetricDataCommand, DescribeAlarmsCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { CloudFormationClient, ListStackResourcesCommand, DescribeStacksCommand, DescribeStackEventsCommand, type StackResourceSummary } from '@aws-sdk/client-cloudformation';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { sanitizeDeep, sanitizeText } from './sanitize';

// ---- Configuration (allow-lists come from environment, set by CDK) ----
export interface ToolConfig {
  logGroups: Record<string, string>;       // source id -> log group name
  stacks: { name: string; region: string; app: string }[];
  knowledgeBucket: string;
  knowledgeKey: string;
  alarmPrefixes: string[];
  functions: Record<string, string>;       // friendly -> Lambda function name
  apis: Record<string, string>;            // friendly -> API Gateway name
}
export const loadConfig = (): ToolConfig => JSON.parse(process.env.TOOL_CONFIG ?? '{}');

const logs = new CloudWatchLogsClient({});
const cw = new CloudWatchClient({});
const s3 = new S3Client({});
const cfn: Record<string, CloudFormationClient> = {};
const cfnFor = (region: string) => (cfn[region] ??= new CloudFormationClient({ region }));

// FilterLogEvents may return empty or partial pages with a nextToken, so follow a bounded number of pages.
async function filterAll(input: { logGroupName: string; startTime: number; filterPattern?: string }, maxEvents: number, maxPages = 15) {
  const events: { timestamp?: number; message?: string }[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await logs.send(new FilterLogEventsCommand({ ...input, nextToken, limit: 500 }));
    events.push(...(r.events ?? []));
    nextToken = r.nextToken;
    if (!nextToken || events.length >= maxEvents) break;
  }
  return events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : dflt;
};

// ---- Knowledge document ----
let cache: { at: number; text: string; lastModified?: string; versionId?: string } | null = null;
export async function getKnowledge(cfg: ToolConfig, maxAgeMs = 60_000) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache;
  const o = await s3.send(new GetObjectCommand({ Bucket: cfg.knowledgeBucket, Key: cfg.knowledgeKey }));
  const text = (await o.Body?.transformToString('utf-8')) ?? '';
  cache = { at: Date.now(), text, lastModified: o.LastModified?.toISOString(), versionId: o.VersionId };
  return cache;
}

// ---- Logs ----
export async function queryLogs(cfg: ToolConfig, args: { source?: string; minutes?: number; filter?: string; limit?: number }) {
  const group = args.source ? cfg.logGroups[args.source] : undefined;
  if (!group) return { error: `Unknown source. Valid sources: ${Object.keys(cfg.logGroups).join(', ')}` };
  const minutes = clamp(args.minutes, 1, 7 * 24 * 60, 60);
  const limit = clamp(args.limit, 1, 50, 20);
  // Only simple term filters (letters, digits, space, - _ . :) are accepted, to avoid filter-pattern injection.
  const filter = typeof args.filter === 'string' && /^[\w .:-]{1,60}$/.test(args.filter) ? `"${args.filter}"` : undefined;
  const found = await filterAll({ logGroupName: group, startTime: Date.now() - minutes * 60_000, filterPattern: filter }, 1000);
  const events = found.slice(-limit).reverse().map((e) => ({
    time: new Date(e.timestamp ?? 0).toISOString(),
    message: sanitizeText((e.message ?? '').trim(), 1500),
  }));
  return { source: args.source, logGroup: group, minutes, returned: events.length, events };
}

export async function reasoningLogs(cfg: ToolConfig, args: { app?: string; hours?: number; limit?: number }) {
  const app = args.app === 'insights' ? 'insights' : args.app === 'advisor' ? 'advisor' : 'all';
  const hours = clamp(args.hours, 1, 7 * 24, 24);
  const limit = clamp(args.limit, 1, 25, 10);
  const groups = Object.entries(cfg.logGroups)
    .filter(([k]) => (k === 'advisor-worker' && app !== 'insights') || (k === 'insights-chat' && app !== 'advisor'))
    .map(([, g]) => g);
  const all: Record<string, unknown>[] = [];
  for (const g of groups) {
    const found = await filterAll({ logGroupName: g, startTime: Date.now() - hours * 3_600_000, filterPattern: '"llm_reasoning"' }, 200);
    for (const e of found) {
      // Lambda's text log format prefixes each line with "timestamp<TAB>requestId<TAB>LEVEL<TAB>", so parse from the first "{".
      const msg = e.message ?? '';
      try { const rec = JSON.parse(msg.slice(msg.indexOf('{'))); if (rec.type === 'llm_reasoning') all.push(rec); } catch { /* skip */ }
    }
  }
  all.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { app, hours, returned: Math.min(limit, all.length), totalFound: all.length, records: sanitizeDeep(all.slice(0, limit), 6000) };
}

// ---- CloudFormation inventory ----
async function listAll(stack: string, region: string) {
  const out: StackResourceSummary[] = [];
  let token: string | undefined;
  do {
    const r = await cfnFor(region).send(new ListStackResourcesCommand({ StackName: stack, NextToken: token }));
    out.push(...(r.StackResourceSummaries ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

export async function inventory(cfg: ToolConfig, args: { stack?: string; detail?: boolean } = {}) {
  const stacks = cfg.stacks.filter((s) => !args.stack || s.name === args.stack);
  const result = [];
  const typeTotals: Record<string, number> = {};
  for (const s of stacks) {
    try {
      const [res, desc] = await Promise.all([listAll(s.name, s.region), cfnFor(s.region).send(new DescribeStacksCommand({ StackName: s.name }))]);
      const byType: Record<string, number> = {};
      for (const r of res) {
        byType[r.ResourceType!] = (byType[r.ResourceType!] ?? 0) + 1;
        typeTotals[r.ResourceType!] = (typeTotals[r.ResourceType!] ?? 0) + 1;
      }
      const st = desc.Stacks?.[0];
      result.push({
        stack: s.name, app: s.app, region: s.region, status: st?.StackStatus, lastUpdated: (st?.LastUpdatedTime ?? st?.CreationTime)?.toISOString(),
        resourceCount: res.length, resourceTypes: Object.keys(byType).length, byType,
        resources: args.detail ? res.map((r) => ({ logicalId: r.LogicalResourceId, type: r.ResourceType, status: r.ResourceStatus })) : undefined,
      });
    } catch (e) {
      result.push({ stack: s.name, app: s.app, region: s.region, status: 'NOT_FOUND', error: (e as Error).name });
    }
  }
  const services = new Set(Object.keys(typeTotals).map((t) => t.split('::')[1]));
  return {
    stacks: result,
    totals: {
      resources: Object.values(typeTotals).reduce((a, b) => a + b, 0),
      distinctResourceTypes: Object.keys(typeTotals).length,
      distinctServices: services.size,
      services: [...services].sort(),
      byType: Object.fromEntries(Object.entries(typeTotals).sort((a, b) => b[1] - a[1])),
    },
  };
}

export async function stackEvents(cfg: ToolConfig, args: { stack?: string; limit?: number }) {
  const s = cfg.stacks.find((x) => x.name === args.stack) ?? cfg.stacks[0];
  const limit = clamp(args.limit, 1, 50, 20);
  const r = await cfnFor(s.region).send(new DescribeStackEventsCommand({ StackName: s.name }));
  return {
    stack: s.name,
    events: (r.StackEvents ?? []).slice(0, limit).map((e) => ({
      time: e.Timestamp?.toISOString(), logicalId: e.LogicalResourceId, type: e.ResourceType, status: e.ResourceStatus,
      reason: e.ResourceStatusReason ? sanitizeText(e.ResourceStatusReason, 400) : undefined,
    })),
  };
}

// ---- Metrics & alarms ----
const METRICS: Record<string, { label: string; build: (cfg: ToolConfig) => MetricDataQuery['MetricStat'] | undefined; stat?: string }> = {
  assessments_requested: { label: 'Advisor assessments requested', build: () => ({ Metric: { Namespace: 'SecureSdlcAdvisor', MetricName: 'AssessmentsRequested' }, Period: 3600, Stat: 'Sum' }) },
  assessments_completed: { label: 'Advisor assessments completed', build: () => ({ Metric: { Namespace: 'SecureSdlcAdvisor', MetricName: 'AssessmentsCompleted' }, Period: 3600, Stat: 'Sum' }) },
  assessments_failed: { label: 'Advisor assessments failed', build: () => ({ Metric: { Namespace: 'SecureSdlcAdvisor', MetricName: 'AssessmentsFailed' }, Period: 3600, Stat: 'Sum' }) },
  guardrail_blocks: { label: 'Advisor guardrail blocks', build: () => ({ Metric: { Namespace: 'SecureSdlcAdvisor', MetricName: 'GuardrailBlocks' }, Period: 3600, Stat: 'Sum' }) },
  advisor_input_tokens: { label: 'Advisor Bedrock input tokens', build: () => ({ Metric: { Namespace: 'SecureSdlcAdvisor', MetricName: 'InputTokens' }, Period: 3600, Stat: 'Sum' }) },
  advisor_output_tokens: { label: 'Advisor Bedrock output tokens', build: () => ({ Metric: { Namespace: 'SecureSdlcAdvisor', MetricName: 'OutputTokens' }, Period: 3600, Stat: 'Sum' }) },
  assessment_duration_avg_ms: { label: 'Advisor assessment duration (avg ms)', build: () => ({ Metric: { Namespace: 'SecureSdlcAdvisor', MetricName: 'AssessmentDurationMs' }, Period: 3600, Stat: 'Average' }) },
  chat_questions: { label: 'Insights chat questions', build: () => ({ Metric: { Namespace: 'SdlcClassInsights', MetricName: 'ChatQuestions' }, Period: 3600, Stat: 'Sum' }) },
  chat_input_tokens: { label: 'Insights chat input tokens', build: () => ({ Metric: { Namespace: 'SdlcClassInsights', MetricName: 'InputTokens' }, Period: 3600, Stat: 'Sum' }) },
  chat_output_tokens: { label: 'Insights chat output tokens', build: () => ({ Metric: { Namespace: 'SdlcClassInsights', MetricName: 'OutputTokens' }, Period: 3600, Stat: 'Sum' }) },
  advisor_api_requests: { label: 'Advisor API requests', build: (c) => ({ Metric: { Namespace: 'AWS/ApiGateway', MetricName: 'Count', Dimensions: [{ Name: 'ApiName', Value: c.apis.advisor }] }, Period: 3600, Stat: 'Sum' }) },
  advisor_api_5xx: { label: 'Advisor API 5xx errors', build: (c) => ({ Metric: { Namespace: 'AWS/ApiGateway', MetricName: '5XXError', Dimensions: [{ Name: 'ApiName', Value: c.apis.advisor }] }, Period: 3600, Stat: 'Sum' }) },
  insights_api_requests: { label: 'Insights API requests', build: (c) => ({ Metric: { Namespace: 'AWS/ApiGateway', MetricName: 'Count', Dimensions: [{ Name: 'ApiName', Value: c.apis.insights }] }, Period: 3600, Stat: 'Sum' }) },
  worker_invocations: { label: 'Advisor worker Lambda invocations', build: (c) => ({ Metric: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: c.functions['advisor-worker'] }] }, Period: 3600, Stat: 'Sum' }) },
  worker_errors: { label: 'Advisor worker Lambda errors', build: (c) => ({ Metric: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: c.functions['advisor-worker'] }] }, Period: 3600, Stat: 'Sum' }) },
};
export const METRIC_NAMES = Object.keys(METRICS);

export async function metrics(cfg: ToolConfig, args: { names?: string[]; hours?: number }) {
  const hours = clamp(args.hours, 1, 14 * 24, 24);
  const names = (args.names?.length ? args.names : METRIC_NAMES).filter((n) => METRICS[n]).slice(0, 20);
  const queries: MetricDataQuery[] = names.map((n, i) => ({ Id: `m${i}`, Label: n, MetricStat: METRICS[n].build(cfg), ReturnData: true }));
  if (!queries.length) return { error: `Unknown metric. Valid: ${METRIC_NAMES.join(', ')}` };
  const r = await cw.send(new GetMetricDataCommand({ StartTime: new Date(Date.now() - hours * 3_600_000), EndTime: new Date(), MetricDataQueries: queries }));
  return {
    hours,
    metrics: (r.MetricDataResults ?? []).map((m) => {
      const name = m.Label!;
      const vals = m.Values ?? [];
      const avg = METRICS[name].build(cfg)?.Stat === 'Average';
      const total = vals.reduce((a, b) => a + b, 0);
      return {
        name, label: METRICS[name].label,
        value: avg ? (vals.length ? Math.round(total / vals.length) : 0) : Math.round(total),
        hourly: (m.Timestamps ?? []).map((t, i) => ({ hour: t.toISOString(), value: Math.round(vals[i]) })).reverse(),
      };
    }),
  };
}

export async function alarms(cfg: ToolConfig) {
  const out = [];
  for (const prefix of cfg.alarmPrefixes) {
    const r = await cw.send(new DescribeAlarmsCommand({ AlarmNamePrefix: prefix, MaxRecords: 50 }));
    for (const a of r.MetricAlarms ?? []) out.push({ name: a.AlarmName, state: a.StateValue, metric: a.MetricName, threshold: a.Threshold, updated: a.StateUpdatedTimestamp?.toISOString() });
  }
  return { alarms: out };
}
