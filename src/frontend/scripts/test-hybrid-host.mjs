import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'dist-hybrid/hybrid-api-docs.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const children = [];
let output = '';

function launch(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && command === 'pnpm' });
  children.push(child);
  child.on('error', (error) => { output += `${command}: ${error.message}\n`; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data.toString(); });
  return child;
}

async function ready(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch (error) {
      if (children.some((child) => child.exitCode !== null)) throw new Error(`POC process exited: ${output}`, { cause: error });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`POC endpoint did not become ready: ${url}\n${output}`);
}

const workerUrl = 'http://127.0.0.1:14323';
const standbyUrl = 'http://127.0.0.1:14325';
const hostUrl = 'http://127.0.0.1:14324';
const measures = {};
try {
  const worker = launch(process.execPath, ['scripts/serve-api-docs.mjs'], {
    ...process.env, PORT: '14323', HYBRID_API_DOCS_MANIFEST: manifestPath,
  });
  const standby = launch(process.execPath, ['scripts/serve-api-docs.mjs'], {
    ...process.env, PORT: '14325', HYBRID_API_DOCS_MANIFEST: manifestPath,
  });
  await ready(`${workerUrl}/__hybrid-api-docs/health`);
  await ready(`${standbyUrl}/__hybrid-api-docs/health`);
  launch('dotnet', [resolve(root, '../statichost/StaticHost/bin/Release/net10.0/StaticHost.dll')], {
    ...process.env,
    ASPNETCORE_URLS: hostUrl,
    ASPNETCORE_ENVIRONMENT: 'Production',
    HybridApiDocs__ArtifactPath: manifestPath,
    HybridApiDocs__RendererUrls__0: workerUrl,
    HybridApiDocs__RendererUrls__1: standbyUrl,
    Live__Twitch__ClientId: '',
    Live__YouTube__ApiKey: '',
  });
  await ready(`${hostUrl}/healthz`);
  await ready(`${hostUrl}/healthz/api-docs`);
  const stats = async () => (await fetch(`${workerUrl}/__hybrid-api-docs/health`)).json();
  async function page(path, init = {}) {
    const start = performance.now();
    const response = await fetch(hostUrl + path, { ...init, signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    assert.equal(response.status, 200, `${path}: ${response.status}\n${text.slice(0, 500)}\n${output}`);
    measures[path] ??= [];
    measures[path].push(Math.round((performance.now() - start) * 100) / 100);
    return { response, text };
  }
  const initial = await stats();
  const home = await page('/');
  assert.ok(!home.text.includes('<title>Aspire Static Host</title>'), 'The placeholder wwwroot home must not shadow the hybrid homepage.');
  await page('/docs/');
  assert.equal((await stats()).requests, initial.requests);
  const csharp = await page('/reference/api/csharp/');
  assert.equal(csharp.response.headers.get('X-Astro-Cache'), 'MISS');
  assert.equal(csharp.response.headers.get('Cache-Control'), 'no-store');
  const cold = await stats();
  assert.equal(cold.cacheMisses, initial.cacheMisses + 1);
  const csharpHit = await page('/reference/api/csharp/');
  assert.equal(csharpHit.text, csharp.text);
  assert.equal(csharpHit.response.headers.get('X-Astro-Cache'), 'HIT');
  assert.equal((await stats()).requests, cold.requests + 1, 'StaticHost must forward cache hits to Astro.');
  assert.equal((await stats()).cacheMisses, cold.cacheMisses);
  const directHit = await fetch(`${workerUrl}/reference/api/csharp/`, {
    headers: { Host: 'aspire.dev', 'X-Forwarded-Host': 'aspire.dev', 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(directHit.headers.get('X-Astro-Cache'), 'HIT', 'The same response must be cached in Astro itself.');
  assert.equal(await directHit.text(), csharp.text);
  const credentialRequest = await page('/reference/api/csharp/', { headers: { Authorization: 'Bearer poc-test' } });
  assert.equal(credentialRequest.response.headers.get('X-Astro-Cache'), null);
  assert.equal((await page('/reference/api/csharp/')).response.headers.get('X-Astro-Cache'), 'HIT');
  const typescript = await page('/reference/api/typescript/');
  assert.ok(Buffer.byteLength(typescript.text) >= 13_621_124);
  assert.equal(Number(typescript.response.headers.get('content-length')), Buffer.byteLength(typescript.text));
  for (const language of ['csharp', 'typescript']) {
    const route = manifest.routes.find(({ html }) => html?.startsWith(`/reference/api/${language}/`) && html.split('/').length >= 7);
    assert.ok(route);
    const detail = await page(route.html);
    assert.equal(detail.response.headers.get('X-Astro-Cache'), 'MISS');
    const before = await stats();
    const pages = await Promise.all(Array.from({ length: 20 }, () => page(route.html)));
    assert.ok(pages.every(({ text, response }) => text === detail.text && response.headers.get('X-Astro-Cache') === 'HIT'));
    assert.equal((await stats()).requests, before.requests + 20);
    assert.equal((await stats()).cacheMisses, before.cacheMisses);
    const direct = await page(route.markdown);
    assert.equal(direct.response.headers.get('X-Astro-Cache'), 'MISS');
    const negotiated = await page(route.html, { headers: { Accept: 'text/markdown' } });
    assert.equal(negotiated.response.headers.get('X-Astro-Cache'), 'HIT');
    assert.equal(negotiated.text, direct.text);
    assert.ok(negotiated.response.headers.get('cache-control').includes('private'));
    assert.ok(pages[0].response.headers.get('link').includes(route.markdown));
  }
  const unknown = await fetch(`${hostUrl}/reference/api/not-a-page/`);
  assert.equal(unknown.status, 404);
  if (process.env.HYBRID_TEST_BROWSER === '1') {
    const install = launch('pnpm', ['exec', 'playwright', 'install', '--with-deps', 'chromium'], process.env);
    assert.equal((await once(install, 'exit'))[0], 0, output.slice(-10000));
    const browser = launch('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.hybrid.config.mjs'],
      { ...process.env, HYBRID_TEST_URL: hostUrl });
    assert.equal((await once(browser, 'exit'))[0], 0, output.slice(-10000));
  }
  const final = await stats();
  const stopped = once(worker, 'exit');
  worker.kill();
  await stopped;
  await page('/docs/');
  const failover = await page('/reference/api/csharp/');
  assert.equal(failover.response.headers.get('X-Astro-Cache'), 'MISS', 'The standby owns its own native cache.');
  assert.equal((await page('/reference/api/csharp/')).response.headers.get('X-Astro-Cache'), 'HIT');
  assert.equal((await fetch(`${hostUrl}/healthz/api-docs`)).status, 200);
  const standbyStopped = once(standby, 'exit');
  standby.kill();
  await standbyStopped;
  const previouslyCached = await fetch(`${hostUrl}/reference/api/csharp/`);
  assert.equal(previouslyCached.status, 502, 'No ASP.NET cache may hide loss of every renderer.');
  assert.equal((await fetch(`${hostUrl}/healthz/api-docs`)).status, 503);
  await page('/docs/');
  const unwarmed = manifest.routes.find(({ html }) => html && !measures[html]);
  assert.ok(unwarmed);
  const failure = await fetch(hostUrl + unwarmed.html);
  assert.equal(failure.status, 502);
  const results = { success: true, cacheOwner: 'astro-memory', primaryOutageFailover: true, buildId: manifest.buildId, measures, initial, final };
  await writeFile(resolve(root, 'hybrid-host-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await writeFile(resolve(root, 'hybrid-host-processes.log'), output);
}
