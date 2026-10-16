// Aggregates a speedscope profile written by `dotnet-trace convert --format speedscope`, where each thread is an "evented"
// profile of opened and closed frames, and every stack ends in a pseudo frame that says what the thread was doing:
// CPU_TIME (managed code), UNMANAGED_CODE_TIME (native code or a wait) or BLOCKED_TIME.
//
// The sampler (dotnet-sampled-thread-time, about 100 Hz) reports wall-clock time per thread. Idle thread-pool threads
// and threads parked in a wait show up as time too, so the engine is separated from them: the engine profile is every
// sample with an Acornima or Jint frame on the stack, and its total is checked against the length of the window. One
// engine on one core runs on one thread at a time, so that total should be close to the window.
//
//   node analyze-nettrace.mjs <file.speedscope.json> [--top 25]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PSEUDO_FRAMES = new Set(['CPU_TIME', 'UNMANAGED_CODE_TIME', 'BLOCKED_TIME']);
// R2R and jitted code are named with and without an ".il" module suffix; both are the same module.
const normalize = (name) => name.replace('.il!', '!');
const isEngine = (name) => /^(Jint|Acornima)[!.]/.test(name);
const round2 = (value) => Math.round(value * 100) / 100;

const withoutArguments = (name) => { const open = name.indexOf('('); return open > 0 ? name.slice(0, open) : name; };

/** `Jint!Jint.Runtime.Interpreter.Expressions.JintCallExpression.EvaluateInternal(...)` -> `Jint.Runtime.Interpreter.Expressions` */
function namespaceOf(name) {
  const bang = name.indexOf('!');
  const rest = withoutArguments(bang > 0 ? name.slice(bang + 1) : name).replace(/\[[^\]]*\]/g, '').replaceAll(/`\d+/g, '');
  const parts = rest.split('.');
  return parts.length > 2 ? parts.slice(0, -2).join('.') : rest;
}

/**
 * @param {string} path
 * @param {{ top?: number }} [options]
 */
export function summarizeSpeedscope(path, { top = 25 } = {}) {
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const names = file.shared.frames.map((frame) => normalize(frame.name));
  const engineFrame = names.map(isEngine);
  const add = (map, key, weight) => map.set(key, (map.get(key) ?? 0) + weight);

  const engine = { ms: 0, states: new Map(), self: new Map(), namespaces: new Map(), inclusive: new Map() };
  const other = { ms: 0, self: new Map() };
  let windowMs = 0;

  for (const profile of file.profiles) {
    if (profile.type !== 'evented') throw new Error(`Expected evented profiles, found "${profile.type}" in ${path}`);
    windowMs = Math.max(windowMs, profile.endValue - profile.startValue);
    const stack = [];
    let previous = profile.events[0]?.at ?? 0;
    for (const event of profile.events) {
      const elapsed = event.at - previous;
      if (elapsed > 0 && stack.length > 0) {
        const last = names[stack[stack.length - 1]];
        const state = PSEUDO_FRAMES.has(last) ? last : 'UNKNOWN';
        const selfName = withoutArguments(state === 'UNKNOWN' ? last : names[stack[stack.length - 2]] ?? last);
        if (stack.some((frame) => engineFrame[frame])) {
          engine.ms += elapsed;
          add(engine.states, state, elapsed);
          add(engine.self, selfName, elapsed);
          add(engine.namespaces, namespaceOf(selfName), elapsed);
          for (const frame of new Set(stack)) {
            const name = names[frame];
            if (!PSEUDO_FRAMES.has(name) && !name.startsWith('Thread (') && !name.startsWith('Process')) add(engine.inclusive, withoutArguments(name), elapsed);
          }
        } else {
          other.ms += elapsed;
          add(other.self, `${state} ${selfName}`, elapsed);
        }
      }
      previous = event.at;
      if (event.type === 'O') stack.push(event.frame); else stack.pop();
    }
  }

  const rank = (map, total) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([name, weight]) => ({ name, ms: Math.round(weight), percent: round2((weight / total) * 100) }));
  return {
    unit: file.profiles[0]?.unit ?? 'milliseconds',
    threads: file.profiles.length,
    windowMs: Math.round(windowMs),
    engine: {
      ms: Math.round(engine.ms),
      percentOfWindow: round2((engine.ms / windowMs) * 100),
      states: Object.fromEntries([...engine.states.entries()].map(([state, weight]) => [state, round2((weight / engine.ms) * 100)])),
      namespaces: rank(engine.namespaces, engine.ms),
      self: rank(engine.self, engine.ms),
      inclusive: rank(engine.inclusive, engine.ms),
    },
    other: { ms: Math.round(other.ms), self: rank(other.self, other.ms).slice(0, 8) },
  };
}

export function printSummary(summary) {
  const table = (title, rows) => {
    console.log(`\n${title}\n`);
    console.log('| Share | Time (ms) | Name |\n|---:|---:|---|');
    for (const row of rows) console.log(`| ${row.percent}% | ${row.ms} | ${row.name.replaceAll('|', '\\|')} |`);
  };
  const { engine, other } = summary;
  console.log(`Window ${summary.windowMs} ms over ${summary.threads} thread(s). Samples inside the engine: ${engine.ms} ms (${engine.percentOfWindow}% of the window); states ${JSON.stringify(engine.states)}. Other threads: ${other.ms} ms.`);
  table('Engine, by namespace of the running function (self time)', engine.namespaces);
  table('Engine, by function (self time)', engine.self);
  table('Engine, by function (inclusive time)', engine.inclusive);
  table('Other threads (self time, not part of the engine)', other.self);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node analyze-nettrace.mjs <file.speedscope.json> [--top 25]');
  const index = process.argv.indexOf('--top');
  printSummary(summarizeSpeedscope(file, { top: index > 0 ? Number(process.argv[index + 1]) : 25 }));
}
