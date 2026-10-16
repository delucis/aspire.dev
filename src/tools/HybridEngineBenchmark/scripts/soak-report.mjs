// Prints a soak run (the output of soak.mjs) the way the report shows it: window rows with the counters interpolated to the
// window edges, the ramp-up and the steady part summed separately, and the live-set timeline of a growth probe.
//
//   node soak-report.mjs <soak-label.json> [--window 15] [--steady-from 60]
import { readFileSync } from 'node:fs';
import { round, soakWindows } from './lib.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const file = process.argv[2];
if (!file || file.startsWith('--')) throw new Error('usage: node soak-report.mjs <soak-label.json> [--window 15] [--steady-from 60]');
const soak = JSON.parse(readFileSync(file, 'utf8'));
const windowSeconds = Number(arg('window', 15));
const steadyFrom = Number(arg('steady-from', 60));
const jint = soak.engine === 'jint';
const rows = soakWindows({ samples: soak.samples, timeline: soak.timeline, windowSeconds, engine: soak.engine });

function table(columns, data) {
  console.log(`| ${columns.map(([title]) => title).join(' | ')} |`);
  console.log(`|${columns.map(() => '---').join('|')}|`);
  for (const row of data) console.log(`| ${columns.map(([, pick]) => pick(row)).join(' | ')} |`);
  console.log();
}

function sum(part) {
  const seconds = part.reduce((total, row) => total + row.toSecond - row.fromSecond, 0);
  const requests = part.reduce((total, row) => total + row.requests, 0);
  const cpuSeconds = part.reduce((total, row) => total + row.serverCores * (row.toSecond - row.fromSecond), 0);
  const result = { seconds, requests, rps: round(requests / seconds, 1), serverCores: round(cpuSeconds / seconds, 2), cpuMsPerRequest: round((cpuSeconds * 1000) / requests, 1) };
  if (jint) {
    result.gcPausePercent = round(part.reduce((total, row) => total + row.gcPausePercent * (row.toSecond - row.fromSecond), 0) / seconds, 1);
    result.allocatedMbPerRequest = round(part.reduce((total, row) => total + row.allocatedMbPerRequest * row.requests, 0) / requests, 1);
  }
  return result;
}

console.log(`${soak.label}: ${soak.engine}, ${soak.durationSeconds} s, ${soak.connections} connections, ${soak.mix}, first page ${soak.firstPageMs} ms, ready ${soak.readyMs} ms\n`);

const columns = [
  ['Seconds', (row) => `${row.fromSecond} to ${row.toSecond}`], ['Requests', (row) => row.requests], ['rps', (row) => row.rps], ['Cores', (row) => row.serverCores],
  ['CPU ms/request', (row) => row.cpuMsPerRequest], ['RSS MB', (row) => row.rssMb], ['Heap MB', (row) => row.heapMb],
];
if (jint) columns.push(['GC pause %', (row) => row.gcPausePercent], ['MB/request', (row) => row.allocatedMbPerRequest], ['gen0/1/2', (row) => `${row.gen0}/${row.gen1}/${row.gen2}`], ['JIT methods', (row) => row.jitMethods], ['JIT ms', (row) => row.jitMs]);
table(columns, rows);

const ramp = rows.filter((row) => row.toSecond <= steadyFrom);
const steady = rows.filter((row) => row.fromSecond >= steadyFrom);
const parts = [['whole run', rows], ...(ramp.length && steady.length ? [[`seconds 0 to ${steadyFrom}`, ramp], [`seconds ${steadyFrom} to ${rows.at(-1).toSecond}`, steady]] : [])];
const summaryColumns = [['Part', (entry) => entry[0]], ['Requests', (entry) => entry[2].requests], ['rps', (entry) => entry[2].rps], ['Cores', (entry) => entry[2].serverCores], ['CPU ms/request', (entry) => entry[2].cpuMsPerRequest]];
if (jint) summaryColumns.push(['GC pause %', (entry) => entry[2].gcPausePercent], ['MB/request', (entry) => entry[2].allocatedMbPerRequest]);
table(summaryColumns, parts.map(([name, part]) => [name, part, sum(part)]));

const rates = steady.map((row) => row.rps);
if (rates.length) console.log(`steady windows: rps min ${Math.min(...rates)}, max ${Math.max(...rates)}, mean of windows ${round(rates.reduce((a, b) => a + b, 0) / rates.length, 1)}\n`);

const live = (entry, label) => ({ label, requests: entry.requests ?? '', liveMb: entry.liveMb, committedMb: entry.committedMb, rssMb: entry.rssMb });
const liveRows = [live({ ...soak.liveBefore, requests: 0 }, 'before the load'), ...(soak.liveTimeline ?? []).map((entry) => live(entry, `t=${entry.t} s`)), live({ ...soak.liveAfter, requests: soak.load.requests }, 'after the load')];
table([['Live set read', (row) => row.label], ['Requests so far', (row) => row.requests], ['Live MB', (row) => row.liveMb], ['Committed MB', (row) => row.committedMb], ['RSS MB', (row) => row.rssMb]], liveRows);
