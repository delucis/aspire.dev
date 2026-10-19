import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { loadEnv } from 'vite';
import { loadIncrementalBuildSettings } from '../config/incremental-build.mjs';
import { buildManifest, compareManifests } from './compare-builds.mjs';
import { captureQualificationInputs } from './qualification-inputs.mjs';

const rootUrl = new URL('../', import.meta.url);
const root = fileURLToPath(rootUrl);
const reportDirectory = join(root, '.cache', 'incremental-pilot');
const scenarios = ['warm', 'identity', 'api-data', 'global-input', 'og-input', 'partial-cache'];

/** @param {'clean' | 'full' | 'incremental'} kind */
export function buildArguments(kind) {
  if (!['clean', 'full', 'incremental'].includes(kind)) {
    throw new Error(`Unknown build kind: ${kind}`);
  }
  return ['build', '--mode', 'production', ...(kind === 'clean' ? ['--force'] : [])];
}

/** @param {string} log */
export function restoredPaths(log) {
  return [...stripVTControlCharacters(log).matchAll(/(\S+)\s+\((?:restored|cached)\)/g)].map(
    (match) => match[1]
  );
}

/** @param {string} log */
export function restoredRouteCounts(log) {
  const paths = restoredPaths(log);
  const markdownRestored = paths.filter((path) => /\.md\/?$/.test(path)).length;
  const ogRestored = paths.filter((path) => /^\/og\/.+\.png\/?$/.test(path)).length;
  return {
    htmlRestored: paths.length - markdownRestored - ogRestored,
    markdownRestored,
    ogRestored,
    totalRestored: paths.length,
  };
}

function compactChanges(items, limit = 20) {
  return { count: items.length, items: items.slice(0, limit) };
}

function compareRecords(previous = {}, current = {}) {
  const previousKeys = new Set(Object.keys(previous));
  const currentKeys = new Set(Object.keys(current));
  const added = [...currentKeys].filter((key) => !previousKeys.has(key)).sort();
  const removed = [...previousKeys].filter((key) => !currentKeys.has(key)).sort();
  const changed = [...currentKeys]
    .filter(
      (key) =>
        previousKeys.has(key) && JSON.stringify(previous[key]) !== JSON.stringify(current[key])
    )
    .sort();
  return {
    added: compactChanges(added),
    removed: compactChanges(removed),
    changed: compactChanges(changed),
  };
}

export function compareIncrementalDiagnostics(previous, current) {
  return {
    routes: compareRecords(previous?.routes, current?.routes),
    clientModules: compareRecords(previous?.modules?.client, current?.modules?.client),
    prerenderModules: compareRecords(previous?.modules?.prerender, current?.modules?.prerender),
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readIncrementalDiagnostics(cacheDir) {
  const manifest = await readJson(new URL('incremental-build.json', cacheDir));
  const routes = Object.fromEntries(
    Object.entries(manifest?.routes ?? {})
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([component, route]) => [
        component,
        {
          dependencyHash: route.dependencyHash,
          pathCount: Object.keys(route.paths).length,
        },
      ])
  );
  const modules = {};
  for (const environment of ['client', 'prerender']) {
    const records = await readJson(new URL(`dependency-modules-${environment}.json`, cacheDir));
    modules[environment] = Object.fromEntries(
      (records ?? []).map(({ id, codeHash, importsHash }) => [id, { codeHash, importsHash }])
    );
  }
  return { routes, modules };
}

/**
 * @param {string} log
 * @returns {{htmlFiles: number, parsedPages: number, reusedPages: number, wallMs: number}}
 */
export function identityFinalization(log) {
  const records = [
    ...stripVTControlCharacters(log).matchAll(
      /^\[incremental-build\] finalized identity (\{[^\r\n]+\})$/gm
    ),
  ];
  if (records.length !== 1) throw new Error('Expected one identity-finalization measurement.');
  const result = JSON.parse(records[0][1]);
  if (
    !['htmlFiles', 'parsedPages', 'reusedPages'].every(
      (key) => Number.isSafeInteger(result[key]) && result[key] >= 0
    ) ||
    result.parsedPages + result.reusedPages !== result.htmlFiles ||
    !Number.isFinite(result.wallMs) ||
    result.wallMs < 0
  ) {
    throw new Error('Invalid identity-finalization measurement.');
  }
  return result;
}

/**
 * @param {string} current
 * @param {string[]} candidates
 */
export function changedIdentity(current, candidates) {
  if (![current, ...candidates].every((value) => /^[a-f\d]{40}$/i.test(value))) {
    throw new Error('Identity qualification requires full git commit IDs.');
  }
  const identity = candidates.find((value) => value.toLowerCase() !== current.toLowerCase());
  if (!identity) throw new Error('Identity qualification requires a different real commit.');
  return identity;
}

export function textDifference(expected, actual, radius = 120) {
  let offset = 0;
  while (
    offset < expected.length &&
    offset < actual.length &&
    expected.charCodeAt(offset) === actual.charCodeAt(offset)
  ) {
    offset++;
  }
  const start = Math.max(0, offset - radius);
  return {
    offset,
    expected: expected.slice(start, offset + radius),
    actual: actual.slice(start, offset + radius),
  };
}

async function runPilot(scenario) {
  if (process.env.CI !== 'true')
    throw new Error('This multi-build qualification harness is CI-only.');
  if (!scenarios.includes(scenario)) throw new Error(`Unknown pilot scenario: ${scenario}`);
  if (process.env.ASTRO_OUT_DIR)
    throw new Error('The pilot requires the standard dist-hybrid output directory.');
  await mkdir(reportDirectory, { recursive: true });
  const inputSnapshot = join(reportDirectory, 'input-snapshot.json');
  await captureQualificationInputs(inputSnapshot);
  const buildEnv = loadEnv('production', root, ['PUBLIC_', 'GIT_COMMIT_ID']);
  const baselineIdentity = buildEnv.PUBLIC_GIT_COMMIT_ID || buildEnv.GIT_COMMIT_ID || '';
  const sourceDateEpoch =
    process.env.SOURCE_DATE_EPOCH ??
    execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  const measurements = [];

  async function build(label, kind, env = {}, requireReuse = false) {
    const incremental = kind === 'incremental';
    const cacheDir = incremental
      ? (await loadIncrementalBuildSettings(rootUrl, 'production')).cacheDir
      : undefined;
    const previousDiagnostics = cacheDir ? await readIncrementalDiagnostics(cacheDir) : undefined;
    const logPath = join(reportDirectory, `${label}.log`);
    const log = createWriteStream(logPath);
    const started = performance.now();
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            new URL('./qualification-inputs.mjs', import.meta.url).href,
            join(root, 'node_modules', 'astro', 'bin', 'astro.mjs'),
            ...buildArguments(kind),
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              ...env,
              ASPIRE_QUALIFICATION_INPUTS: inputSnapshot,
              SOURCE_DATE_EPOCH: sourceDateEpoch,
              ASPIRE_HYBRID_API_DOCS: '1',
              ASPIRE_INCREMENTAL_BUILD: incremental ? '1' : '0',
              ASPIRE_INCREMENTAL_DIAGNOSTICS: incremental ? '1' : '0',
              ASTRO_TELEMETRY_DISABLED: '1',
              BUILD_TIMING: '1',
              BUILD_TIMING_LABEL: label,
              BUILD_TIMING_OUT: join(reportDirectory, 'phases.jsonl'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        for (const stream of [child.stdout, child.stderr]) {
          stream.on('data', (chunk) => {
            log.write(chunk);
            process.stdout.write(chunk);
          });
        }
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code !== 0) reject(new Error(`${label} failed: exit=${code}, signal=${signal}`));
          else resolve();
        });
      });
    } finally {
      log.end();
      await finished(log);
    }
    const wallMs = performance.now() - started;
    const output = await readFile(logPath, 'utf8');
    const { htmlRestored, markdownRestored, ogRestored, totalRestored } =
      restoredRouteCounts(output);
    const identity = incremental ? identityFinalization(output) : undefined;
    const diagnostics = cacheDir
      ? compareIncrementalDiagnostics(
          previousDiagnostics,
          await readIncrementalDiagnostics(cacheDir)
        )
      : undefined;
    if (diagnostics) {
      console.log(
        `[incremental-build] cache diagnostics ${JSON.stringify({ label, ...diagnostics })}`
      );
      await writeFile(
        join(reportDirectory, `${label}-cache-diagnostics.json`),
        JSON.stringify(diagnostics, null, 2)
      );
    }
    measurements.push({
      label,
      kind,
      buildIdentity: env.PUBLIC_GIT_COMMIT_ID || baselineIdentity,
      sourceDateEpoch,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      wallMs,
      htmlRestored,
      markdownRestored,
      ogRestored,
      totalRestored,
      identityFinalization: identity,
    });
    await writeFile(
      join(reportDirectory, 'measurements.json'),
      JSON.stringify(measurements, null, 2)
    );
    if (requireReuse && !htmlRestored) {
      throw new Error(
        `${label}: expected prerendered hybrid HTML reuse; got ${htmlRestored}.`
      );
    }
    if (requireReuse && !identity?.reusedPages) {
      throw new Error(`${label}: expected exact-content identity range reuse.`);
    }
    if (requireReuse && !ogRestored) {
      throw new Error(`${label}: expected unchanged OG image reuse.`);
    }
    const manifest = await buildManifest(join(root, 'dist-hybrid'));
    await writeFile(join(reportDirectory, `${label}-manifest.json`), JSON.stringify(manifest));
    const diagnosticPaths = Object.keys(manifest).filter(
      (path) => path === 'hybrid-api-docs.json' || /^server\/chunks\/.+\.mjs$/.test(path)
    );
    const diagnosticText = Object.fromEntries(
      await Promise.all(
        diagnosticPaths.map(async (path) => [
          path,
          await readFile(join(root, 'dist-hybrid', path), 'utf8'),
        ])
      )
    );
    const hybrid = JSON.parse(
      await readFile(join(root, 'dist-hybrid', 'hybrid-api-docs.json'), 'utf8')
    );
    return {
      files: manifest,
      routes: hybrid.routes,
      diagnosticText,
    };
  }

  async function equivalent(label, expected, actual) {
    const differences = compareManifests(expected.files, actual.files);
    await writeFile(
      join(reportDirectory, `${label}-diff.json`),
      JSON.stringify(differences, null, 2)
    );
    if (Object.values(differences).some((paths) => paths.length)) {
      for (const [kind, paths] of Object.entries(differences)) {
        console.error(
          `[incremental-pilot] ${label} ${kind}: ${paths.length}; first paths: ${paths.slice(0, 10).join(', ')}`
        );
      }
      for (const path of differences.changed.slice(0, 5)) {
        const expectedText = expected.diagnosticText[path];
        const actualText = actual.diagnosticText[path];
        if (expectedText !== undefined && actualText !== undefined) {
          console.error(
            `[incremental-pilot] ${label} text difference ${JSON.stringify({
              path,
              ...textDifference(expectedText, actualText),
            })}`
          );
        }
      }
      throw new Error(
        `${label}: output differs; see ${label}-diff.json. No normalization is allowed.`
      );
    }
  }

  const clean = await build('clean', 'clean');
  await equivalent('clean-repeat', clean, await build('clean-repeat', 'clean'));
  if (['warm', 'api-data'].includes(scenario)) {
    await equivalent('full-warm', clean, await build('full-warm', 'full'));
  }
  await equivalent('incremental-first', clean, await build('incremental-first', 'incremental'));
  await equivalent(
    'incremental-warm',
    clean,
    await build('incremental-warm', 'incremental', {}, true)
  );
  if (scenario === 'warm') {
    await equivalent(
      'incremental-warm-repeat',
      clean,
      await build('incremental-warm-repeat', 'incremental', {}, true)
    );
    await equivalent('full-warm-repeat', clean, await build('full-warm-repeat', 'full'));
  }

  let restoreSource;
  let mutationPrefix;
  function commitFixture(path, message) {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Copilot App',
        '-c',
        'user.email=223556219+Copilot@users.noreply.github.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--only',
        '-m',
        message,
        '-m',
        'Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>',
        '--',
        path,
      ],
      { cwd: root, stdio: 'pipe' }
    );
  }
  const contentProbe = 'Incremental cache sibling edit probe.';
  try {
    const env = {};
    if (scenario === 'identity') {
      const candidates = execFileSync('git', ['rev-list', '--max-count=2', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/);
      env.PUBLIC_GIT_COMMIT_ID = changedIdentity(baselineIdentity, candidates);
      console.log(
        `[incremental-pilot] identity: ${baselineIdentity} -> ${env.PUBLIC_GIT_COMMIT_ID}`
      );
    } else if (scenario === 'api-data') {
      const directory = join(root, 'src', 'data', 'pkgs');
      let selected;
      for (const name of (await readdir(directory)).sort()) {
        if (!name.endsWith('.json')) continue;
        const path = join(directory, name);
        const original = await readFile(path, 'utf8');
        const data = JSON.parse(original);
        if (data.types?.filter((type) => type.name).length >= 3) {
          selected = { path, original, data };
          break;
        }
      }
      if (!selected) throw new Error('No API package supports the mutation fixture.');
      const { path, original, data } = selected;
      let committed = false;
      restoreSource = async () => {
        await writeFile(path, original);
        if (committed) commitFixture(path, 'Restore incremental API qualification fixture');
      };
      const [renamed, removed, edited] = data.types.filter((type) => type.name);
      renamed.name += 'IncrementalProbe';
      renamed.fullName = `${renamed.namespace}.${renamed.name}`;
      edited.docs = { ...edited.docs, summary: [{ kind: 'text', text: contentProbe }] };
      mutationPrefix = `/reference/api/csharp/${data.package.name.toLowerCase()}/`;
      data.types = data.types.filter((type) => type !== removed);
      data.types.push({
        ...structuredClone(renamed),
        name: 'IncrementalAddedProbe',
        fullName: `${renamed.namespace}.IncrementalAddedProbe`,
      });
      await writeFile(path, JSON.stringify(data, null, 2));
      commitFixture(path, 'Exercise incremental reuse across a real API-data commit');
      committed = true;
      console.log(`[incremental-pilot] API add/delete/rename/sibling mutation: ${path}`);
    } else if (scenario === 'global-input') {
      const path = join(root, 'src', 'styles', 'site.css');
      const original = await readFile(path, 'utf8');
      restoreSource = () => writeFile(path, original);
      await writeFile(path, original + '\n:root { --incremental-pilot-probe: 1; }\n');
    } else if (scenario === 'og-input') {
      const path = join(root, 'public', 'og-image.png');
      const original = await readFile(path);
      restoreSource = () => writeFile(path, original);
      const { default: sharp } = await import('sharp');
      await writeFile(path, await sharp(original).negate({ alpha: false }).png().toBuffer());
    } else if (scenario === 'partial-cache') {
      const { cacheDir } = await loadIncrementalBuildSettings(rootUrl, 'production');
      const manifest = JSON.parse(
        await readFile(new URL('incremental-build.json', cacheDir), 'utf8')
      );
      const entries = Object.values(manifest.routes).flatMap((route) => Object.values(route.paths));
      for (const prefix of ['reference/api/', 'og/']) {
        const entry = entries.find((entry) =>
          prefix === 'og/'
            ? /(?:^|\/)og\/.+\.png$/.test(entry.outputFile)
            : entry.outputFile.endsWith('.html')
        );
        if (!entry || entry.outputFile.includes('..')) {
          throw new Error('Refusing to remove an unexpected cached output path.');
        }
        await rm(new URL(entry.outputFile, new URL('dist/', cacheDir)));
        console.log(`[incremental-pilot] Removed one cached output: ${entry.outputFile}`);
      }
    }
    if (scenario !== 'warm') {
      const expected = await build(`${scenario}-clean`, 'clean', env);
      if (scenario === 'api-data') {
        await equivalent(
          `${scenario}-full`,
          expected,
          await build(`${scenario}-full`, 'full', env)
        );
      }
      if (
        scenario === 'identity' &&
        !compareManifests(clean.files, expected.files).changed.some((path) =>
          path.endsWith('.html')
        )
      ) {
        throw new Error('The changed build identity must change rendered HTML.');
      }
      if (scenario === 'api-data') {
        const differences = compareManifests(clean.files, expected.files);
        const previousRoutes = new Set(clean.routes.flatMap(({ html, markdown }) => [html, markdown]));
        const currentRoutes = new Set(
          expected.routes.flatMap(({ html, markdown }) => [html, markdown])
        );
        if (
          ![...previousRoutes].some(
            (path) => path?.startsWith(mutationPrefix) && !currentRoutes.has(path)
          ) ||
          ![...currentRoutes].some(
            (path) => path?.startsWith(mutationPrefix) && !previousRoutes.has(path)
          ) ||
          !differences.changed.some((path) => path.startsWith('server/'))
        ) {
          throw new Error(
            'The API mutation must update the hybrid route catalog and renderer artifact.'
          );
        }
      }
      if (
        scenario === 'og-input' &&
        !compareManifests(clean.files, expected.files).changed.some((path) =>
          /(?:^|\/)og\//.test(path)
        )
      ) {
        throw new Error('The background fixture must change generated OG images.');
      }
      const globalInvalidation = ['global-input', 'og-input'].includes(scenario);
      const actual = await build(
        `${scenario}-incremental`,
        'incremental',
        env,
        !globalInvalidation
      );
      await equivalent(scenario, expected, actual);
      if (
        globalInvalidation &&
        (measurements.at(-1).htmlRestored !== 0 || measurements.at(-1).ogRestored !== 0)
      ) {
        throw new Error('A global input change must invalidate the compatibility partition.');
      }
    }
  } finally {
    await restoreSource?.();
  }
  console.log(
    `[incremental-pilot] ${scenario}: byte-equivalent complete hybrid output; production remains opt-out.`
  );
}

if (import.meta.main) await runPilot(process.argv[2] || 'warm');
