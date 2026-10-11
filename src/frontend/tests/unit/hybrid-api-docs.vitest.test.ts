import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hybridApiDocsIntegration, hybridOutputDirectory, isApiRouteComponent, isHybridApiDocs } from '../../config/hybrid-api-docs.mjs';
import { buildApiRouteCatalog, getCSharpRouteEntries, getTypeScriptRouteEntries } from '@utils/api-route-catalog';
import type { PackageApiDocument } from '@utils/packages';
import type { TsApiDocument } from '@utils/ts-modules';

describe('build-time hybrid opt-in', () => {
  it('requires an explicit supported flag value', () => {
    expect(isHybridApiDocs('0')).toBe(false);
    expect(isHybridApiDocs('1')).toBe(true);
    expect(() => isHybridApiDocs('true')).toThrow('ASPIRE_HYBRID_API_DOCS');
  });

  it('only opts API HTML and Markdown entrypoints out of prerendering', async () => {
    const setup = hybridApiDocsIntegration({}).hooks['astro:route:setup'];
    if (!setup) throw new Error('Missing route setup hook.');
    for (const component of [
      'src/pages/reference/api/csharp/index.astro',
      'E:\\repo\\src\\pages\\reference\\api\\typescript\\[module].md.ts',
      '/repo/src/pages/reference/api/typescript/[module]/[item]/index.astro',
    ]) {
      const route = { component, prerender: true };
      await Reflect.apply(setup, undefined, [{ route }]);
      expect(route.prerender).toBe(false);
    }
    for (const component of ['src/content/docs/reference/api-guidance.mdx', 'src/pages/reference/samples/[sample].md.ts']) {
      expect(isApiRouteComponent(component)).toBe(false);
    }
  });

  it('isolates output and rejects publishing the server in a public root', () => {
    const root = resolve('test-project');
    expect(hybridOutputDirectory(root, undefined)).toBe(resolve(root, 'dist-hybrid'));
    expect(() => hybridOutputDirectory(root, 'public/build')).toThrow('public/');
    expect(() => hybridOutputDirectory(root, '../StaticHost/wwwroot')).toThrow('wwwroot');
    expect(() => hybridOutputDirectory(root, 'dist')).toThrow('dist-hybrid');
    expect(() => hybridOutputDirectory(root, 'src')).toThrow('dist-hybrid');
  });

  it('writes a relocatable private manifest and static API sitemap without page props', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'aspire-hybrid-manifest-'));
    try {
      const root = resolve(directory, 'frontend');
      const out = resolve(root, 'dist-hybrid');
      for (const path of ['src/data/pkgs', 'src/data/ts-modules', 'dist-hybrid/client', 'dist-hybrid/server']) {
        await mkdir(resolve(root, path), { recursive: true });
      }
      await mkdir(resolve(directory, 'statichost/StaticHost/wwwroot/scalar'), { recursive: true });
      await writeFile(resolve(directory, 'statichost/StaticHost/wwwroot/scalar/theme.css'), 'scalar styles');
      await writeFile(resolve(out, 'client/sitemap-index.xml'), '<sitemapindex></sitemapindex>');
      await writeFile(resolve(out, 'server/entry.mjs'), 'export const handler = () => {};');
      const integration = hybridApiDocsIntegration({ '/old/': '/new/' });
      const configure = integration.hooks['astro:config:done'];
      const done = integration.hooks['astro:build:done'];
      if (!configure || !done) throw new Error('Missing hybrid build hooks.');
      await Reflect.apply(configure, undefined, [{
        config: { root: pathToFileURL(root + '/'), outDir: pathToFileURL(out + '/'), site: 'https://aspire.dev' },
      }]);
      await Reflect.apply(done, undefined, [{}]);
      const manifest = JSON.parse(await readFile(resolve(out, 'hybrid-api-docs.json'), 'utf8')) as {
        buildId: string; client: string; server: string; routes: { html: string; markdown: string }[];
      };
      expect(manifest.buildId).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.client).toBe('client');
      expect(manifest.server).toBe('server/entry.mjs');
      expect(manifest.routes).toHaveLength(2);
      expect(await readFile(resolve(out, 'client/sitemap-api.xml'), 'utf8')).toContain('https://aspire.dev/reference/api/typescript/');
      expect(await readFile(resolve(out, 'client/scalar/theme.css'), 'utf8')).toBe('scalar styles');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('API route catalogue', () => {
  it('retains C# generic arity and only existing member-kind groups', () => {
    const pkg: PackageApiDocument = {
      package: { name: 'Test.Package', version: '1', targetFramework: 'net10.0' },
      types: [{ name: 'Thing', kind: 'class', genericParameters: [{ name: 'T' }],
        members: [{ name: 'Run', kind: 'method' }] }],
    };
    expect(getCSharpRouteEntries(pkg).map(({ html }) => html)).toEqual([
      '/reference/api/csharp/test.package/',
      '/reference/api/csharp/test.package/thing-1/',
      '/reference/api/csharp/test.package/thing-1/methods/',
    ]);
  });

  it('keeps collision-safe peers and last-entry Markdown aliases', () => {
    const first = { name: 'Thing', capabilities: [{ name: 'Run', kind: 'Method' }] };
    const last = { name: 'Thing', capabilities: [{ name: 'Run', kind: 'Method' }] };
    const pkg: TsApiDocument = { package: { name: 'Test' }, handleTypes: [first, last] };
    const routes = getTypeScriptRouteEntries(pkg);
    expect(routes.find(({ markdown }) => markdown === '/reference/api/typescript/test/thing.md')?.props.item).toBe(last);
    expect(routes.find(({ markdown }) => markdown === '/reference/api/typescript/test/thing/run.md')?.props.parentType).toBe(last);
    expect(routes.filter(({ html }) => html).every(({ html, markdown }) => `${html?.slice(0, -1)}.md` === markdown)).toBe(true);
  });

  it('covers both real catalogues without serializing API props into manifest routes', () => {
    function documents<T>(directory: string): T[] {
      const root = fileURLToPath(new URL(`../../src/data/${directory}/`, import.meta.url));
      return readdirSync(root).filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T);
    }
    const routes = buildApiRouteCatalog(documents<PackageApiDocument>('pkgs'), documents<TsApiDocument>('ts-modules'));
    expect(routes.filter(({ html }) => html).length).toBeGreaterThan(24000);
    expect(new Set(routes.map(({ markdown }) => markdown)).size).toBe(routes.length);
    expect(routes.every((route) => Object.keys(route).length === 2)).toBe(true);
    expect(routes.slice(0, 2).map(({ html }) => html)).toEqual([
      '/reference/api/csharp/', '/reference/api/typescript/',
    ]);
  });
});
