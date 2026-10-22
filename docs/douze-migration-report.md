# Douze migration: overnight report

State of the `douze-migration` branch on the morning of 2026-10-22, after one night of autonomous work following
`docs/douze-migration-plan.md` (the plan) with the Douze features of its companion plan in the Douze repository
(`docs/site-features-plan.md`, branch `sebros/workflow-engine`). Everything below was measured on this branch; the
numbers to compare against are the Astro build of the same commit of `main` (`c26b59ba`), built locally into
`src/frontend/dist` (8 min 14 s on this machine, 32,386 HTML and 24,779 `.md` files).

## How to build the site with Douze

Prerequisites: the .NET 11 SDK of `global.json` of the Douze repository, Node 24 and pnpm 11 (for the highlighter
worker, Pagefind, the asset scripts and Playwright), and Douze built from `origin/sebros/workflow-engine` of
`sebastienros/douze` (its `dotnet publish Douze -c Release -o tool-out` gives a native binary `tool-out/douze`;
`dotnet run --project Douze --` works too).

```bash
# once: Node dependencies of the site (Expressive Code + twoslash, Pagefind) and of the Astro folder (the converter,
# the API index script and Playwright still live there)
pnpm --dir src/site install
pnpm --dir src/frontend install --frozen-lockfile

# once per change of the API data (daily job): the route index, cross references, search indexes and sidebars
pnpm --dir src/frontend exec tsx ../site/scripts/api/build-api-index.ts

# the chrome's assets (icon sprite, client bundle with esbuild, stylesheet with lightningcss), after a template change
cd src/site && node scripts/icons-sprite.mjs && node scripts/build-client.mjs && node scripts/build-css.mjs && cd ../..

# the site, into StaticHost's web root (what production serves)
douze -s src/site -o src/statichost/StaticHost/wwwroot

# serve what production serves (Markdown negotiation, canonical redirects, 404) and run the e2e suite against it
cd src/frontend
PLAYWRIGHT_CHROMIUM="$HOME/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  pnpm exec playwright test --config playwright.douze.config.mjs --project=desktop-chromium

# compare any output with the Astro build, route by route (text, headings, links, images, code blocks, asides, tabs, meta)
node src/site/tests/parity/diff.mjs --reference src/frontend/dist --candidate src/statichost/StaticHost/wwwroot --report diff.json
```

`douze serve -s src/site --port 4321` (Douze's phase 6, merged tonight) rebuilds on changes and reloads the browser;
it serves the output folder with Douze's dev server, not StaticHost (no Markdown negotiation, no real redirects).
The disk cache under `src/site/.douze/` makes rebuilds incremental; `--no-cache` forces a clean build.

The workflow is `src/site/douze.yml` (commented); the converter that produced `src/site/content/**` from the MDX
sources is `src/site/scripts/convert-mdx/` (`pnpm --dir src/frontend exec tsx ../site/scripts/convert-mdx/convert.ts`,
idempotent, `--check` reports what would change; its report is `src/site/scripts/convert-mdx/report.md`).

## Update, later the same day

A second pass closed the known gaps (commits `32d9587b` to `46e66652`): the samples' social images, the API
diagnostics "Learn more" links, member cards wrapping at 320 px, the 14 locale 404 pages, `/404.md`, `/index.md`,
the `.well-known` files, the whats-new sidebar topic, the schema `$id`, the first-app asides, the Dev Hub catalog order
and search text, and Pagefind indexing a temp folder of the laid-out pages concurrently with the build (rebuild 28 s
to 21 s). Measured on that build: **Playwright 417 passed / 66 failed / 10 skipped** (the 66: about 60 router-dependent
specs, the `/i18n/` table, two timing races that fail on the Astro build served the same way, the sample README
anchors Astro labels off by one); **routes 57,164 of 57,165** (only `/i18n/` missing, by decision; `VENDOR.md` extra);
24,855 pages byte-identical. The numbers below are from the overnight build.

## What was built tonight

Branch `douze-migration`, 40 commits over `main`; the e2e and diff numbers below are from its last build (the
`wwwroot` of this checkout holds that build, uncommitted). The overnight log of the work is in the Claude session
notes (`overnight-log.md`).

The whole site builds from `src/site/douze.yml` (92 lines, 23 steps) with Douze: the articles in 15 locales, the API
reference, the Dev Hub, the samples, the redirect stubs, the CLI schema routes, the social images, the search index.
The output has the same route set as the Astro build for the API reference and for the articles; the remaining
differences are listed below.

### What Douze generates

| Family | Astro `dist` | Douze | Notes |
|---|---|---|---|
| Article pages (15 locales, `.html`) | 8,460 | 8,460 | converted content (647 MDX files to Markdown with Liquid shortcodes, 35 ported by hand) |
| Article twins (`.md`) | 1,139 | 1,139 | root locale, the translated `ja` pages and every locale's home page, as Astro |
| API reference pages (`.html`) | 24,059 | 24,059 | 4 languages: namespaces, types, members, packages, overviews, search pages |
| API twins (`.md`) | 24,096 | 24,096 | **all byte-identical to the Astro build** |
| Dev Hub (home, browse, glossary, 40 terms) and samples (29) | 145 | 145 | 72 `.md` twins identical |
| Redirect stubs and `redirects.json` | 197 | 197 | from `data/redirects.yml`, through a paginated template |
| CLI schema routes | 25 | 25 | `schema.json` and one `schema/<version>.json` per version, paginated output templates |
| CLI option include pages | 225 | 225 | the include fragments are pages and twins too, in every locale, as on the Astro site |
| Social images (`/og/**.png`) | 522 | 522 | rendered by Douze's `social-image` step with NetVips (resvg was not needed) |
| Search index (Pagefind) | yes | yes | the Pagefind CLI over the output (root locale) |

Total: 69,998 files written (61,174 under the output after Pagefind's index is counted once; 32,371 HTML pages against
Astro's 32,386, 24,777 Markdown twins against 24,779). The `_astro/` hashed assets are replaced by `assets/` (icon sprite, one client bundle
built with esbuild, one stylesheet built with lightningcss from the extracted component styles, images with WebP
variants from Douze's `images` step).

### Fidelity

**Route-by-route diff** (`src/site/tests/parity/diff.mjs`, which compares text, headings, links, images, code
blocks, asides, tabs and meta of every route, ignoring the chrome's whitespace):

- Routes: **57,148 generated against 57,165 in the Astro build: 18 missing, 1 extra** (`VENDOR.md` of a vendored
  stylesheet). The missing ones: the 14 locale 404 pages, `/404.md`, `/index.md` (the home twin), `/i18n/` (dropped, the
  footer links the translation guide) and `/.well-known/agent-skills/.../SKILL.md` (a static file of the Astro `public`
  folder not copied yet).
- Pages: **57,147 compared, 24,852 byte-identical in text, headings, links, images, code, asides, tabs and meta**;
  all 24,096 API twins, 67 `ja` twins, 42 hub and 30 samples twins, 616 article pages. The 32,295 others differ by:
  - the chrome on every page (`text 32,217`, `images 32,187`): the `/assets/images/` logo path instead of `/_astro/`,
    the "Open in" and "Share" menus' words (the Astro build ran them together), the build year in the footer;
  - links on 9,529 pages: `/_astro/` asset paths, the API summary tables linking members' anchors rather than the
    type page, image variant names;
  - 185 headings, 60 asides, 14 code blocks, 27 meta (the og:image of the samples, two `[!NOTE]` summaries).

What the differences are, by family:

- API reference: the HTML pages differ from Astro's only in the chrome (footer markup, asset paths) and in cross
  package links that the Douze templates resolve where Astro left plain text. All twins identical.
- Articles: smart quotes (the Markdown pipeline's `smartypants` is on where Astro's was off inside some components),
  image variant names (`/assets/images/x.webp` instead of `/_astro/x.<hash>.webp`, by design), the `/i18n/` link of
  the footer (dropped), emoji heading ids (fixed in Douze tonight, GitHub's rule), code frames of a few twoslash
  samples where the worker's cache key differs from Expressive Code's.
- Dev Hub: the browse catalog (698 entries) has the same entries, types, topics, platforms and dates; the search text
  of 25 entries differs in tag order (ordinal sort instead of locale rules) and 2 entries in static order.
- Samples: 30 of 60 identical (the twins); the pages differ in smart quotes, image paths and the footer.

**Playwright e2e suite** (`src/frontend/tests/e2e`, 493 desktop tests, unchanged, run against StaticHost serving the
Douze output):

- **411 passed, 72 failed, 10 skipped** of 493 (desktop Chromium; 85% of the tests that ran; the run before, on the
  previous build, gave 410 and 73), from 149 passed on the first full build of the night. 25 of the 47 spec files pass completely: the Dev Hub (browse, glossary, layout,
  accessibility, grain, empty recovery), the custom components, the galleries, the banner, the cookie dialog, the API
  Markdown routes and deep links, RSS, WebMCP, the home page (45 of 46: the last one is a scroll-timing race that
  fails on the Astro build too).
- The 72 failures: **about 60 assume Astro's client router**: `dev-navigation` (16), `route-style-navigation` (6),
  `api-cross-language-navigation` (4), `site-ui-navigation` (4), `filter-navigation` (3), `mermaid-navigation` (2),
  `twoslash-navigation`, `install-modal-navigation`, `live-pip` (2), `cookie-consent` "across client navigation" (2),
  the 6 `api-search-contract` "clear/reset" tests (a window variable must survive navigating away and back), 5
  `pivot-selector` (history state the router sets), 4 of the 5 `site-search` failures, 1 `mobile-ux`, 2 `live-status`,
  1 `gallery` session test. The others are real gaps: the samples' social images (2), the API member pages overflowing
  at 320 px (2), the collapsed sidebar rail names (1), the scroll-to-top alignment and the mobile chrome count (2), the
  latest schema endpoint's body (1), the Twitch embed hostname (1), the hero motion race (1).

The specs that cannot pass with the Douze output as they are assume Astro's client router: they wait for
`astro:page-load`, keep `window` state across navigations (`__devNavigationLoaded`, search controllers), or route
`**/*ResourceBrowser*` chunks by Astro's file names. The Douze site uses full page loads (no view transitions, by
decision). Those specs need adjusting on the Astro side first (plan M1): the suite was deliberately not rewritten
tonight. The rest of the failures are listed under "What is missing".

### Build time

| | Astro (`pnpm build` in `src/frontend`) | Douze |
|---|---|---|
| Clean build | 8 min 14 s | 1 min 54 s (twoslash from Douze's native step: 0.8 s for the 354 snippets; Expressive Code rendering in the worker is most of it) |
| Clean build, Expressive Code cache warm but twoslash fences | 8 min 14 s | 52 s |
| Rebuild, nothing changed | 8 min 14 s | 3 s (every unit replayed from the disk cache, Pagefind's included) |
| One article changed | 8 min 14 s | a few seconds with `douze watch` / `douze serve` (the page, its twin, the search index) |

Measured on the same machine (Apple Silicon, 12 cores); the Douze rows on 2026-10-22 (site `1b7b1a42`, Douze
`977fc16`), one run each, each started at a 1-minute load under 3. Douze's downloaded TypeScript 7 stays installed
between builds (`douze tools install`, like `node_modules`). For comparison, the same clean build with
`TWOSLASH: node` in the `code` step (twoslash compiled in Node with TypeScript 6, as before) takes 2 min 40 s.

Twoslash moved from the Node worker to Douze's `twoslash` step (TypeScript 7's language server; the worker keeps
Expressive Code and renders the step's results). Fidelity: 291 of the 323 twoslash code blocks of the 78 English
twoslash pages are byte-identical to the Astro build (323 of 323 with `TWOSLASH: node`); the 32 others differ by
TypeScript 7's quick info: a type and a const of the same name (the generated enums) shown in the other order without
the type's documentation, union members sorted, one `Date` hover. Douze restores TypeScript 5's `(+N overloads)` at
calls (836 hovers that differed only by it). The twoslash Playwright spec passes its hover checks on direct loads and
fails, as before, at its client-router step. C# and Go hovers (Douze's `csharp` and `go` steps) are wired in
`douze.yml` but opt-in per fence (`twoslash` in the meta), and no fence opts in: the reference has none, and the
Expressive Code plugin renders their popups as TypeScript.

### Memory

Clean full builds run one after the other on the same commit (site `7f8f3de7`, Douze `2ed3d06`, 2026-10-22), the
process tree's resident memory (the build process and its children) sampled once per second; the machine was not
idle (another session built on it: 1-minute load 6 to 21 during the runs), so wall times are above the quiet-machine
numbers of the table above.

| Build | Wall | Peak RSS of the process tree | Of which |
|---|---|---|---|
| Astro `pnpm build` (`NODE_OPTIONS=--max-old-space-size=8192`) | 22 min 3 s (21 min 51 s by its own log; 8 min 14 s on a quiet machine) | 12.2 GB | node and its workers |
| Douze clean (code worker's twoslash cache warm) | 42 to 60 s | 11.9 to 13.9 GB | `douze` 11.3 GB, the Node code worker 0.7 GB, Pagefind 0.24 GB |
| Douze clean, twoslash cache cold | 4 min 9 s | 12.0 GB | twoslash in the worker is the time, not the memory |
| Douze warm rebuild, nothing changed | 2.1 s | 1.8 GB | |
| Native twoslash (Douze `977fc16`, quiet machine): every cache cold | 1 min 54 s | 15.0 GB | `douze` 14.0 GB, node 1.1 GB, Pagefind 0.28 GB |
| Native twoslash: twoslash cold, the rest warm | 52 s | 15.0 GB | `douze` 14.5 GB, node 0.7 GB, tsc 0.27 GB |
| Native twoslash: nothing changed | 3.1 s | 1.9 GB | |
| Node twoslash (`TWOSLASH: node`), every cache cold, same machine state | 2 min 40 s | 14.4 GB | `douze` 12.5 GB, node 2.0 GB |

Satori GC against the standard GC, same commit, clean Douze builds (twoslash cache warm) interleaved on a machine
that was quiet at the start (1-minute load 2.8; it rose with the builds themselves to 19 by the last one):

| Binary | Run 1 | Run 2 |
|---|---|---|
| Satori GC (the default of the AOT publish) | 23.7 s, `douze` 11.4 GB, tree 12.0 GB | 39.4 s, `douze` 12.8 GB, tree 13.4 GB |
| Standard GC (`-p:UseSatoriGC=false`, non-concurrent workstation) | 47.5 s, `douze` 14.4 GB, tree 15.0 GB | 58.1 s, `douze` 13.4 GB, tree 14.0 GB |

The standard GC is not lower on this build: it is slower (about 1.5 to 2 times) and peaks higher, so the default stays.
The 23.7 s run is the clean-build time of this site on a quiet machine after the day's engine work (66 s this morning,
2 min 50 s overnight).

The `douze` process alone measured 5.5 to 6.1 GB in the Douze benchmark of the same change (`bench/README.md`,
the locale copies section, with `/usr/bin/time -l` on a copy of the site before the Pagefind step was reworked); the
native AOT build uses the Satori GC, which peaks higher than the standard GC for the same build (10 to 14 GB on
CoreCLR against 17 to 21 GB before the memory fix). The remaining holders and the planned compressed cache packs are
tracked in the Douze repository (issue 21). Douze runs as a native AOT binary (17.7 MB + libvips);
`dotnet run` adds the JIT warm-up. The API reference (24,059 pages, 24,096 twins) renders in 24 s cold.

### What was done in Douze

The Douze branch `sebros/workflow-engine` got the generic features of `docs/site-features-plan.md` (58 commits
tonight, all tests green, native AOT publish checked, the Sample output identical):

- A configurable Markdown pipeline (`markdown:` section: extensions, asides with BEM classes, code fences handed to a
  highlighter step, link rewriting, heading ids and anchors with GitHub's slug rules, `skip-classes` for component
  headings).
- Shortcodes: Liquid templates called as tags from Markdown (`{% tabs %}…{% endtabs %}`, `{% api "…" %}`), with
  block/inline forms, declared `params`, Markdown includes, fence protection, `markdownify`, `error`/`warn`.
- Locales: `site.locales`, the `localize` step (fallback copies, `localize: false` opt-out), the `t`, `locale_url`,
  `locale_pages` and `nav_*` filters, hreflang data.
- Steps `replace`, `fork` (the Markdown twins), `collect` with `content` (collections of the pages' Markdown), output
  templates (`*.liquid` at the url root: `redirects.json.liquid`, `sitemap.xml.liquid`), `.liquid` layouts.
- Images: NetVips in the AOT tool (`{% image %}`, `image_url`, `image_size`, `images`, `social-image` with an SVG card
  template), identical duplicate outputs accepted by `write`.
- Worker steps for the code highlighter (one Node process, JSON lines, a per-fence cache), the Pagefind CLI as a batch
  step.
- Fixes found by the site: paginated files keep their default path in `permalink`, `json` serializes data objects,
  an HTML encoder that keeps non-ASCII text, heading ids keeping no-break spaces, layout names without extension.
- Phase 6 (`douze watch`, `douze serve`) merged from `sebros/workflow-engine-6`.

### What was simplified or is missing

- **Client router**: no view transitions and no client-side navigation; every link is a full page load. This is
  the source of most remaining e2e failures (see above).
- **Lunaria** (translation status pages) dropped; the locale search index is English only (Pagefind indexes the root
  locale; per-locale indexes are a one-line change of the `search` step's glob if wanted).
- **Diagnostics "Learn more" links** of the API reference are missing: the API pages do not see the collections (the
  pass-through made the pages reach `layout` twice); they need a dedicated `collect` of the diagnostics pages.
- **Locale 404 pages** (`/<locale>/404/`, 14 routes) and the **home page twin** (`/index.md`, a Markdown rendering
  of the landing page components): not generated. `/404.md` neither.
- **Dev Hub search text** is lowercased without diacritics removal; tags are sorted ordinally.
- **Sample README** pages: split line by line rather than parsed; `og:image` points to a social image nothing
  generates yet (a second `social-image` step with the samples' card).
- **`data-opens-in-new-tab`** on external links is not emitted (Astro never rendered it either; the spec expects
  it).
- **Computed front matter** does not exist in Douze: the 40 glossary terms carry hard-coded `prev`/`next` (the
  converter would drop them if re-run on those files).
- **Smart quotes**: the Markdown pipeline turns quotes into typographic ones everywhere; Astro did so outside
  components only. Turning `smartypants` off in the `markdownify` filter is the fix.
- **The AI tool logos of the home page load eagerly** (the lazy images made a spec a race, on Astro too).
- **The footer's copyright year** is the build's; Astro wrote it from the browser's clock.
- The converter's manual queue (35 files) was ported by hand; `report.md` lists each decision.

### How to work on the site

`douze serve -s src/site --port 4321` rebuilds on change (a template change rebuilds the pages that use it; an
article change rebuilds the page, its twin and the search index) and reloads the browser. StaticHost
(`dotnet run --project src/statichost/StaticHost`) serves `wwwroot` as production does; the Playwright config of
`src/frontend/playwright.douze.config.mjs` starts it.

### Next steps

1. Adjust the e2e specs that assume the client router (full page loads), on `main` first, so the suite measures the
   content rather than the navigation model (plan M1).
2. Add the `collect` of the diagnostics pages for the API "Learn more" links, the samples social images, the glossary
   return links, the legacy glossary routes.
3. Turn `smartypants` off inside `markdownify`; decide the tag sort of the Dev Hub search text.
4. Per-locale Pagefind indexes if wanted; Lunaria replacement (a page over `locale_pages`).
5. Wire the Douze build into the CI (`build.yml`): publish Douze from the branch, run the workflow, the diff and the
   e2e suite; keep the Astro build until the suite is green.
6. Douze: cut the per-fence code cache from the worker to a Douze-side cache keyed by fence, per-step profiles of the
   build. (Twoslash itself moved to Douze's native step: 0.8 s cold.)

