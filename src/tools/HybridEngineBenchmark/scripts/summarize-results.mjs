// Prints the report tables from the result files, so the numbers in REPORT.md are read from data and not typed by hand.
//
//   node summarize-results.mjs [results dir] [--section all|cold|first-hits|sequence|load|variance|tuning|growth|profile] [--paths <dir>]
//
// The results directory holds one folder per measured bundle (node-plain, node-as-deployed, jint-plain), the repeat
// folders (rep2-*, rep3-*), the tuning folders (tune-*) and soak/ with the soak and growth runs. With --paths (the folder
// that make-paths.mjs wrote) the growth tables also show how many distinct pages the random requests are expected to have reached.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const sectionIndex = args.indexOf('--section');
const section = sectionIndex >= 0 ? args[sectionIndex + 1] : 'all';
const pathsIndex = args.indexOf('--paths');
const pathsDir = pathsIndex >= 0 ? resolve(args[pathsIndex + 1]) : undefined;
const root = resolve(args.find((value, index) => !value.startsWith('--') && !['--section', '--paths'].includes(args[index - 1])) ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'results'));

const bundles = [['node-plain', 'Node plain'], ['node-as-deployed', 'Node as deployed'], ['jint-plain', 'Jint plain']];
const kinds = ['csharp-package', 'csharp-type', 'csharp-memberkind', 'ts-module', 'ts-item', 'ts-member', 'csharp-md', 'ts-md'];
// The order in which bundle-bench.mjs requests the route kinds on a fresh process; csharp-type is the first page.
const coldOrder = ['csharp-type', 'ts-module', 'ts-item', 'ts-member', 'csharp-package', 'csharp-memberkind', 'csharp-md', 'ts-md'];
// Requests in one pass over the crawl-all mix: 24,205 HTML pages plus 24,242 .md endpoints.
const crawlPass = 48447;

const read = (...parts) => { const file = resolve(root, ...parts); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; };
const n = (value, digits = 0) => (value === undefined || !Number.isFinite(value) ? 'n/a' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const span = (values, digits = 0) => { const low = Math.min(...values); const high = Math.max(...values); return low === high ? n(low, digits) : `${n(low, digits)}-${n(high, digits)}`; };
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const ratio = (top, bottom) => (Number.isFinite(top / bottom) ? `${n(top / bottom, top / bottom < 10 ? 1 : 0)}x` : 'n/a');
const lastThird = (timeline) => (timeline?.length ? mean(timeline.slice(-Math.floor(timeline.length / 3))) : undefined);

// Least-squares slope of the live set in MB per 1,000 requests over the in-load readings with from <= requests < to,
// and its standard error. Needs at least three readings.
function liveSlope(timeline, from, to = Infinity) {
  const points = (timeline ?? []).filter((point) => point.requests >= from && point.requests < to);
  if (points.length < 3) return undefined;
  const meanX = mean(points.map((point) => point.requests));
  const meanY = mean(points.map((point) => point.liveMb));
  const sxx = points.reduce((sum, point) => sum + (point.requests - meanX) ** 2, 0);
  const slope = points.reduce((sum, point) => sum + (point.requests - meanX) * (point.liveMb - meanY), 0) / sxx;
  const sse = points.reduce((sum, point) => sum + (point.liveMb - meanY - slope * (point.requests - meanX)) ** 2, 0);
  return { perThousand: slope * 1000, standardError: Math.sqrt(sse / (points.length - 2) / sxx) * 1000, scatter: Math.sqrt(sse / (points.length - 2)), samples: points.length };
}

// Distinct pages that `count` random requests are expected to reach. A path listed m times in the mix file is m times as
// likely, so a page is reached with probability 1 - exp(-count * m / lines).
const mixCache = new Map();
function expectedDistinct(mix, count) {
  if (!pathsDir) return undefined;
  if (!mixCache.has(mix)) {
    const file = resolve(pathsDir, `${mix}.txt`);
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    const listed = new Map();
    for (const line of lines) listed.set(line, (listed.get(line) ?? 0) + 1);
    mixCache.set(mix, { lines: lines.length, listed });
  }
  const { lines, listed } = mixCache.get(mix);
  if (!lines) return undefined;
  let total = 0;
  for (const times of listed.values()) total += 1 - Math.exp(-count * times / lines);
  return total;
}

function table(head, rows) {
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map((_, index) => (index === 0 ? '---' : '---:')).join('|')}|`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
  console.log();
}
const heading = (text) => console.log(`#### ${text}\n`);
const loadEntry = (dir, name) => read(dir, 'summary.json')?.load?.find((entry) => entry.name === name);
const configNames = (dir) => read(dir, 'summary.json')?.load?.map((entry) => entry.name) ?? [];

const sections = {
  cold() {
    heading('Cold start, three fresh processes each (minimum to maximum)');
    const rows = [];
    for (const [id, label] of bundles) {
      const runs = read(id, 'summary.json')?.cold;
      if (!runs) continue;
      const pick = (get, digits) => span(runs.map(get), digits);
      rows.push([label, pick((run) => run.readyMs), pick((run) => run.atReady.cpuSeconds, 1), pick((run) => run.atReady.rssMb), pick((run) => run.timeToFirstPageMs),
        pick((run) => run.allFirstHitsMs), pick((run) => run.afterFirstHits.cpuSeconds, 1), pick((run) => run.afterFirstHits.rssMb)]);
    }
    table(['Bundle', 'Ready (ms)', 'CPU s at ready', 'RSS MB at ready', 'First page (ms)', 'All 8 route kinds (ms)', 'CPU s after', 'RSS MB after'], rows);
  },

  'first-hits'() {
    heading('First request to each route kind on a fresh process, in request order (ms, minimum to maximum)');
    const rows = coldOrder.map((kind) => [kind, ...bundles.map(([id]) => { const runs = read(id, 'summary.json')?.cold; return runs ? span(runs.map((run) => run.firstHits[kind].ms), 1) : 'n/a'; })]);
    table(['Route kind', ...bundles.map(([, label]) => label)], rows);
  },

  sequence() {
    heading('Latency of repeat requests on one connection, cache bypassed (median ms)');
    const find = (id, kind) => read(id, 'summary.json')?.sequence?.find((entry) => entry.kind === kind);
    table(['Route kind', 'Node plain', 'Node plain, cached', 'Node as deployed', 'Node as deployed, cached', 'Jint plain', 'Jint / Node plain'], kinds.map((kind) => {
      const [plain, deployed, jint] = bundles.map(([id]) => find(id, kind));
      return [kind, n(plain?.bypass.repeatMedianMs, 2), n(plain?.cached?.repeatMedianMs, 2), n(deployed?.bypass.repeatMedianMs, 2), n(deployed?.cached?.repeatMedianMs, 2),
        n(jint?.bypass.repeatMedianMs, 2), ratio(jint?.bypass.repeatMedianMs, plain?.bypass.repeatMedianMs)];
    }));
  },

  load() {
    const names = [...new Set(bundles.flatMap(([id]) => configNames(id)))];
    const cell = (id, name, get) => { const entry = loadEntry(id, name); return entry ? get(entry) : '-'; };
    heading('Throughput and CPU per request (one run each)');
    table(['Configuration', 'Node plain rps', 'Node as deployed rps', 'Jint plain rps', 'Node plain / Jint', 'Node plain ms CPU/request', 'Node as deployed ms CPU/request', 'Jint plain ms CPU/request'],
      names.map((name) => [name, ...bundles.map(([id]) => cell(id, name, (entry) => n(entry.rps, 1))), ratio(loadEntry('node-plain', name)?.rps, loadEntry('jint-plain', name)?.rps),
        ...bundles.map(([id]) => cell(id, name, (entry) => n(entry.cpuMsPerRequest, 2)))]));
    heading('Latency under load (ms)');
    table(['Configuration', 'Bundle', 'Requests', 'Cores', 'p50', 'p90', 'p99', 'p99.9', 'Errors'], names.flatMap((name) => bundles.flatMap(([id, label]) => {
      const entry = loadEntry(id, name);
      return entry ? [[name, label, n(entry.requests), n(entry.serverCores, 2), n(entry.latencyMs.p50), n(entry.latencyMs.p90), n(entry.latencyMs.p99), n(entry.latencyMs.p999), n(entry.errors)]] : [];
    })));
    heading('Server memory during the load (MB)');
    table(['Configuration', 'Node plain, start to end (peak)', 'Node as deployed, start to end (peak)', 'Jint plain, start to end (peak)'],
      names.map((name) => [name, ...bundles.map(([id]) => cell(id, name, (entry) => `${n(entry.rssStartMb)} to ${n(entry.rssEndMb)} (${n(entry.rssPeakMb)})`))]));
    heading('Jint garbage collection during the load');
    table(['Configuration', 'GC pause % of wall time', 'All GCs', 'Gen1 and above', 'Gen2', 'Allocated MB per request'], names.flatMap((name) => {
      const entry = loadEntry('jint-plain', name);
      return entry?.gc ? [[name, n(entry.gc.pausePercent, 1), n(entry.gc.gen0), n(entry.gc.gen1), n(entry.gc.gen2), n(entry.gc.allocatedBytes / entry.requests / 1048576, 1)]] : [];
    }));
  },

  variance() {
    heading('Run-to-run variance (the first run plus the repeats)');
    const rows = [];
    for (const [id, label] of bundles) {
      const dirs = [id, `rep2-${id}`, `rep3-${id}`].filter((dir) => read(dir, 'summary.json'));
      for (const name of configNames(id).filter((candidate) => dirs.filter((dir) => loadEntry(dir, candidate)).length > 1)) {
        const entries = dirs.map((dir) => loadEntry(dir, name)).filter(Boolean);
        const rates = entries.map((entry) => entry.rps);
        const thirds = dirs.map((dir) => lastThird(read(dir, `load-${name}.json`)?.requestsPerSecondTimeline)).filter((value) => value !== undefined);
        rows.push([label, name, entries.length, rates.map((rate) => n(rate, 1)).join(', '), n(mean(rates), 1), `${n(((Math.max(...rates) - Math.min(...rates)) / mean(rates)) * 100, 1)}%`,
          entries.map((entry) => n(entry.cpuMsPerRequest, 2)).join(', '), thirds.length ? n(mean(thirds), 1) : 'n/a']);
      }
    }
    table(['Bundle', 'Configuration', 'Runs', 'rps per run', 'Mean rps', 'Spread (max-min)/mean', 'CPU ms/request per run', 'Mean rps of the last third'], rows);
  },

  tuning() {
    heading('Jint runtime settings, c1-uniform-x16 (one pinned core, 16 connections, 45 s after a 20 s warm-up)');
    const rank = (name) => (name === 'tune-default' ? 0 : name === 'tune-combined' ? 2 : 1);
    const dirs = readdirSync(root).filter((name) => name.startsWith('tune-')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const control = loadEntry('tune-default', 'c1-uniform-x16')?.rps;
    table(['Setting', 'Requests', 'rps', 'vs default', 'rps of the last third', 'CPU ms/request', 'GC pause %', 'All GCs / gen1 and above / gen2', 'Allocated MB per request', 'RSS peak MB'], dirs.flatMap((dir) => {
      const entry = loadEntry(dir, 'c1-uniform-x16');
      if (!entry) return [];
      const third = lastThird(read(dir, 'load-c1-uniform-x16.json')?.requestsPerSecondTimeline);
      return [[dir.replace('tune-', ''), n(entry.requests), n(entry.rps, 1), control ? `${entry.rps > control ? '+' : ''}${n((entry.rps / control - 1) * 100, 1)}%` : 'n/a', n(third, 1), n(entry.cpuMsPerRequest, 1), n(entry.gc?.pausePercent, 1),
        entry.gc ? `${entry.gc.gen0} / ${entry.gc.gen1} / ${entry.gc.gen2}` : 'n/a', entry.gc ? n(entry.gc.allocatedBytes / entry.requests / 1048576, 1) : 'n/a', n(entry.rssPeakMb)]];
    }));

    const combined = loadEntry('tune-combined', 'c4-uniform-x32');
    if (!combined) return;
    heading('Jint, the three settings together, c4-uniform-x32 (four pinned cores, server GC, 32 connections, 45 s after a 30 s warm-up)');
    const defaults = ['jint-plain', 'rep2-jint-plain', 'rep3-jint-plain'].map((dir) => loadEntry(dir, 'c4-uniform-x32')).filter(Boolean);
    const average = (entries, get) => mean(entries.map(get));
    const row = (label, entries) => [label, entries.length, n(average(entries, (entry) => entry.requests)), n(average(entries, (entry) => entry.rps), 1), n(average(entries, (entry) => entry.cpuMsPerRequest), 1),
      n(average(entries, (entry) => entry.gc.pausePercent), 1), entries.map((entry) => `${entry.gc.gen0} / ${entry.gc.gen1} / ${entry.gc.gen2}`).join(', '), n(average(entries, (entry) => entry.rssPeakMb))];
    table(['Setting', 'Runs', 'Requests', 'rps', 'CPU ms/request', 'GC pause %', 'All GCs / gen1 and above / gen2', 'RSS peak MB'], [row('default', defaults), row('combined', [combined])]);
  },

  growth() {
    const soakDir = resolve(root, 'soak');
    const labels = existsSync(soakDir) ? readdirSync(soakDir).filter((name) => /^soak-.*(growth|crawl).*\.json$/.test(name)).map((name) => name.slice(5, -5)) : [];
    for (const label of labels) {
      const soak = read('soak', `soak-${label}.json`);
      heading(`Live set, ${label} (${soak.engine}, ${n(soak.load.requests)} requests from the ${soak.mix} mix, ${n(soak.load.rps, 1)} rps)`);
      const rows = [{ requests: 0, ...soak.liveBefore }, ...(soak.liveTimeline ?? []), { requests: soak.load.requests, ...soak.liveAfter }];
      const crawl = soak.mix === 'crawl-all';
      const distinct = !crawl && pathsDir && expectedDistinct(soak.mix, 1) !== undefined;
      table(['Requests so far', ...(crawl ? ['Passes over the site'] : []), ...(distinct ? ['Distinct pages (expected)'] : []), 'Live set MB', 'Committed MB', 'RSS MB'],
        rows.map((row) => [n(row.requests), ...(crawl ? [n(row.requests / crawlPass, 2)] : []), ...(distinct ? [n(expectedDistinct(soak.mix, row.requests))] : []), n(row.liveMb), n(row.committedMb), n(row.rssMb)]));
    }

    const crawls = labels.map((label) => ({ label, soak: read('soak', `soak-${label}.json`) })).filter(({ soak }) => soak.mix === 'crawl-all');
    if (crawls.length) {
      heading('Full-site crawl summary');
      const slopeText = (timeline, from, to) => {
        const slope = liveSlope(timeline, from, to);
        return slope ? `${n(slope.perThousand, 2)}` : 'n/a';
      };
      const measures = ({ soak }) => {
        const { load, liveBefore, liveAfter, liveTimeline = [] } = soak;
        const onePass = liveTimeline.reduce((best, point) => (!best || Math.abs(point.requests - crawlPass) < Math.abs(best.requests - crawlPass) ? point : best), undefined);
        const slope = liveSlope(liveTimeline, 6500);
        return [
          `${n(soak.durationSeconds)} s`, n(load.requests), n(load.requests / crawlPass, 2), n(load.rps, 1), n(load.serverCores, 2), n(load.cpuMsPerRequest, 2),
          n(load.latencyMs.p99, 1), n(load.latencyMs.max, 1), n(load.errors),
          n(liveBefore.liveMb), onePass ? n(onePass.liveMb) : 'n/a', n(liveAfter.liveMb), n(liveAfter.committedMb), n(liveAfter.rssMb), n(load.rssPeakMb),
          slope ? `${n(slope.perThousand, 2)}, standard error ${n(slope.standardError, 2)}, scatter ${n(slope.scatter, 1)} MB, ${slope.samples} readings` : 'n/a',
          `${slopeText(liveTimeline, 2000, 24000)} / ${slopeText(liveTimeline, 24000, 48000)} / ${slopeText(liveTimeline, 48000)}`,
        ];
      };
      const names = ['Run length', 'Requests', 'Passes over the site', 'Requests per second', 'Server cores in use', 'CPU ms per request', 'Latency p99, ms', 'Latency max, ms', 'Errors',
        'Live set before the load, MB', 'Live set after one pass, MB', 'Live set after the last request, MB', 'Committed after the last request, MB', 'RSS after the last forced collection, MB',
        'Peak RSS sampled during the load, MB', 'Live set slope after request 6,500, MB per 1,000 requests',
        'Live set slope, requests 2,000 to 24,000 / 24,000 to 48,000 / 48,000 on'];
      const columns = crawls.map(measures);
      table(['Measure', ...crawls.map(({ label }) => label)], names.map((name, index) => [name, ...columns.map((column) => column[index])]));
    }
  },

  profile() {
    heading('Node CPU by region (V8 sampling profile, 16 connections, 20 s)');
    // Frames that the analyzer cannot place in a source module fall back to coarser names; fold those into the named regions.
    const region = (name) => {
      if (/^libraries/i.test(name)) return 'Libraries (zod, hast, devalue, ...)';
      if (/^(syntax highlighting|expressive code)/i.test(name)) return 'Syntax highlighting (Expressive Code, Shiki, PostCSS)';
      if (/^starlight$/i.test(name)) return 'Starlight (page chrome, routes, i18n)';
      if (/^astro runtime$/i.test(name)) return 'Astro render pipeline';
      if (/^(idle|native \/ program|other|other packages|site code|content layer)/i.test(name)) return 'Other (idle, native, unattributed)';
      return name;
    };
    const profiles = bundles.slice(0, 2).map(([id, label]) => {
      const profile = read(id, 'summary.json')?.profile;
      const totals = new Map();
      for (const area of profile?.cpu.areas ?? []) totals.set(region(area.name), (totals.get(region(area.name)) ?? 0) + area.percent);
      return [label, profile, totals];
    });
    const names = [...new Set(profiles.flatMap(([, , totals]) => [...totals.keys()]))]
      .sort((a, b) => Number(a.startsWith('Other')) - Number(b.startsWith('Other')) || (profiles[0][2].get(b) ?? 0) - (profiles[0][2].get(a) ?? 0));
    table(['Region', ...profiles.map(([label]) => label)], names.map((name) => [name, ...profiles.map(([, , totals]) => (totals.has(name) ? `${n(totals.get(name), 1)}%` : '-'))]));
    table(['Measure', ...profiles.map(([label]) => label)], [
      ['Requests per second under the profiler', ...profiles.map(([, profile]) => n(profile?.rps, 1))],
      ['Event-loop utilization', ...profiles.map(([, profile]) => n(profile?.eventLoop.utilization, 3))],
      ['GC pause % of wall time', ...profiles.map(([, profile]) => n(profile?.gcPausePercentOfWall, 2))],
      ['Heap used MB', ...profiles.map(([, profile]) => n(profile?.heap.heapUsedMb))],
      ['RSS MB', ...profiles.map(([, profile]) => n(profile?.heap.rssMb))],
    ]);
  },
};

const order = ['cold', 'first-hits', 'sequence', 'load', 'variance', 'tuning', 'growth', 'profile'];
if (section !== 'all' && !sections[section]) throw new Error(`Unknown section "${section}". Use all or one of: ${order.join(', ')}`);
for (const name of section === 'all' ? order : [section]) sections[name]();
