// Feasibility experiment, not a fix. Patches a COPY of a built server bundle (Jint or Node) in place:
//
//   --no-wasm     drop the top-level `WebAssembly.compile(...)` statement (Jint has no WebAssembly global).
//   --stub-node   point `node:path|url|crypto` imports at small generated stubs (Jint's loader only resolves
//                 relative imports inside the bundle).
//   --plain-code  render the `<Code>` component (Expressive Code -> Shiki -> WebAssembly) as a plain
//                 `<pre><code>`. Apply it to BOTH engines when comparing them, so the engine cost is not
//                 confounded by highlighting that Jint cannot do.
//
// The patches are the ones that were found one blocker at a time (see REPORT.md).
//
// usage: node patch-server-bundle.mjs <bundleDir> [--no-wasm] [--stub-node] [--plain-code]
//   <bundleDir> is the directory that contains `server/chunks`.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [bundleDir, ...flags] = process.argv.slice(2);
if (!bundleDir) {
  console.error('usage: node patch-server-bundle.mjs <bundleDir> [--no-wasm] [--stub-node] [--plain-code]');
  process.exit(2);
}
const has = (flag) => flags.includes(flag);

const chunks = join(bundleDir, 'server', 'chunks');
const stubs = {
  path: `export const sep = '/';
export const join = (...parts) => parts.filter(Boolean).join('/').replace(/\\/+/g, '/');
export const resolve = join;
export const basename = (p) => String(p).split('/').pop();
export const dirname = (p) => String(p).split('/').slice(0, -1).join('/') || '.';
export const extname = (p) => { const b = String(p).split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export default { sep, join, resolve, basename, dirname, extname };
`,
  url: `export const fileURLToPath = (u) => String(u).replace(/^file:\\/\\//, '');
export const pathToFileURL = (p) => new URL('file://' + p);
export default { fileURLToPath, pathToFileURL };
`,
  crypto: `export function createHash() {
  let h = 2166136261 >>> 0;
  const hash = {
    update(text) { text = String(text); for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return hash; },
    digest() { return h.toString(16).padStart(8, '0').repeat(2); },
  };
  return hash;
}
export default { createHash };
`,
};

const wasmStatement = /^WebAssembly\.compile\([^\n]*\)\.then\(WebAssembly\.instantiate\)[^\n]*;\s*$/gm;
const nodeImport = /^(import\s+(?:[^'";]*?\s+from\s+)?)(["'])node:(path|url|crypto)\2/gm;
const codeRender = 'html = await renderToHtml();';
const plainCode = `
function __plainCode({ code = "", lang = "", class: className } = {}) {
	const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return \`<pre data-language="\${esc(lang)}"\${className ? \` class="\${esc(className)}"\` : ""}><code>\${esc(code)}</code></pre>\`;
}
`;

const report = { wasm: [], stubbed: {}, plainCode: [] };
for (const name of readdirSync(chunks)) {
  if (!name.endsWith('.mjs')) continue;
  const path = join(chunks, name);
  let text = readFileSync(path, 'utf8');
  let changed = false;

  if (has('--no-wasm') && wasmStatement.test(text)) {
    wasmStatement.lastIndex = 0;
    text = text.replace(wasmStatement, '/* patched: top-level WebAssembly removed */');
    report.wasm.push(name);
    changed = true;
  }
  wasmStatement.lastIndex = 0;

  if (has('--stub-node') && nodeImport.test(text)) {
    nodeImport.lastIndex = 0;
    text = text.replace(nodeImport, (_all, head, quote, id) => {
      (report.stubbed[id] ??= []).push(name);
      return `${head}${quote}./__node-${id}.mjs${quote}`;
    });
    changed = true;
  }
  nodeImport.lastIndex = 0;

  if (has('--plain-code') && text.includes(codeRender) && text.includes('Failed to render a')) {
    text = text.replace(codeRender, 'html = __plainCode(Astro.props);') + plainCode;
    report.plainCode.push(name);
    changed = true;
  }

  if (changed) writeFileSync(path, text);
}

if (has('--stub-node')) {
  for (const [id, text] of Object.entries(stubs)) writeFileSync(join(chunks, `__node-${id}.mjs`), text);
}

console.log(JSON.stringify(report, null, 2));
