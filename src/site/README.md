# Building the site with Douze

This folder is the site built with [Douze](https://github.com/sebastienros/douze), a static site generator. The
workflow is [`douze.yml`](douze.yml); the content was converted from the Astro sources by
[`scripts/convert-mdx`](scripts/convert-mdx). [`docs/douze-migration-report.md`](../../docs/douze-migration-report.md)
describes what is generated, the fidelity and the build times.

## Prerequisites

- Node 24 and pnpm 11, outside the build only: the client bundle and icon sprite scripts, the API data script and
  Playwright. The build itself runs no Node: Douze highlights the code blocks and downloads Pagefind's and Lightning
  CSS's native binaries on first use.
- The .NET SDK 10 or later on `PATH`: the C# hovers of the code blocks (`hover-csharp` step).
- Douze (below). The install script needs `unzip`, `bsdtar` or `python3` to extract the package.
- About 20 GB of memory for a clean build (a build with the disk cache warm needs about 2 GB): a container or VM
  with less is killed while the API reference renders.

## Install Douze

With the install script, which downloads the native build into `~/.douze` (`%LOCALAPPDATA%\douze` on Windows) and
adds it to the `PATH` (open a new terminal afterwards; running it again updates Douze):

```bash
curl -fsSL https://raw.githubusercontent.com/sebastienros/douze/main/install.sh | sh -s -- --preview
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sebastienros/douze/main/install.ps1))) -Preview
```

Or as a .NET tool (also the native build):

```bash
dotnet tool install -g douze --prerelease --add-source https://f.feedz.io/sebastienros/douze/nuget/index.json
```

`douze --version` checks it. Douze's previews are published from its `main` branch.

## Set up the repository once

Run from the repository root:

```bash
# Node dependencies of the Astro folder (it still holds the API index script, esbuild and the client packages, Playwright)
pnpm --dir src/frontend install --frozen-lockfile

# API reference data: route index, cross references, search indexes, sidebars, and the copy of the API data the pages
# read (again when the API data changes)
pnpm --dir src/frontend exec tsx ../site/scripts/api/build-api-index.ts

# assets: icon sprite and client bundle (again after a template or script change), and the build's commit for the
# footer (again after a commit); the build makes the stylesheet
(cd src/site && node scripts/icons-sprite.mjs && node scripts/build-client.mjs && node scripts/write-build-info.mjs)

# optional: download the tools the steps need (TypeScript 7, the Roslyn language server, Pagefind, Lightning CSS)
# ahead of the first build
douze tools install -s src/site
```

## Build

Into StaticHost's web root, what production serves:

```bash
douze -s src/site -o src/statichost/StaticHost/wwwroot
```

The first build takes about half a minute. The disk cache in
`src/site/.douze/` makes later builds incremental: a build with nothing changed takes a few seconds. `--no-cache`
forces a clean build, `--timeline timeline.html` writes a timeline of the steps, `douze doctor -s src/site` checks
the requirements without building.

## Serve while editing

```bash
douze serve -s src/site --port 4321
```

Then open http://localhost:4321: Douze rebuilds what a change affects and reloads the browser. This is Douze's dev
server, not StaticHost: no Markdown negotiation and no real redirects; build into StaticHost's web root for those.

## Code highlighting with Node (opt-out)

The `highlight` step renders the code blocks natively. To render them with Expressive Code in Node instead (the
worker of the Astro build's engine), run `pnpm --dir src/site install` once and, in `douze.yml`, set `enabled: true`
on the `code` step and `enabled: false` on `highlight`.
