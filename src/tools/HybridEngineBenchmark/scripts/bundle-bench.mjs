// Same-protocol benchmark of a built hybrid API server bundle on either engine, so the Node sidecar renderer and the
// Jint host are measured with identical workloads, headers, CPU budgets and statistics.
//
//   node bundle-bench.mjs --engine node --renderer <dir with scripts/serve-api-docs.mjs, server/, node_modules/> ...
//   node bundle-bench.mjs --engine jint --host <JintHost publish dir> --dist <dir with server/ and astro-jint.json> ...
//
//   common: --paths <dir of make-paths output> --out <results dir> [--only cold,sequence,load,profile]
//           [--configs <load config names>] [--port 4323] [--duration 30] [--label <text>]
//           [--generator-cores 0x4010] [--server-masks 0x4,0x44,0x1444]
//
// The CPU budget of a load configuration is its number of engines: `cores` logical processors (one per physical P-core),
// pinned with the load generator. For Node that is `cores` renderer processes, for Jint one process with a pool of
// `cores` engines. Connections, path mixes and statistics are the same.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { get, inspect, loadgen, pickPaths, readEventLoopWatch, round, sleep, startEngine, startEventLoopWatch, writeJson } from './lib.mjs';
import { summarizeProfile } from './analyze-cpuprofile.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const engine = arg('engine', 'node');
if (!['node', 'jint'].includes(engine)) throw new Error(`--engine must be node or jint, not ${engine}`);
const pathsDir = resolve(arg('paths'));
const out = resolve(arg('out'));
const only = new Set(arg('only', 'cold,sequence,load,profile').split(','));
const onlyConfigs = arg('configs') ? new Set(arg('configs').split(',')) : undefined;
const basePort = Number(arg('port', 4323));
const duration = arg('duration', '30');
const generatorCores = arg('generator-cores', '0x4010');
const label = arg('label', engine);
const rendererDir = engine === 'node' ? resolve(arg('renderer')) : undefined;
const hostDir = engine === 'jint' ? resolve(arg('host')) : undefined;
const distDir = engine === 'jint' ? resolve(arg('dist')) : undefined;

const siteHeaders = ['Host: aspire.dev', 'X-Forwarded-Host: aspire.dev', 'X-Forwarded-Proto: https'];
const bypassHeader = 'X-Aspire-Cache-Bypass: 1';
const kinds = ['csharp-package', 'csharp-type', 'csharp-memberkind', 'ts-module', 'ts-item', 'ts-member', 'csharp-md', 'ts-md'];
// Masks for 1, 2 and 4 cores. They name logical processors that were measured to be quiet on the benchmark machine
// (one hyper-thread per physical P-core, its sibling left idle); see the README for how to choose them on another machine.
const [oneCore, twoCores, fourCores] = arg('server-masks', '0x4,0x44,0x1444').split(',');
const coreMasks = { 1: oneCore, 2: twoCores, 4: fourCores };
mkdirSync(resolve(out, 'logs'), { recursive: true });

const headerArgs = (bypass) => [...siteHeaders, ...(bypass ? [bypassHeader] : [])].flatMap((header) => ['--header', header]);
const headerObject = (bypass) => Object.fromEntries([...siteHeaders, ...(bypass ? [bypassHeader] : [])].map((header) => header.split(': ')));
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; };

function sample(kind, count, seed = 7) {
  const picked = pickPaths(pathsDir, kind, count, seed);
  const file = resolve(out, `paths-${kind}.txt`);
  writeFileSync(file, picked.join('\n'));
  return { file, picked };
}

/** Starts one server of the engine under test; see startEngine. */
const start = (port, name, options) => startEngine({ engine, rendererDir, hostDir, distDir, logDir: resolve(out, 'logs') }, port, name, options);

const summary = {
  startedUtc: new Date().toISOString(), engine, label, node: process.version,
  machine: { platform: process.platform, cpus: (await import('node:os')).cpus().length },
  cold: [], sequence: [], load: [], profile: null,
};

// ---------- cold start: process spawn -> first successful health check, then the first request of every route kind ----------
if (only.has('cold')) {
  console.log(`\n=== [${label}] cold start (3 fresh processes) ===`);
  for (let run = 1; run <= 3; run++) {
    const server = await start(basePort, `cold-${run}`);
    const firstHits = {};
    const hitsStarted = performance.now();
    for (const kind of ['csharp-type', 'ts-module', 'ts-item', 'ts-member', 'csharp-package', 'csharp-memberkind', 'csharp-md', 'ts-md']) {
      const path = sample(kind, 1, 7).picked[0];
      const started = performance.now();
      const reply = await get(`http://127.0.0.1:${basePort}${path}`, headerObject(true));
      firstHits[kind] = { ms: round(performance.now() - started), status: reply.status, kb: round(reply.bytes / 1024) };
    }
    const after = server.stats();
    const entry = {
      run, readyMs: server.readyMs, atReady: server.atReady,
      timeToFirstPageMs: round(server.readyMs + firstHits['csharp-type'].ms, 0), allFirstHitsMs: round(performance.now() - hitsStarted, 0),
      afterFirstHits: { cpuSeconds: round(after.cpuSeconds, 2), rssMb: round(after.rssBytes / 1048576) }, firstHits,
    };
    console.log(JSON.stringify(entry));
    summary.cold.push(entry);
    await server.stop();
    await sleep(500);
  }
}

// ---------- sequence: one connection, per route kind; Node is measured uncached (bypass) and through its LRU ----------
if (only.has('sequence')) {
  console.log(`\n=== [${label}] sequence per route kind ===`);
  const server = await start(basePort, 'sequence');
  // One-time work (module loading, lazily built route indexes) is reported by the cold-start phase, not here.
  for (const kind of kinds) for (const path of sample(kind, 3, 99).picked) await get(`http://127.0.0.1:${basePort}${path}`, headerObject(true));
  await sleep(500);
  for (const kind of kinds) {
    const { file, picked } = sample(kind, 25);
    const row = { kind, samples: picked.length };
    for (const mode of engine === 'node' ? ['bypass', 'cached'] : ['bypass']) {
      const { report } = loadgen(['--url', `http://127.0.0.1:${basePort}`, '--paths-file', file, '--mode', 'sequence', '--repeat', '3', '--label', `${kind}-${mode}`, ...headerArgs(mode === 'bypass')], resolve(out, `sequence-${kind}-${mode}.json`));
      const first = report.entries.map((entry) => entry.milliseconds[0]);
      const rest = report.entries.flatMap((entry) => entry.milliseconds.slice(1));
      row[mode] = { firstMedianMs: round(median(first), 2), firstMaxMs: round(Math.max(...first), 1), repeatMedianMs: round(median(rest), 2), kb: round(median(report.entries.map((entry) => entry.bytes)) / 1024), statuses: [...new Set(report.entries.map((entry) => entry.status))] };
    }
    console.log(JSON.stringify(row));
    summary.sequence.push(row);
  }
  const stats = server.stats();
  summary.sequenceMemory = { rssMb: round(stats.rssBytes / 1048576), cpuSeconds: round(stats.cpuSeconds, 1) };
  await server.stop();
}

// ---------- load: closed-loop connections against fresh servers, pinned to `cores` logical P-cores ----------
const matrix = [
  { name: 'c1-uniform-x1', cores: 1, mix: 'uniform-html', connections: 1 },
  { name: 'c1-uniform-x4', cores: 1, mix: 'uniform-html', connections: 4 },
  { name: 'c1-uniform-x16', cores: 1, mix: 'uniform-html', connections: 16 },
  { name: 'c1-zipf-x16', cores: 1, mix: 'zipf-html', connections: 16 },
  { name: 'c1-md-x16', cores: 1, mix: 'all-md', connections: 16 },
  { name: 'c2-uniform-x16', cores: 2, mix: 'uniform-html', connections: 16 },
  { name: 'c4-uniform-x32', cores: 4, mix: 'uniform-html', connections: 32 },
  ...(engine === 'jint' ? [{ name: 'c4-uniform-x32-wks', cores: 4, mix: 'uniform-html', connections: 32, serverGc: false }] : []),
  ...(engine === 'node' ? [{ name: 'c1-zipf-x16-cached', cores: 1, mix: 'zipf-html', connections: 16, bypass: false }] : []),
];

if (only.has('load')) {
  console.log(`\n=== [${label}] load ===`);
  for (const entry of matrix.filter((candidate) => !onlyConfigs || onlyConfigs.has(candidate.name))) {
    const bypass = entry.bypass ?? true;
    const servers = [];
    const processes = engine === 'node' ? entry.cores : 1;
    for (let index = 0; index < processes; index++) servers.push(await start(basePort + index, `${entry.name}-${index}`, { units: entry.cores, serverGc: entry.serverGc, processorCount: entry.cores }));
    const warmup = engine === 'jint' ? String(entry.cores > 1 ? 30 : 20) : '8';
    const args = ['--url', servers.map((_, index) => `http://127.0.0.1:${basePort + index}`).join(','), '--paths-file', resolve(pathsDir, `${entry.mix}.txt`),
      '--mode', 'load', '--connections', String(entry.connections), '--duration', duration, '--warmup', warmup,
      '--pid', servers.map((server) => server.pid).join(','), '--label', entry.name, ...headerArgs(bypass),
      '--server-affinity', coreMasks[entry.cores], '--affinity', generatorCores];
    if (engine === 'jint') args.push('--gc-stats', '/api/host');
    const { report, console: text } = loadgen(args, resolve(out, `load-${entry.name}.json`));
    process.stdout.write(text);
    summary.load.push({
      ...entry, engine, rps: round(report.requestsPerSecond), requests: report.requests, errors: report.errors, statuses: report.statuses, avgKb: round(report.averageBytes / 1024),
      latencyMs: Object.fromEntries(Object.entries(report.latency).map(([key, value]) => [key, round(value, 2)])),
      serverCores: round(report.server.serverCores, 2), cpuMsPerRequest: round(report.server.serverCpuSeconds * 1000 / report.requests, 2),
      rssStartMb: round(report.server.serverRssStartBytes / 1048576), rssEndMb: round(report.server.serverRssEndBytes / 1048576), rssPeakMb: round(report.server.serverRssPeakBytes / 1048576),
      ...(report.gc ? { gc: report.gc } : {}),
    });
    await Promise.all(servers.map((server) => server.stop()));
    await sleep(800);
  }
}

// ---------- profile (Node only here): V8 CPU profile + event-loop interval + GC pauses under the uniform mix ----------
if (only.has('profile') && engine === 'node') {
  console.log(`\n=== [${label}] profile (16 connections, uniform mix, cache bypass) ===`);
  const inspectPort = 9239;
  const server = await start(basePort, 'profile', { extraNodeArgs: [`--inspect=127.0.0.1:${inspectPort}`] });
  const session = await inspect(inspectPort);
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 1000 });
  loadgen(['--url', `http://127.0.0.1:${basePort}`, '--paths-file', resolve(pathsDir, 'uniform-html.txt'), '--mode', 'load', '--connections', '16', '--duration', '1', '--warmup', '6', '--label', 'profile-warm', ...headerArgs(true)], resolve(out, 'profile-warm.json'));
  await startEventLoopWatch(session);
  await session.send('Profiler.start');
  const { report, console: text } = loadgen(['--url', `http://127.0.0.1:${basePort}`, '--paths-file', resolve(pathsDir, 'uniform-html.txt'), '--mode', 'load', '--connections', '16', '--duration', '20', '--warmup', '0', '--pid', String(server.pid), '--label', 'profile', ...headerArgs(true)], resolve(out, 'profile-load.json'));
  process.stdout.write(text);
  const { profile } = await session.send('Profiler.stop');
  const loop = await readEventLoopWatch(session);
  const heap = await session.evaluate('(() => { const m = process.memoryUsage(); const v = process.getBuiltinModule("node:v8").getHeapStatistics(); return { rssMb: Math.round(m.rss/1048576), heapUsedMb: Math.round(m.heapUsed/1048576), heapTotalMb: Math.round(m.heapTotal/1048576), externalMb: Math.round(m.external/1048576), arrayBuffersMb: Math.round(m.arrayBuffers/1048576), heapLimitMb: Math.round(v.heap_size_limit/1048576) }; })()');
  writeFileSync(resolve(out, 'profile.cpuprofile'), JSON.stringify(profile));
  session.close();
  await server.stop();
  const pauseMs = Object.values(loop.gc).reduce((sum, bucket) => sum + bucket.totalMs, 0);
  summary.profile = {
    requests: report.requests, rps: round(report.requestsPerSecond), seconds: report.seconds, eventLoop: loop, heap,
    gcPausePercentOfWall: round(pauseMs / (report.seconds * 1000) * 100, 2),
    cpu: summarizeProfile(profile, { topN: 30, serverRoot: resolve(rendererDir, 'server') }),
  };
  console.log(JSON.stringify({ eventLoop: loop, heap, gcPausePercentOfWall: summary.profile.gcPausePercentOfWall }, null, 1));
}

writeJson(resolve(out, 'summary.json'), summary);
console.log(`\nWrote ${resolve(out, 'summary.json')}`);
