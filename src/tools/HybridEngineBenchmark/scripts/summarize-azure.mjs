// Prints the tables for the production-like comparison from the files that azure\run-suite.ps1 saved, so the numbers in
// REPORT.md are read from data and not typed by hand.
//
//   node summarize-azure.mjs [results\azure directory] [--section all|latency|sweep|mixed|soak|metrics] [--run <suite=file>] [--instances]
//
// A suite file holds one report per LoadGen run: <suite>-<yyyyMMdd-HHmm>.json. When a suite was run more than once the
// newest file is used, unless --run names one, for example --run sweep=sweep-20261016-1130.json. Sites are the labels
// that the suites put in the report labels, such as node and jint. Metrics files come from azure\collect-metrics.ps1, and
// --instances adds every metric series to the metrics section.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const section = flag('--section') ?? 'all';
const runs = new Map(args.flatMap((value, index) => (args[index - 1] === '--run' ? [value.split('=')] : [])));
const valueFlags = ['--section', '--run'];
const root = resolve(args.find((value, index) => !value.startsWith('--') && !valueFlags.includes(args[index - 1]))
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'results', 'azure'));

const n = (value, digits = 0) => (value === undefined || value === null || !Number.isFinite(value) ? 'n/a' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN);
const percentile = (sorted, p) => {
  if (!sorted.length) return NaN;
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  return sorted[low] + (sorted[Math.ceil(rank)] - sorted[low]) * (rank - low);
};
const ratio = (top, bottom) => (Number.isFinite(top / bottom) && bottom !== 0 ? `${n(top / bottom, top / bottom < 10 ? 1 : 0)}x` : 'n/a');

function suiteFile(suite) {
  if (runs.has(suite)) return resolve(root, runs.get(suite));
  if (!existsSync(root)) return undefined;
  const names = readdirSync(root).filter((name) => new RegExp(`^${suite}-\\d{8}-\\d{4}\\.json$`).test(name)).sort();
  return names.length ? resolve(root, names.at(-1)) : undefined;
}

function reports(suite) {
  const file = suiteFile(suite);
  return file ? { file, items: JSON.parse(readFileSync(file, 'utf8')) } : undefined;
}

const siteOrder = (sites) => [...sites].sort((a, b) => (a === 'node' ? -1 : b === 'node' ? 1 : a === 'jint' ? -1 : b === 'jint' ? 1 : a.localeCompare(b)));
const table = (header, rows) => [`| ${header.join(' | ')} |`, `| ${header.map((_, index) => (index === 0 ? '---' : '---:')).join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');

function latency() {
  const found = reports('latency');
  if (!found) return '_No latency results._';
  const groups = new Map();
  for (const report of found.items) {
    const match = /^(rtt|static|html|md)-(.+)-r(\d+)$/.exec(report.label);
    if (!match) continue;
    const [, kind, site] = match;
    for (const entry of report.entries) {
      entry.milliseconds.forEach((ms, index) => {
        const cache = entry.cache?.[index] ?? '';
        const state = kind === 'html' || kind === 'md' ? (cache === 'HIT' ? 'hit' : cache === 'MISS' ? 'miss' : 'other') : 'all';
        const key = `${kind}|${site}|${state}`;
        if (!groups.has(key)) groups.set(key, { values: [], failed: 0 });
        const group = groups.get(key);
        if (entry.status >= 200 && entry.status < 400) group.values.push(ms); else group.failed++;
      });
    }
  }

  const sites = siteOrder(new Set([...groups.keys()].map((key) => key.split('|')[1])));
  const kinds = [['rtt', 'all', 'Health probe'], ['static', 'all', 'Static page'], ['html', 'miss', 'API page, cache miss'], ['html', 'hit', 'API page, cache hit'], ['md', 'miss', 'Markdown, cache miss'], ['md', 'hit', 'Markdown, cache hit']];
  const rows = [];
  for (const [kind, state, name] of kinds) {
    for (const site of sites) {
      const group = groups.get(`${kind}|${site}|${state}`);
      if (!group) continue;
      const sorted = [...group.values].sort((a, b) => a - b);
      rows.push([name, site, n(sorted.length), n(percentile(sorted, 0.5), 1), n(percentile(sorted, 0.95), 1), n(percentile(sorted, 0.99), 1), n(mean(sorted), 1), n(sorted.at(-1), 1), n(group.failed)]);
    }
  }

  return [`Source: ${found.file.split(/[\\/]/).at(-1)}`, '', table(['Request', 'Site', 'Requests', 'p50 ms', 'p95 ms', 'p99 ms', 'Mean ms', 'Max ms', 'Failed'], rows)].join('\n');
}

function loadByLabel(suite, pattern) {
  const found = reports(suite);
  if (!found) return undefined;
  const result = [];
  for (const report of found.items) {
    const match = pattern.exec(report.label);
    if (match) result.push({ ...report, parts: match.slice(1) });
  }
  return { file: found.file, items: result };
}

const hitRatio = (report) => {
  const total = (report.cacheHits ?? 0) + (report.cacheMisses ?? 0);
  return total ? `${n((report.cacheHits / total) * 100)}%` : 'n/a';
};

function matrix(items, rowOf, siteOf, rowNames, cell) {
  const sites = siteOrder(new Set(items.map(siteOf)));
  const rows = rowNames.map((name) => [name, ...sites.map((site) => {
    const report = items.find((item) => String(rowOf(item)) === String(name) && siteOf(item) === site);
    return report ? cell(report) : 'n/a';
  })]);
  return table(['', ...sites], rows);
}

function sweep() {
  const found = loadByLabel('sweep', /^sweep-(.+)-c(\d+)$/);
  if (!found) return '_No sweep results._';
  const rowNames = [...new Set(found.items.map((item) => Number(item.parts[1])))].sort((a, b) => a - b);
  const view = (title, cell) => `#### ${title}\n\n${matrix(found.items, (item) => item.parts[1], (item) => item.parts[0], rowNames, cell)}`;
  return [`Source: ${found.file.split(/[\\/]/).at(-1)}. Rows are connections.`, '',
    view('Requests per second', (report) => n(report.requestsPerSecond, 1)), '',
    view('p50 latency in ms', (report) => n(report.latency.p50, 0)), '',
    view('p99 latency in ms', (report) => n(report.latency.p99, 0)), '',
    view('Failed requests', (report) => n(report.errors)), '',
    view('Cache hit ratio', hitRatio)].join('\n');
}

function mixed() {
  const found = loadByLabel('mixed', /^(zipf|hot|md|static)-(.+)$/);
  if (!found) return '_No mixed results._';
  const rowNames = ['zipf', 'hot', 'md', 'static'].filter((name) => found.items.some((item) => item.parts[0] === name));
  const view = (title, cell) => `#### ${title}\n\n${matrix(found.items, (item) => item.parts[0], (item) => item.parts[1], rowNames, cell)}`;
  return [`Source: ${found.file.split(/[\\/]/).at(-1)}.`, '',
    view('Requests per second', (report) => n(report.requestsPerSecond, 1)), '',
    view('p50 latency in ms', (report) => n(report.latency.p50, 1)), '',
    view('p99 latency in ms', (report) => n(report.latency.p99, 0)), '',
    view('Failed requests', (report) => n(report.errors)), '',
    view('Cache hit ratio', hitRatio)].join('\n');
}

function soak() {
  const found = loadByLabel('soak', /^soak-(.+)$/);
  if (!found) return '_No soak results._';
  const sites = siteOrder(new Set(found.items.map((item) => item.parts[0])));
  const bySite = new Map(found.items.map((item) => [item.parts[0], item]));
  const windows = (timeline, size) => Array.from({ length: Math.floor(timeline.length / size) }, (_, index) => mean(timeline.slice(index * size, (index + 1) * size)));
  const rows = sites.map((site) => {
    const report = bySite.get(site);
    const timeline = report.requestsPerSecondTimeline ?? [];
    const third = Math.max(1, Math.floor(timeline.length / 3));
    return [site, n(report.seconds), n(report.requests), n(report.requestsPerSecond, 1), n(mean(timeline.slice(0, third)), 1), n(mean(timeline.slice(-third)), 1),
      n(Math.min(...windows(timeline, 10)), 1), n(report.latency.p50, 0), n(report.latency.p99, 0), n(report.latency.max, 0), n(report.errors), hitRatio(report)];
  });
  const size = 30;
  const longest = Math.max(...sites.map((site) => (bySite.get(site).requestsPerSecondTimeline ?? []).length));
  const offsets = Array.from({ length: Math.floor(longest / size) }, (_, index) => `${index * size}-${(index + 1) * size} s`);
  const perWindow = sites.map((site) => windows(bySite.get(site).requestsPerSecondTimeline ?? [], size));
  const timelineRows = offsets.map((name, index) => [name, ...perWindow.map((values) => n(values[index], 1))]);
  return [`Source: ${found.file.split(/[\\/]/).at(-1)}.`, '',
    table(['Site', 'Seconds', 'Requests', 'Requests/s', 'First third', 'Last third', 'Slowest 10 s', 'p50 ms', 'p99 ms', 'Max ms', 'Failed', 'Cache hit'], rows), '',
    '#### Requests per second in 30-second windows', '', table(['Window', ...sites], timelineRows)].join('\n');
}

const present = (value) => value !== null && value !== undefined;

// Azure Monitor labels each App Service minute about 85 seconds after the traffic that it counts. Fitting the per-second
// request timeline of the soak runs against the Requests series gives 86 seconds for the Node site and 85 for the Jint
// site. A minute labelled t therefore holds the traffic of t - lag up to t - lag + one grain, and a window reads the
// minutes whose traffic falls between the start and the end.
const metricLagSeconds = 85;
const wholeMinutes = (start, end, grainSeconds) => (time) => {
  const from = Date.parse(time) - metricLagSeconds * 1000;
  return from >= start && from + grainSeconds * 1000 <= end;
};

// Plan metrics have one series per instance. inWindow selects the minutes to read, and label is a site such as node, whose
// plan series are named node_plan. A plan series that reports for under half as many minutes as the longest one belongs to
// an instance that the platform added or removed during the window, and its few points would skew the means, so it is left
// out and counted in the result. CPU per request divides the CPU time of the kept instances (a P0v3 instance has one vCPU)
// by the requests that the site counted. The instance log, not the number of series, is the source for instance counts.
function metricRows(series, label, grainSeconds, inWindow = () => true) {
  const pick = (site, metric, aggregation) => series.filter((item) => item.site === site && item.metric === metric && item.aggregation === aggregation);
  const values = (items) => items.flatMap((item) => item.points.filter((point) => present(point.value) && inWindow(point.time)).map((point) => point.value));
  const peak = (items) => Math.max(...values(items));
  const total = (metric) => values(pick(label, metric, 'Total')).reduce((sum, value) => sum + value, 0);
  const mb = (bytes) => n(bytes / 1048576);
  const plan = `${label}_plan`;
  const minutes = new Map(pick(plan, 'CpuPercentage', 'Average').map((item) => [item.instance, values([item]).length]));
  const longest = Math.max(0, ...minutes.values());
  const kept = new Set([...minutes].filter(([, count]) => count * 2 >= longest).map(([instance]) => instance));
  const pickPlan = (metric, aggregation) => pick(plan, metric, aggregation).filter((item) => kept.has(item.instance));
  const cpu = pickPlan('CpuPercentage', 'Average');
  const cpuMilliseconds = values(cpu).reduce((sum, value) => sum + (value / 100) * grainSeconds * 1000, 0);
  // The response time of a minute counts as many times as the minute has requests, so idle minutes do not dilute the mean.
  const requestsAt = new Map(pick(label, 'Requests', 'Total').flatMap((item) => item.points.filter((point) => present(point.value) && inWindow(point.time)).map((point) => [point.time, point.value])));
  const timed = pick(label, 'HttpResponseTime', 'Average').flatMap((item) => item.points.filter((point) => present(point.value) && requestsAt.has(point.time)));
  const responseMilliseconds = (timed.reduce((sum, point) => sum + point.value * requestsAt.get(point.time), 0) / timed.reduce((sum, point) => sum + requestsAt.get(point.time), 0)) * 1000;
  return {
    left: minutes.size - kept.size,
    plan: [label, n(mean(values(cpu))), n(peak(pickPlan('CpuPercentage', 'Maximum'))),
      n(mean(values(pickPlan('MemoryPercentage', 'Average')))), n(peak(pickPlan('MemoryPercentage', 'Maximum'))), n(cpuMilliseconds / total('Requests'))],
    site: [label, n(total('Requests')), n(total('Http4xx')), n(total('Http5xx')), n(responseMilliseconds),
      mb(mean(values(pick(label, 'AverageMemoryWorkingSet', 'Average')))), mb(peak(pick(label, 'MemoryWorkingSet', 'Maximum')))],
  };
}

// A suite alternates the sites inside every minute, so the CPU mean of a whole-suite window mixes busy and idle seconds and
// is left out there. The soak runs one site alone for whole minutes, so its table keeps the CPU mean.
const planHeader = (cpuMean) => ['Site', ...(cpuMean ? ['CPU mean %'] : []), 'CPU peak %', 'Memory mean %', 'Memory peak %', 'CPU ms per request'];
const planRow = (row, cpuMean) => (cpuMean ? row.plan : row.plan.filter((_, index) => index !== 1));
const siteHeader = ['Site', 'Requests', '4xx', '5xx', 'Response ms', 'Working set mean MB', 'Working set peak MB'];

// The suite run that a metrics file covers: the #start and #end lines of the suite log that falls inside the file's window.
function suiteWindow(metricsFile) {
  const from = Date.parse(metricsFile.start);
  const to = Date.parse(metricsFile.end);
  for (const name of readdirSync(root).filter((entry) => /^[a-z]+-\d{8}-\d{4}\.log$/.test(entry))) {
    const text = readFileSync(resolve(root, name), 'utf8');
    const start = Date.parse(/^#start (\S+)/m.exec(text)?.[1]);
    const end = Date.parse(/^#end (\S+)/m.exec(text)?.[1]);
    if (start >= from && end <= to) return { start, end };
  }
  return undefined;
}

// A suite runs the sites one after the other, so the whole-suite tables mix a site under load with the same site idle.
// They read only the whole minutes of traffic between #start and #end, allowing for the metric lag. The soak runs one site
// at a time for minutes, so its second table reads only the whole minutes of traffic of each run.
function metrics() {
  if (!existsSync(root)) return '_No metrics._';
  const names = readdirSync(root).filter((name) => /^metrics-.+\.json$/.test(name)).sort();
  if (!names.length) return '_No metrics._';
  const out = [];
  for (const name of names) {
    const file = JSON.parse(readFileSync(resolve(root, name), 'utf8'));
    const series = file.series ?? [];
    const grain = /^PT(\d+)M$/.exec(file.interval ?? '');
    const grainSeconds = grain ? Number(grain[1]) * 60 : 60;
    const suite = suiteWindow(file);
    const inSuite = suite ? wholeMinutes(suite.start, suite.end, grainSeconds) : undefined;
    const labels = siteOrder(new Set(series.map((item) => item.site.replace(/_plan$/, ''))));
    const rows = labels.map((label) => metricRows(series, label, grainSeconds, inSuite));
    const leftOut = rows.map((row, index) => (row.left ? `${labels[index]} ${row.left}` : '')).filter(Boolean);
    out.push(`Source: ${name}. Window ${file.start} to ${file.end}, ${file.interval} grain${suite ? `, whole minutes of traffic from ${new Date(suite.start).toISOString()} to ${new Date(suite.end).toISOString()}, labelled ${metricLagSeconds} seconds later` : ''}.`, '',
      '#### Plans', '', table(planHeader(false), rows.map((row) => planRow(row, false))), '',
      ...(leftOut.length ? [`Plan series left out for reporting under half of the minutes: ${leftOut.join(', ')}.`, ''] : []),
      '#### Sites', '', table(siteHeader, rows.map((row) => row.site)), '');

    const soakReports = name === 'metrics-soak.json' ? reports('soak') : undefined;
    if (soakReports) {
      const perRun = soakReports.items.map((report) => {
        const start = Date.parse(report.startedUtc);
        const end = start + report.seconds * 1000;
        const row = metricRows(series, report.label.replace(/^soak-/, ''), grainSeconds, wholeMinutes(start, end, grainSeconds));
        return [...planRow(row, true), ...row.site.slice(1)];
      });
      out.push('#### Whole minutes of each soak run', '', table([...planHeader(true), ...siteHeader.slice(1)], perRun), '');
    }

    if (args.includes('--instances')) {
      const instanceRows = series.flatMap((item) => {
        const values = item.points.map((point) => point.value).filter(present);
        return values.length ? [[item.site, item.instance ?? '', item.metric, item.aggregation, n(Math.max(...values), 1), n(mean(values), 1), n(values.length)]] : [];
      });
      out.push('#### Every series', '', table(['Site', 'Instance', 'Metric', 'Aggregation', 'Peak', 'Mean', 'Samples'], instanceRows), '');
    }
  }
  return out.join('\n');
}

const sections = { latency, sweep, mixed, soak, metrics };
for (const [name, render] of Object.entries(sections)) {
  if (section !== 'all' && section !== name) continue;
  console.log(`### ${name}\n\n${render()}\n`);
}
