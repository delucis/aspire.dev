// Splits the routes of a hybrid-api-docs.json manifest into per-kind path files for the load generator.
// Usage: node make-paths.mjs <manifest.json> <outDir> [seed]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [manifestPath, outDir, seedArg = '42'] = process.argv.slice(2);
if (!manifestPath || !outDir) throw new Error('Usage: node make-paths.mjs <manifest.json> <outDir> [seed]');
mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Small seeded PRNG (mulberry32) so that the sampled files are reproducible.
let state = Number(seedArg) >>> 0;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = (list) => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const kinds = {};
const add = (kind, path) => (kinds[kind] ??= []).push(path);
for (const { html, markdown } of manifest.routes) {
  if (html) {
    const segments = html.split('/').filter(Boolean).slice(2); // drop "reference", "api"
    const [language, ...rest] = segments;
    const depth = rest.length;
    const name = { 1: 'package', 2: 'type', 3: 'member' }[depth];
    if (language === 'csharp') add(`csharp-${depth === 1 ? 'package' : depth === 2 ? 'type' : 'memberkind'}`, html);
    else if (language === 'typescript') add(`ts-${depth === 1 ? 'module' : depth === 2 ? 'item' : 'member'}`, html);
    else add(`other-${name ?? depth}`, html);
  }
  if (markdown) add(markdown.includes('/typescript/') ? 'ts-md' : 'csharp-md', markdown);
}

const write = (name, list) => writeFileSync(join(outDir, `${name}.txt`), list.join('\n') + '\n');
const summary = {};
for (const [kind, list] of Object.entries(kinds)) {
  write(kind, shuffle(list));
  summary[kind] = list.length;
}

const html = shuffle(Object.entries(kinds).filter(([k]) => !k.endsWith('-md')).flatMap(([, list]) => list));
write('all-html', html);
write('all-md', shuffle([...(kinds['csharp-md'] ?? []), ...(kinds['ts-md'] ?? [])]));

// Zipf(s=1) popularity over a random ranking of all HTML pages: a hot set that a cache can hold, with a long tail.
const ranked = shuffle(html);
const weights = ranked.map((_, i) => 1 / (i + 1));
const total = weights.reduce((a, b) => a + b, 0);
const cumulative = [];
weights.reduce((acc, w, i) => (cumulative[i] = acc + w / total), 0);
const pick = () => {
  const r = random();
  let lo = 0, hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < r) lo = mid + 1; else hi = mid;
  }
  return ranked[lo];
};
write('zipf-html', Array.from({ length: 20000 }, pick));
write('uniform-html', Array.from({ length: 20000 }, () => html[Math.floor(random() * html.length)]));

console.log(JSON.stringify({ routes: manifest.routes.length, kinds: summary, html: html.length }, null, 2));
