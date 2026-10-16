// Samples the managed call stacks of the Jint host with dotnet-trace while it renders the c1-uniform-x16 load (one pinned
// logical core, 16 connections, uniform HTML mix), then aggregates the samples with analyze-nettrace.mjs. Jint has no
// JavaScript-level profiler, so this shows where the .NET time goes: the interpreter, the parser, the runtime libraries,
// ASP.NET Core and the astro-jint host. The profiler adds overhead, so use the shares and not the throughput.
//
//   node jint-trace.mjs --host <JintHost publish dir> --dist <dir with server/ and astro-jint.json> --paths <dir> --out <dir>
//                       [--tool dotnet-trace] [--lead 75] [--seconds 40] [--connections 16] [--profile dotnet-sampled-thread-time]
//
// `--lead` is how long the load runs before sampling starts, so that the sample covers the settled interpreter and not the ramp.
// The sampler runs at about 100 Hz, so 40 seconds of one busy engine thread is about 4,000 samples.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { get, loadgenAsync, pickPaths, round, sleep, startEngine, writeJson } from './lib.mjs';
import { printSummary, summarizeSpeedscope } from './analyze-nettrace.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const hostDir = resolve(arg('host'));
const distDir = resolve(arg('dist'));
const pathsDir = resolve(arg('paths'));
const out = resolve(arg('out'));
const tool = arg('tool', 'dotnet-trace');
const lead = Number(arg('lead', 75));
const seconds = Number(arg('seconds', 40));
const connections = arg('connections', '16');
const profile = arg('profile', 'dotnet-sampled-thread-time');
const port = Number(arg('port', 4323));
const serverMask = arg('server-mask', '0x4');
const generatorCores = arg('generator-cores', '0x4010');
mkdirSync(out, { recursive: true });

const headers = ['Host: aspire.dev', 'X-Forwarded-Host: aspire.dev', 'X-Forwarded-Proto: https', 'X-Aspire-Cache-Bypass: 1'];
const run = (command, args, log) => new Promise((done, fail) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.stderr.on('data', (chunk) => { text += chunk; });
  child.on('error', fail);
  child.on('close', (status) => { writeJson(log, { command, args, status, text }); status === 0 ? done(text) : fail(new Error(`${command} exited with ${status}: ${text.slice(-2000)}`)); });
});

const server = await startEngine({ engine: 'jint', hostDir, distDir, logDir: resolve(out, 'logs') }, port, 'trace', { units: 1, serverGc: false, processorCount: 1 });
try {
  const [warmPath] = pickPaths(pathsDir, 'csharp-type', 1, 7);
  const warm = await get(`http://127.0.0.1:${port}${warmPath}`, Object.fromEntries(headers.map((header) => header.split(': '))));
  console.log(`warm page: ${warm.status}`);

  const duration = lead + seconds + 20;
  const load = loadgenAsync(['--url', `http://127.0.0.1:${port}`, '--paths-file', resolve(pathsDir, 'uniform-html.txt'), '--mode', 'load', '--connections', connections,
    '--duration', String(duration), '--warmup', '0', '--pid', String(server.pid), '--label', 'jint-trace', ...headers.flatMap((header) => ['--header', header]),
    '--server-affinity', serverMask, '--affinity', generatorCores, '--gc-stats', '/api/host'], resolve(out, 'load-trace.json'));
  await sleep(lead * 1000);

  const nettrace = resolve(out, 'jint.nettrace');
  const timeSpan = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':');
  console.log(`sampling for ${seconds} s with ${tool} (${profile})`);
  await run(tool, ['collect', '--process-id', String(server.pid), '--profile', profile, '--duration', timeSpan, '--output', nettrace], resolve(out, 'collect.json'));
  const result = await load;
  console.log(`load: ${round(result.report.requestsPerSecond)} rps, ${result.report.errors} errors, ${result.report.requests} requests`);

  await run(tool, ['convert', nettrace, '--format', 'speedscope', '--output', resolve(out, 'jint')], resolve(out, 'convert.json'));
  const speedscope = resolve(out, 'jint.speedscope.json');
  if (!existsSync(speedscope)) throw new Error(`The conversion did not write ${speedscope}`);
  const summary = summarizeSpeedscope(speedscope, { top: 40 });
  writeJson(resolve(out, 'trace-summary.json'), { startedUtc: new Date().toISOString(), profile, lead, seconds, connections: Number(connections), ...summary });
  printSummary(summary);
} finally {
  await server.stop();
}
