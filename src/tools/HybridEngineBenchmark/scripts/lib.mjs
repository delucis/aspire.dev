// Helpers shared by the benchmark runners: start a server and time it to readiness, read a process's CPU and memory,
// run the LoadGen tool and read its JSON. Everything here is engine-neutral, so Node and Jint hosts are measured alike.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : value);

/** @param {string} path @param {unknown} value */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** CPU seconds (user+kernel) and memory of a process, read from outside it. @param {number} pid */
export function processStats(pid) {
  if (process.platform === 'win32') {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{ cpu = $p.TotalProcessorTime.TotalSeconds; rss = $p.WorkingSet64; priv = $p.PrivateMemorySize64; threads = $p.Threads.Count } | ConvertTo-Json -Compress`;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (run.status !== 0) throw new Error(`Could not read process ${pid}: ${run.stderr}`);
    const read = JSON.parse(run.stdout);
    return { cpuSeconds: read.cpu, rssBytes: read.rss, privateBytes: read.priv, threads: read.threads };
  }
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[11]) + Number(fields[12]);
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kilobytes = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? 0) * 1024;
  return { cpuSeconds: ticks / 100, rssBytes: kilobytes('VmRSS'), privateBytes: kilobytes('VmData'), threads: Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] ?? 0) };
}

/** @param {string} url @param {Record<string,string>} [headers] @returns {Promise<{status:number, bytes:number}>} */
export function get(url, headers = {}) {
  return new Promise((done, fail) => {
    const req = request(url, { headers, agent: false, timeout: 60000 }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => done({ status: res.statusCode ?? 0, bytes }));
    });
    req.on('error', fail);
    req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
    req.end();
  });
}

/**
 * Starts a server, polls until the ready URL answers 2xx/3xx, and reports how long that took, the processor time it
 * burned and the memory it held at that point.
 * @param {{ name: string, command: string, args: string[], cwd: string, env?: Record<string,string>, readyUrl: string,
 *   readyHeaders?: Record<string,string>, log: string, timeoutMs?: number }} spec
 */
export async function startServer(spec) {
  mkdirSync(dirname(spec.log), { recursive: true });
  const fd = openSync(spec.log, 'a');
  const t0 = performance.now();
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = t0 + (spec.timeoutMs ?? 180000);
  let readyMs;
  while (performance.now() < deadline) {
    if (exited) throw new Error(`${spec.name} exited with ${child.exitCode} before it was ready; see ${spec.log}`);
    try {
      const reply = await get(spec.readyUrl, spec.readyHeaders);
      if (reply.status >= 200 && reply.status < 400) { readyMs = performance.now() - t0; break; }
    } catch { /* not listening yet */ }
    await sleep(5);
  }
  if (readyMs === undefined) { child.kill(); throw new Error(`${spec.name} was not ready after ${spec.timeoutMs ?? 180000} ms; see ${spec.log}`); }
  const atReady = processStats(child.pid);
  return {
    name: spec.name,
    pid: child.pid,
    readyMs: round(readyMs, 0),
    atReady: { cpuSeconds: round(atReady.cpuSeconds, 2), rssMb: round(atReady.rssBytes / 1048576), privateMb: round(atReady.privateBytes / 1048576) },
    stats: () => processStats(child.pid),
    stop: async () => {
      if (exited) return;
      child.kill();
      for (let i = 0; i < 100 && !exited; i++) await sleep(50);
    },
  };
}

/**
 * Runs the LoadGen executable and returns the parsed JSON it wrote.
 * @param {string[]} args @param {string} out
 */
export function loadgen(args, out) {
  const exe = process.env.LOADGEN_EXE ?? (process.platform === 'win32' ? 'LoadGen.exe' : 'LoadGen');
  const run = spawnSync(exe, [...args, '--out', out], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`LoadGen failed (${run.status}): ${run.stdout}\n${run.stderr}`);
  return { report: JSON.parse(readFileSync(out, 'utf8')), console: run.stdout };
}

/**
 * Like loadgen, but does not block the caller, so a script can poll the server while the load runs.
 * @param {string[]} args @param {string} out
 * @returns {Promise<{report: any, console: string}>}
 */
export function loadgenAsync(args, out) {
  const exe = process.env.LOADGEN_EXE ?? (process.platform === 'win32' ? 'LoadGen.exe' : 'LoadGen');
  return new Promise((done, fail) => {
    const run = spawn(exe, [...args, '--out', out], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let errors = '';
    run.stdout.on('data', (chunk) => { text += chunk; });
    run.stderr.on('data', (chunk) => { errors += chunk; });
    run.on('error', fail);
    run.on('close', (status) => {
      if (status !== 0) fail(new Error(`LoadGen failed (${status}): ${text}\n${errors}`));
      else done({ report: JSON.parse(readFileSync(out, 'utf8')), console: text });
    });
  });
}

export const resolveHere = (...parts) => resolve(here, ...parts);

/**
 * Starts one server of either engine from a built hybrid API bundle and waits until it answers.
 *
 * Node: `config.rendererDir` holds `scripts/serve-api-docs.mjs`, `server/`, `node_modules/` and `hybrid-api-docs.json`.
 * Jint: `config.hostDir` is the published JintHost and `config.distDir` the build with `server/` and `astro-jint.json`;
 * `units` is the engine pool size. `processorCount` makes .NET see only the CPU budget the caller will pin it to, as a
 * CPU-limited container would.
 *
 * @param {{ engine: 'node'|'jint', rendererDir?: string, hostDir?: string, distDir?: string, logDir: string }} config
 * @param {number} port @param {string} name
 * @param {{ units?: number, serverGc?: boolean, processorCount?: number, extraNodeArgs?: string[] }} [options]
 */
export function startEngine(config, port, name, { units = 1, serverGc, processorCount, extraNodeArgs = [] } = {}) {
  const log = resolve(config.logDir, `${name}.log`);
  if (config.engine === 'node') {
    return startServer({
      name,
      command: process.execPath,
      args: [...extraNodeArgs, 'scripts/serve-api-docs.mjs'],
      cwd: config.rendererDir,
      env: {
        NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=1024', HOST: '127.0.0.1', PORT: String(port),
        HYBRID_API_DOCS_MANIFEST: resolve(config.rendererDir, 'hybrid-api-docs.json'),
      },
      readyUrl: `http://127.0.0.1:${port}/__hybrid-api-docs/health`,
      log,
    });
  }
  const useServerGc = serverGc ?? units > 1;
  return startServer({
    name,
    command: 'dotnet',
    args: [resolve(config.hostDir, 'JintHost.dll')],
    cwd: config.hostDir,
    env: {
      ASPNETCORE_URLS: `http://127.0.0.1:${port}`, Astro__DistPath: config.distDir, Astro__PoolSize: String(units), Astro__WarmUp: 'true',
      Astro__MemoryLimitBytes: '6442450944', Astro__RequestTimeout: '00:10:00',
      DOTNET_gcServer: useServerGc ? '1' : '0', DOTNET_GCNoAffinitize: '1', ...(useServerGc ? { DOTNET_GCHeapCount: String(units) } : {}),
      ...(processorCount ? { DOTNET_PROCESSOR_COUNT: String(processorCount) } : {}),
    },
    readyUrl: `http://127.0.0.1:${port}/healthz`,
    log,
  });
}

/**
 * A small Chrome DevTools Protocol client for a Node process started with --inspect. It lets the runner profile a server
 * and read its event-loop statistics without changing the code under test.
 * @param {number} port
 */
export async function inspect(port, host = '127.0.0.1') {
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try {
      const list = await (await fetch(`http://${host}:${port}/json/list`)).json();
      target = list[0]?.webSocketDebuggerUrl;
    } catch { /* inspector not up yet */ }
    if (!target) await sleep(50);
  }
  if (!target) throw new Error(`No inspector on ${host}:${port}`);
  const socket = new WebSocket(target);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error('inspector connection failed')); });
  let next = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(`${message.error.message}`)); else waiter.done(message.result);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++next;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

/** A small seeded generator, so every run and every engine samples the same paths. */
export function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Picks `count` distinct paths of one route kind from `<pathsDir>/<kind>.txt`, deterministically for a seed. */
export function pickPaths(pathsDir, kind, count, seed = 7) {
  const lines = readFileSync(resolve(pathsDir, `${kind}.txt`), 'utf8').split(/\r?\n/).filter(Boolean);
  const random = mulberry32(seed);
  return [...lines].sort(() => random() - 0.5).slice(0, count);
}

/**
 * Starts an event-loop interval histogram (1 ms resolution, so an idle loop reads about 1 ms), a utilization baseline and
 * a GC pause observer inside the inspected process.
 */
export const startEventLoopWatch = (session) => session.evaluate(`(() => {
  const { monitorEventLoopDelay, PerformanceObserver, constants } = process.getBuiltinModule('node:perf_hooks');
  const names = { [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor', [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major', [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental' };
  const state = { histogram: monitorEventLoopDelay({ resolution: 1 }), elu: performance.eventLoopUtilization(), gc: {} };
  state.record = (entries) => {
    for (const entry of entries) {
      const bucket = (state.gc[names[entry.detail.kind] ?? 'other'] ??= { count: 0, totalMs: 0, maxMs: 0 });
      bucket.count++; bucket.totalMs += entry.duration; bucket.maxMs = Math.max(bucket.maxMs, entry.duration);
    }
  };
  state.observer = new PerformanceObserver((list) => state.record(list.getEntries()));
  state.observer.observe({ entryTypes: ['gc'] });
  state.histogram.enable();
  globalThis.__bench = state;
  return true;
})()`);

/** Reads what startEventLoopWatch collected: utilization (0..1), loop interval percentiles and GC pauses per kind. */
export const readEventLoopWatch = (session) => session.evaluate(`(() => {
  const state = globalThis.__bench;
  state.record(state.observer.takeRecords());
  state.observer.disconnect();
  state.histogram.disable();
  const used = performance.eventLoopUtilization(state.elu);
  const ms = (nanoseconds) => Math.round(nanoseconds / 1e4) / 100;
  const round = (value) => Math.round(value * 100) / 100;
  const { histogram } = state;
  return {
    utilization: Math.round(used.utilization * 1000) / 1000,
    intervalMs: { mean: ms(histogram.mean), p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max) },
    gc: Object.fromEntries(Object.entries(state.gc).map(([kind, bucket]) => [kind, { count: bucket.count, totalMs: round(bucket.totalMs), maxMs: round(bucket.maxMs) }])),
  };
})()`);

/**
 * Window rows of a soak run. `samples` are polls of the server stamped with `t`, the seconds on the clock of the load
 * generator's report (second 0 starts the measured window); `timeline` is the generator's completed requests per second.
 * Counters are interpolated between the two polls around each window edge, so that a window covers exactly `windowSeconds`
 * seconds of server time no matter when the polls happened.
 */
export function soakWindows({ samples, timeline, windowSeconds, engine }) {
  const ordered = [...samples].sort((a, b) => a.t - b.t);
  const valueAt = (second, key) => {
    const after = ordered.findIndex((sample) => sample.t >= second);
    if (after < 0) return ordered.at(-1)[key];
    if (after === 0) return ordered[0][key];
    const a = ordered[after - 1];
    const b = ordered[after];
    return b.t === a.t ? b[key] : a[key] + ((b[key] - a[key]) * (second - a.t)) / (b.t - a.t);
  };
  const rows = [];
  for (let from = 0; from < timeline.length; from += windowSeconds) {
    const to = Math.min(from + windowSeconds, timeline.length);
    const seconds = to - from;
    const requests = timeline.slice(from, to).reduce((sum, count) => sum + count, 0);
    const delta = (key) => valueAt(to, key) - valueAt(from, key);
    const row = {
      fromSecond: from, toSecond: to, requests, rps: round(requests / seconds, 1),
      serverCores: round(delta('cpuSeconds') / seconds, 2), cpuMsPerRequest: requests ? round((delta('cpuSeconds') * 1000) / requests, 1) : null,
      rssMb: round(valueAt(to, 'rssMb'), 0), heapMb: round(valueAt(to, 'heapMb'), 0), committedMb: round(valueAt(to, 'committedMb'), 0),
    };
    if (engine === 'jint') {
      Object.assign(row, {
        gen0: Math.round(delta('gen0')), gen1: Math.round(delta('gen1')), gen2: Math.round(delta('gen2')), gcPausePercent: round(delta('gcPauseMs') / (seconds * 10), 1),
        allocatedMbPerRequest: requests ? round(delta('allocatedMb') / requests, 1) : null, jitMethods: Math.round(delta('jitMethods')), jitMs: round(delta('jitMs'), 0),
      });
    }
    rows.push(row);
  }
  return rows;
}
