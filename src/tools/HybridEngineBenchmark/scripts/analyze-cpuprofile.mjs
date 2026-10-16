// Summarises a V8 .cpuprofile (from Node's --cpu-prof or the DevTools Profiler domain): where the self time went,
// by area, by package or source module, by file and by function.
//
// Usage: node analyze-cpuprofile.mjs <file.cpuprofile> [topN] [--server <dir>]
//
// The bundler merges many modules into one chunk, so a chunk name says little. Every chunk carries "//#region <path>"
// markers, though. With --server <dir> (the "server" folder of the build that produced the profile), each frame is
// attributed to the source module that its line belongs to.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Maps a call frame to a coarse area. Chunk names come from the bundler, so they are matched loosely. */
export function areaOf({ functionName, url }) {
  if (functionName === '(garbage collector)') return 'V8 garbage collection';
  if (functionName === '(idle)') return 'idle';
  if (functionName === '(program)' || functionName === '(root)') return 'native / program';
  if (!url) return 'V8 builtins and native';
  if (url.startsWith('wasm:')) return 'WebAssembly (Shiki Oniguruma regex engine)';
  if (url.startsWith('node:')) return 'Node internals (http, streams, fs, url)';
  const file = decodeURIComponent(url.replace(/^file:\/\/\/?/, '')).replace(/\\/g, '/');
  if (/node_modules\/(?:\.pnpm\/)?(?:@astrojs\+starlight|@astrojs\/starlight)/.test(file) || /starlight/i.test(basename(file))) return 'Starlight';
  if (/expressive-code|shiki|twoslash|ec\.config/i.test(file)) return 'Expressive Code / highlighting';
  if (/node_modules\/(?:\.pnpm\/)?(?:astro|@astrojs)/.test(file) || /\/chunks\/astro\//.test(file) || /(?:^|\/)(?:entry|manifest|renderers|noop-middleware|astro-designed-error-pages|_astro-internal)/.test(file)) return 'Astro runtime';
  if (/data-layer|content-layer|content\.config|data-store|_astro-content|astro_content/i.test(file)) return 'content layer / data store';
  if (/hast|unist|vfile|rehype|remark|mdast|micromark|devalue|zod|html-escaper|cssesc|clsx/.test(file)) return 'libraries (hast, zod, devalue, ...)';
  if (/\/server\/(?:pages|chunks)\//.test(file) || /\/src\//.test(file)) return 'site code (pages, components, utils)';
  if (/node_modules/.test(file)) return 'other packages';
  return 'other';
}

/** Reads the "//#region" markers of bundled chunks, lazily, and answers which source module owns a line. */
export function createRegionResolver(serverRoot) {
  const cache = new Map();
  const regionsOf = (chunkPath) => {
    if (cache.has(chunkPath)) return cache.get(chunkPath);
    let regions = null;
    if (existsSync(chunkPath)) {
      regions = [];
      let open = null;
      readFileSync(chunkPath, 'utf8').split('\n').forEach((line, index) => {
        if (line.startsWith('//#region ')) open = { start: index, path: line.slice('//#region '.length).trim() };
        else if (line.startsWith('//#endregion') && open) {
          regions.push({ ...open, end: index });
          open = null;
        }
      });
    }
    cache.set(chunkPath, regions);
    return regions;
  };
  return (url, lineNumber) => {
    const file = decodeURIComponent(url.replace(/^file:\/\/\/?/, '')).replace(/\\/g, '/');
    const marker = file.lastIndexOf('/server/');
    if (marker < 0) return undefined;
    const regions = regionsOf(join(serverRoot, file.slice(marker + '/server/'.length)));
    if (!regions?.length) return undefined;
    let low = 0;
    let high = regions.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const region = regions[middle];
      if (lineNumber < region.start) high = middle - 1;
      else if (lineNumber > region.end) low = middle + 1;
      else return region.path;
    }
    return undefined;
  };
}

/** The package, or the folder of the site, that a region path belongs to. */
export function packageOfRegion(region) {
  const pnpm = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(region);
  if (pnpm) return pnpm[2];
  const plain = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(region);
  if (plain) return plain[1];
  return region.split('/').slice(0, -1).slice(0, 3).join('/') || region;
}

/** Maps the source module of a region to an area that tells where a render spends its time. */
export function areaOfRegion(region) {
  if (region.startsWith('src/')) {
    return /^src\/(?:components\/api-reference|pages\/reference|utils)\//.test(region)
      ? 'Site: API reference pages, components, data helpers'
      : 'Site: Starlight overrides and shared components';
  }
  const pkg = packageOfRegion(region);
  if (pkg === '@astrojs/starlight' || pkg.startsWith('starlight')) return 'Starlight (page chrome, routes, i18n)';
  if (pkg === 'astro' || pkg.startsWith('@astrojs/')) return 'Astro render pipeline';
  if (/expressive-code|^shiki$|^@shikijs\/|^postcss|^cssesc$|^@ctrl\/tinycolor$|twoslash|^oniguruma/.test(pkg)) return 'Syntax highlighting (Expressive Code, Shiki, PostCSS)';
  return 'Libraries (zod, hast, devalue, ...)';
}

/**
 * @param {any} profile
 * @param {{ topN?: number, serverRoot?: string }} [options]
 */
export function summarizeProfile(profile, options = {}) {
  const topN = options.topN ?? 25;
  const resolveRegion = options.serverRoot ? createRegionResolver(options.serverRoot) : undefined;
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfMicroseconds = new Map();
  profile.samples.forEach((id, index) => {
    const delta = profile.timeDeltas[index] ?? 0;
    selfMicroseconds.set(id, (selfMicroseconds.get(id) ?? 0) + delta);
  });
  const total = [...selfMicroseconds.values()].reduce((sum, value) => sum + value, 0);
  const byArea = new Map();
  const byPackage = new Map();
  const byFile = new Map();
  const byFunction = new Map();
  for (const [id, microseconds] of selfMicroseconds) {
    const frame = nodes.get(id).callFrame;
    const region = resolveRegion && frame.url ? resolveRegion(frame.url, frame.lineNumber) : undefined;
    const area = region ? areaOfRegion(region) : areaOf(frame);
    byArea.set(area, (byArea.get(area) ?? 0) + microseconds);
    if (region) byPackage.set(packageOfRegion(region), (byPackage.get(packageOfRegion(region)) ?? 0) + microseconds);
    const file = frame.url ? decodeURIComponent(frame.url.replace(/^file:\/\/\/?/, '')).replace(/\\/g, '/').split('/').slice(-2).join('/') : frame.functionName;
    byFile.set(file, (byFile.get(file) ?? 0) + microseconds);
    const key = `${frame.functionName || '(anonymous)'} @ ${file}:${frame.lineNumber + 1}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + microseconds);
  }
  const rank = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, topN)
    .map(([name, microseconds]) => ({ name, ms: Math.round(microseconds / 1000), percent: Math.round(microseconds / total * 1000) / 10 }));
  const busy = total - (selfMicroseconds.get([...nodes.values()].find((n) => n.callFrame.functionName === '(idle)')?.id) ?? 0);
  return {
    sampledMs: Math.round(total / 1000),
    busyMs: Math.round(busy / 1000),
    areas: rank(byArea),
    packages: rank(byPackage),
    files: rank(byFile),
    functions: rank(byFunction),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const serverIndex = args.indexOf('--server');
  const serverRoot = serverIndex >= 0 ? args.splice(serverIndex, 2)[1] : undefined;
  const summary = summarizeProfile(JSON.parse(readFileSync(args[0], 'utf8')), { topN: Number(args[1] ?? 25), serverRoot });
  console.log(`sampled ${summary.sampledMs} ms, busy ${summary.busyMs} ms`);
  for (const [title, rows] of [['AREAS', summary.areas], ['PACKAGES', summary.packages], ['FILES', summary.files], ['FUNCTIONS', summary.functions]]) {
    if (!rows.length) continue;
    console.log(`\n${title}`);
    for (const row of rows) console.log(`  ${String(row.percent).padStart(5)}%  ${String(row.ms).padStart(7)} ms  ${row.name}`);
  }
}
