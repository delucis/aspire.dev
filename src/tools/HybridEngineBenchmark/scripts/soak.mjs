// A long run of one configuration on one core: does the throughput settle after the ramp, and does memory plateau or keep
// growing? It is the c1-uniform-x16 load configuration of bundle-bench.mjs (one pinned logical core, 16 connections, uniform
// HTML mix, response cache bypassed) with no warm-up window, so the whole ramp is visible, and with a poll of the server
// every few seconds. A Jint host reports its own working set, CPU, heap, GC and JIT counters at /api/host; a Node renderer
// is read through its inspector, which costs nothing while idle.
//
// Before the load, one page is requested (so the engine has loaded its modules and data) and a full collection reports the
// live set; after the load another full collection reports it again. Garbage that is waiting for a collection is not a leak;
// a live set that has grown is. Both collections run outside the measured window.
//
//   node soak.mjs --engine node --renderer <dir> --paths <dir> --out <dir> [--duration 240]
//   node soak.mjs --engine jint --host <dir> --dist <dir> --paths <dir> --out <dir> [--duration 240]
//
//   optional: --interval 5 (seconds between polls)  --window 15 (seconds per summary row)  --connections 16
//             --mix uniform-html  --port 4323  --label <text>  --server-mask 0x4  --generator-cores 0x4010
//             --live-every <seconds>  a full collection during the load every so often, to follow the live set (a growth probe,
//                                     not a throughput measurement, because every collection pauses the server)
//             --select random|sequential  how each connection picks its next path. With --connections 1 and sequential the
//                                     mix is walked once, in file order, and then again from the start (a crawl of the site)
import { resolve } from 'node:path';
import { get, inspect, loadgenAsync, pickPaths, readEventLoopWatch, round, sleep, soakWindows, startEngine, startEventLoopWatch, writeJson } from './lib.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const engine = arg('engine', 'node');
if (!['node', 'jint'].includes(engine)) throw new Error(`--engine must be node or jint, not ${engine}`);
const pathsDir = resolve(arg('paths'));
const out = resolve(arg('out'));
const duration = Number(arg('duration', 240));
const interval = Number(arg('interval', 5));
const windowSeconds = Number(arg('window', 15));
const liveEvery = Number(arg('live-every', 0));
const connections = arg('connections', '16');
const mix = arg('mix', 'uniform-html');
const select = arg('select', 'random');
if (!['random', 'sequential'].includes(select)) throw new Error(`--select must be random or sequential, not ${select}`);
const port = Number(arg('port', 4323));
const label = arg('label', `${engine}-soak`);
const serverMask = arg('server-mask', '0x4');
const generatorCores = arg('generator-cores', '0x4010');
const inspectPort = 9239;
const rendererDir = engine === 'node' ? resolve(arg('renderer')) : undefined;
const hostDir = engine === 'jint' ? resolve(arg('host')) : undefined;
const distDir = engine === 'jint' ? resolve(arg('dist')) : undefined;

const headers = ['Host: aspire.dev', 'X-Forwarded-Host: aspire.dev', 'X-Forwarded-Proto: https', 'X-Aspire-Cache-Bypass: 1'];
const mb = (bytes) => bytes / 1048576;

const server = await startEngine({ engine, rendererDir, hostDir, distDir, logDir: resolve(out, 'logs') }, port, label,
  { units: 1, serverGc: false, processorCount: 1, extraNodeArgs: engine === 'node' ? [`--inspect=127.0.0.1:${inspectPort}`] : [] });
const session = engine === 'node' ? await inspect(inspectPort) : undefined;

/** The live set: what survives a full, compacting collection, and what the process still holds afterwards. */
async function liveSet() {
  if (session) {
    await session.send('HeapProfiler.collectGarbage');
    const read = await session.evaluate(`(() => { const m = process.memoryUsage(); return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external }; })()`);
    return { liveMb: round(mb(read.heapUsed), 0), committedMb: round(mb(read.heapTotal), 0), externalMb: round(mb(read.external), 0), rssMb: round(mb(read.rss), 0) };
  }
  const host = await (await fetch(`http://127.0.0.1:${port}/api/gc`, { method: 'POST', signal: AbortSignal.timeout(120000) })).json();
  return { liveMb: round(mb(host.promotedBytes), 0), heapSizeMb: round(mb(host.heapSizeBytes), 0), fragmentedMb: round(mb(host.fragmentedBytes), 0), committedMb: round(mb(host.committedBytes), 0), rssMb: round(mb(host.workingSetBytes), 0), pauseMs: round(host.pauseMs, 0) };
}

/** One reading of the server, in the same shape for both engines. */
async function poll() {
  if (session) {
    const read = await session.evaluate(`(() => { const m = process.memoryUsage(); const c = process.cpuUsage(); return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, cpuSeconds: (c.user + c.system) / 1e6 }; })()`);
    return { cpuSeconds: read.cpuSeconds, rssMb: mb(read.rss), heapMb: mb(read.heapUsed), committedMb: mb(read.heapTotal), externalMb: mb(read.external) };
  }
  const host = await (await fetch(`http://127.0.0.1:${port}/api/host`, { signal: AbortSignal.timeout(30000) })).json();
  return {
    cpuSeconds: host.cpuSeconds, rssMb: mb(host.workingSetBytes), heapMb: mb(host.gc.heapBytes), committedMb: mb(host.gc.committedBytes),
    gen0: host.gc.gen0, gen1: host.gc.gen1, gen2: host.gc.gen2, gcPauseMs: host.gc.pauseMs, allocatedMb: mb(host.gc.allocatedBytes),
    jitMethods: host.jit.methods, jitMs: host.jit.ms, threads: host.threadPool.threads,
    lastEphemeral: host.gc.lastEphemeral, lastFullBlocking: host.gc.lastFullBlocking,
  };
}

const args = ['--url', `http://127.0.0.1:${port}`, '--paths-file', resolve(pathsDir, `${mix}.txt`), '--mode', 'load', '--connections', connections, '--select', select,
  '--duration', String(duration), '--warmup', '0', '--pid', String(server.pid), '--label', label, ...headers.flatMap((header) => ['--header', header]),
  '--server-affinity', serverMask, '--affinity', generatorCores, ...(engine === 'jint' ? ['--gc-stats', '/api/host'] : [])];

console.log(`[${label}] ready in ${server.readyMs} ms; ${duration} s at ${connections} connections, polling every ${interval} s`);
// One page first, so that the engine has loaded its modules and data before the baseline and before the load.
const [warmPath] = pickPaths(pathsDir, 'csharp-type', 1, 7);
const warmStarted = performance.now();
const warmReply = await get(`http://127.0.0.1:${port}${warmPath}`, Object.fromEntries(headers.map((header) => header.split(': '))));
const firstPageMs = round(performance.now() - warmStarted, 0);
console.log(`first page: ${warmReply.status} in ${firstPageMs} ms`);
const liveBefore = await liveSet();
console.log('live set before the load', JSON.stringify(liveBefore));
if (session) await startEventLoopWatch(session);

const samples = [];
const liveTimeline = [];
const take = async () => {
  const before = Date.now();
  try { const reading = await poll(); samples.push({ utc: Math.round((before + Date.now()) / 2), ...reading }); } catch (error) { console.log(`poll failed: ${error.message}`); }
};
const takeLive = async () => {
  const before = Date.now();
  try { const reading = await liveSet(); liveTimeline.push({ utc: Math.round((before + Date.now()) / 2), ...reading }); } catch (error) { console.log(`live set failed: ${error.message}`); }
};
let finished = false;
const run = loadgenAsync(args, resolve(out, `load-${label}.json`));
const settled = run.then(() => undefined, () => undefined).then(() => { finished = true; });
await take();
let nextLive = liveEvery > 0 ? Date.now() + liveEvery * 1000 : Number.POSITIVE_INFINITY;
while (!finished) {
  await Promise.race([sleep(interval * 1000), settled]);
  if (finished) break;
  await take();
  if (Date.now() >= nextLive) {
    await takeLive();
    nextLive = Date.now() + liveEvery * 1000;
  }
}
const { report, console: text } = await run;
await take();
process.stdout.write(text);
const loop = session ? await readEventLoopWatch(session) : undefined;
const liveAfter = await liveSet();
console.log('live set after the load ', JSON.stringify(liveAfter));
session?.close();
await server.stop();

// LoadGen starts its clock after its probe request, so the samples are placed on the clock of its report: second 0 is the
// start of the measured window, and the samples before it belong to the probe.
const origin = Date.parse(report.startedUtc);
for (const sample of [...samples, ...liveTimeline]) sample.t = round((sample.utc - origin) / 1000, 2);

// Rows of `windowSeconds` seconds: requests from LoadGen's per-second timeline, everything else from the polls at the window's edges.
const timeline = report.requestsPerSecondTimeline;
const rows = soakWindows({ samples, timeline, windowSeconds, engine });
console.table(rows);

for (const entry of liveTimeline) entry.requests = timeline.slice(0, Math.max(0, Math.floor(entry.t))).reduce((sum, count) => sum + count, 0);
if (liveTimeline.length) {
  const view = ({ liveMb, committedMb, rssMb }) => ({ liveMb, committedMb, rssMb });
  console.table([{ t: 'before', requests: 0, ...view(liveBefore) }, ...liveTimeline.map((entry) => ({ t: entry.t, requests: entry.requests, ...view(entry) })), { t: 'after', requests: report.requests, ...view(liveAfter) }]);
}

writeJson(resolve(out, `soak-${label}.json`), {
  startedUtc: report.startedUtc, engine, label, node: process.version, connections: Number(connections), mix, select, durationSeconds: duration, intervalSeconds: interval, liveEverySeconds: liveEvery || undefined,
  readyMs: server.readyMs, atReady: server.atReady, firstPageMs, liveBefore, liveAfter, liveTimeline,
  load: {
    rps: round(report.requestsPerSecond), requests: report.requests, errors: report.errors, statuses: report.statuses,
    latencyMs: Object.fromEntries(Object.entries(report.latency).map(([key, value]) => [key, round(value, 2)])),
    serverCores: round(report.server.serverCores, 2), cpuMsPerRequest: round(report.server.serverCpuSeconds * 1000 / report.requests, 2),
    rssStartMb: round(report.server.serverRssStartBytes / 1048576), rssEndMb: round(report.server.serverRssEndBytes / 1048576), rssPeakMb: round(report.server.serverRssPeakBytes / 1048576),
  },
  eventLoop: loop, windows: rows, timeline, samples,
});
console.log(`Wrote ${resolve(out, `soak-${label}.json`)}`);
