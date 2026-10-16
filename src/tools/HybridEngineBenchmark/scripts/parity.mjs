// Output parity of the two engines: renders the same sampled paths on the Node sidecar renderer and on the Jint host and
// compares the status and the body, so a speed difference is never mistaken for a rendering difference. A body counts as
// identical when it matches byte for byte, or after build noise is normalized. The response headers of each engine are
// listed in the report and are not compared.
//
//   node parity.mjs --renderer <node renderer dir> --host <JintHost dir> --dist <jint build dir> --paths <paths dir>
//                   --out <results dir> [--per-kind 40] [--kinds csharp-type,ts-item,...] [--port 4330]
//
// The report in results/parity used --per-kind 25.
//
// With --node-url and --jint-url the same paths are requested from two deployed sites instead of local engines, so
// --renderer, --host and --dist are not needed. The Host header is left alone because App Service routes on it, and the
// report is written to parity-sites.json.
//
//   node parity.mjs --node-url http://<node site> --jint-url http://<jint site> --paths <paths dir> --out <results dir>
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { diff } from 'node:util';
import { pickPaths, round, startEngine, writeJson } from './lib.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const pathsDir = resolve(arg('paths'));
const out = resolve(arg('out'));
const perKind = Number(arg('per-kind', 40));
const port = Number(arg('port', 4330));
const kinds = arg('kinds', 'csharp-package,csharp-type,csharp-memberkind,ts-module,ts-item,ts-member,csharp-md,ts-md').split(',');
const remote = { node: arg('node-url')?.replace(/\/$/, ''), jint: arg('jint-url')?.replace(/\/$/, '') };
const isRemote = Boolean(remote.node && remote.jint);
const requestHeaders = isRemote
  ? { 'accept-encoding': 'identity' }
  : { host: 'aspire.dev', 'x-forwarded-host': 'aspire.dev', 'x-forwarded-proto': 'https', 'x-aspire-cache-bypass': '1', 'accept-encoding': 'identity' };
const volatileHeaders = new Set(['date', 'server', 'x-powered-by', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);
mkdirSync(out, { recursive: true });

const fetchFull = (url) => new Promise((done, fail) => {
  const send = url.startsWith('https:') ? httpsRequest : httpRequest;
  const req = send(url, { headers: requestHeaders, agent: false, timeout: 120000 }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', fail);
  req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
  req.end();
});

const excerpt = (buffer, at) => buffer.subarray(Math.max(0, at - 70), at + 110).toString('utf8').replace(/\s+/g, ' ');

/**
 * The two engines run two separate builds of the same site sources, one from the POC workflow on Windows and one from the
 * Jint workflow on Linux, so some tokens differ for reasons unrelated to rendering:
 * Astro derives scoped-style class names (astro-xxxxxxxx, data-astro-cid-xxxxxxxx) and asset file hashes per build, and the
 * Windows CI build inlines SVG sources with CRLF line endings while the Linux build uses LF. Hashes are renamed in order of
 * first appearance and line endings are unified, so that only differences in the rendered markup remain.
 */
function normalizeBuildNoise(text) {
  const scopes = new Map();
  const scope = (hash) => { if (!scopes.has(hash)) scopes.set(hash, `s${scopes.size + 1}`); return scopes.get(hash); };
  return text
    .replace(/\r\n/g, '\n')
    .replace(/(astro-(?:cid-)?)([a-z0-9]{8})\b/g, (_, prefix, hash) => `${prefix}${scope(hash)}`)
    .replace(/((?:\/|%2F)_astro(?:\/|%2F)[^"'\s?#)&]*?)\.[A-Za-z0-9_-]{8}\.(css|js|mjs|woff2?|png|jpe?g|svg|webp|avif)\b/gi, '$1.#.$2');
}

/** Trims what two strings have in common and keeps a little context, so a hunk shows only what is different. */
function shrink(left, right) {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  const cut = (value) => `${start > 24 ? '…' : ''}${value.slice(Math.max(0, start - 24), value.length - end + 24)}${end > 24 ? '…' : ''}`.replace(/\s+/g, ' ');
  return [cut(left), cut(right)];
}

/** Differing tags/text between two documents, as a token diff (a hunk is a run of removed and added tokens). */
function tokenDiff(nodeText, jintText, limit = 6) {
  const tokenize = (text) => text.split(/(?<=>)/);
  const hunks = [];
  let hunk;
  // util.diff reports what only the first argument has as an insert (1) and what only the second has as a removal (-1).
  for (const [op, value] of diff(tokenize(nodeText), tokenize(jintText))) {
    if (op === 0) { hunk = undefined; continue; }
    if (!hunk) { hunk = { removedFromNode: [], addedByJint: [] }; hunks.push(hunk); }
    (op > 0 ? hunk.removedFromNode : hunk.addedByJint).push(value);
  }
  const describe = (entry) => {
    const removed = entry.removedFromNode.join('');
    const added = entry.addedByJint.join('');
    const [node, jint] = shrink(removed, added);
    return { removedChars: removed.length, addedChars: added.length, node: node.slice(0, 300), jint: jint.slice(0, 300) };
  };
  return { hunkCount: hunks.length, hunks: hunks.slice(0, limit).map(describe) };
}

const logDir = resolve(out, 'logs');
const nodeServer = isRemote ? undefined : await startEngine({ engine: 'node', rendererDir: resolve(arg('renderer')), logDir }, port, 'parity-node');
const jintServer = isRemote ? undefined : await startEngine({ engine: 'jint', hostDir: resolve(arg('host')), distDir: resolve(arg('dist')), logDir }, port + 1, 'parity-jint');
const base = isRemote ? remote : { node: `http://127.0.0.1:${port}`, jint: `http://127.0.0.1:${port + 1}` };

const report = { startedUtc: new Date().toISOString(), perKind, kinds: {}, headers: {} };
const headerValues = { node: new Map(), jint: new Map() };
const noteHeaders = (engine, headers) => {
  for (const [name, value] of Object.entries(headers)) {
    if (volatileHeaders.has(name)) continue;
    const values = headerValues[engine].get(name) ?? new Set();
    if (values.size < 6) values.add(Array.isArray(value) ? value.join(', ') : value);
    headerValues[engine].set(name, values);
  }
};

for (const kind of kinds) {
  const paths = pickPaths(pathsDir, kind, perKind, 11);
  const row = { compared: 0, identical: 0, identicalAfterBuildNoise: 0, differing: 0, statusMismatches: 0, nodeStatuses: {}, jintStatuses: {}, examples: [] };
  for (const path of paths) {
    const [node, jint] = [await fetchFull(`${base.node}${path}`), await fetchFull(`${base.jint}${path}`)];
    row.compared++;
    row.nodeStatuses[node.status] = (row.nodeStatuses[node.status] ?? 0) + 1;
    row.jintStatuses[jint.status] = (row.jintStatuses[jint.status] ?? 0) + 1;
    noteHeaders('node', node.headers);
    noteHeaders('jint', jint.headers);
    if (node.status !== jint.status) row.statusMismatches++;
    if (node.status === jint.status && node.body.equals(jint.body)) { row.identical++; continue; }
    const [nodeText, jintText] = [normalizeBuildNoise(node.body.toString('utf8')), normalizeBuildNoise(jint.body.toString('utf8'))];
    if (node.status === jint.status && nodeText === jintText) { row.identicalAfterBuildNoise++; continue; }
    row.differing++;
    if (row.examples.length < 3) row.examples.push({ path, nodeStatus: node.status, jintStatus: jint.status, nodeBytes: node.body.length, jintBytes: jint.body.length, ...tokenDiff(nodeText, jintText) });
  }
  row.matchingPercent = round((row.identical + row.identicalAfterBuildNoise) / row.compared * 100, 1);
  report.kinds[kind] = row;
  console.log(`${kind.padEnd(18)} ${row.identical} exact + ${row.identicalAfterBuildNoise} after build noise of ${row.compared}` + (row.differing ? `  (${row.differing} differ, ${row.statusMismatches} status mismatches)` : ''));
}

for (const name of new Set([...headerValues.node.keys(), ...headerValues.jint.keys()])) {
  report.headers[name] = { node: [...(headerValues.node.get(name) ?? [])], jint: [...(headerValues.jint.get(name) ?? [])] };
}
await nodeServer?.stop();
await jintServer?.stop();
const reportFile = resolve(out, isRemote ? 'parity-sites.json' : 'parity.json');
writeJson(reportFile, report);
console.log(`Wrote ${reportFile}`);
