# Hybrid API docs engine benchmark

This folder compares the two ways the hybrid API reference can render its on-demand pages:

- **Node sidecar**: the approach of the hybrid POC. Renderers built with `@astrojs/node` in middleware mode, started by `scripts/serve-api-docs.mjs`, run next to StaticHost, which proxies requests to them.
- **Jint**: [astro-jint](https://github.com/IEvangelist/astro-jint). `astro-adapter-jint` builds the same Astro server bundle for a pool of [Jint](https://github.com/sebastienros/jint) engines hosted in ASP.NET Core, so no Node process runs at run time.

[REPORT.md](REPORT.md) has the findings and the recommendation. This file explains what is here and how to reproduce the numbers. The first part of the study runs both engines on a pinned workstation. The second part compares two complete deployments on Azure App Service from a load generator in the same region.

## Ground rules

- The real site is built on CI only. A hybrid build takes 9 to 14 minutes and about 7.5 GB of peak memory on a CI runner, so nothing in this folder builds aspire.dev locally. The workflow `hybrid-api-docs-poc.yml` builds the Node bundle, and `hybrid-api-docs-jint.yml` builds the Jint bundle and a Node control. Both upload their server bundles, and the benchmark runs against those downloads.
- Only the small tools are built locally: `LoadGen` and `JintHost`. The Azure part also builds the StaticHost container image on the machine that runs `aspire deploy`.
- `ASPIRE_HYBRID_ENGINE=jint` selects the Jint adapter at build time. The default is `node`. See `src/frontend/config/hybrid-api-docs.mjs`.
- CI artifacts expire after 7 days. Re-run the workflow from the Actions tab to get a fresh bundle.

## How the comparison is kept fair

| Aspect | What is done |
| --- | --- |
| Pages | Both engines render the same routes from the same `hybrid-api-docs.json`: 24,205 HTML pages and 24,242 `.md` endpoints. |
| Bundles | The Node and Jint bundles are built from the same site sources and lockfile. They differ in the adapter output and in the CI operating system: Windows for the Node bundle, Linux for the Jint bundle. |
| Highlighting | Jint cannot load Expressive Code, because it needs WebAssembly and Node APIs. `patch-server-bundle.mjs --plain-code` renders `<Code>` as a plain `<pre><code>` in **both** bundles, so the engine is the only variable. The unpatched Node bundle keeps Expressive Code and is measured as the as-deployed reference. |
| Parity | `parity.mjs` renders pages on both engines and compares the HTML after build noise is normalized, and the `.md` endpoints byte for byte. |
| Driver | One neutral load generator, `LoadGen`. Both engines get the same headers, path files, seeds and connection counts, and the same statistics. |
| CPU budget | A load configuration is a number of cores. The server is pinned to that many quiet logical processors, and the load generator to two others. Node gets that many renderer processes, Jint one process with that many engines. |
| Warm-up | Node 8 s. Jint 20 s on one core and 30 s on several, because a Jint engine loads the 45 MB data layer lazily on the first page. |

## Layout

| Path | What it is |
| --- | --- |
| `LoadGen/` | Closed-loop HTTP load generator that records latency in a log-linear histogram with about 1.5% resolution. It takes one or several server URLs, picks paths at random or in file order, pins the server processes and itself to processors, samples the server's memory every 200 ms, reads the server's CPU time at the window edges, and reads GC counters from the stats URL given with `--gc-stats`. |
| `JintHost/` | Minimal ASP.NET Core host for a Jint build: `AddAstro()`, `/healthz`, `GET /api/host` for CPU, memory, GC, JIT and thread pool counters, and `POST /api/gc` for a forced compacting collection that reads the live set. |
| `scripts/bundle-bench.mjs` | Cold start, per-route sequence latency, load matrix and, for Node, a V8 CPU profile. Same protocol for both engines. |
| `scripts/soak.mjs` | One configuration for several minutes with periodic polling and a live-set reading from a forced full collection before and after, to tell a plateau from a leak. `--live-every <s>` repeats the collection during the run, `--mix` picks the path file, and `--select sequential` with one connection walks a path file once in order. |
| `scripts/soak-report.mjs` | Prints one soak result as window rows and a live-set timeline. |
| `scripts/jint-trace.mjs` | Runs the Jint host under `dotnet-trace` while it serves the c1-uniform-x16 load, then aggregates the samples with `analyze-nettrace.mjs`. |
| `scripts/analyze-nettrace.mjs` | Aggregates a `dotnet-trace` speedscope file by namespace and by function. |
| `scripts/parity.mjs` | Renders a sample of every route kind on both engines and compares the output. With `--node-url` and `--jint-url` it fetches the pages from two running sites instead. |
| `scripts/analyze-cpuprofile.mjs` | Summarizes a V8 `.cpuprofile` by region: Astro, Starlight, libraries, site code, syntax highlighting, WebAssembly and GC. |
| `scripts/patch-server-bundle.mjs` | Feasibility patches for a **copy** of a built bundle: `--no-wasm`, `--stub-node`, `--plain-code`. |
| `scripts/make-paths.mjs` | Splits `hybrid-api-docs.json` into per-kind path files and writes the mixes: `uniform-html`, `zipf-html`, `replay-40` and `crawl-all`, which holds every HTML page and every Markdown endpoint once. |
| `scripts/summarize-results.mjs` | Prints the tables of the report from `results/`. |
| `scripts/summarize-azure.mjs` | Prints the tables of the Azure section of the report from `results/azure/`. |
| `scripts/lib.mjs` | Shared helpers: start a server and time it to readiness, read process CPU and memory, run LoadGen. |
| `azure/` | The in-region load runner. `Dockerfile` builds the `LoadGen` image. `suites/` holds the `latency`, `sweep`, `mixed` and `soak` scripts, and `paths/` the small path lists they read. `run-suite.ps1` runs one suite in Azure Container Instances and saves its reports, and `collect-metrics.ps1` saves Azure Monitor metrics for a time window. |
| `results/` | The JSON the report is built from: one folder per measured bundle, repeat and tuning run with a `summary.json` and one `load-*.json` per configuration, plus `parity/`, `soak/` for the soaks, growth probes and full-site crawls, `jint-trace/`, and `azure/` for the suite logs, reports and metrics of the Azure runs. |

## Reproduce

Validated on Windows with .NET SDK 10.0.402 and Node 24.13.1. The CI bundles were built with Node 24.21.0. On Linux the scripts read process CPU and memory from `/proc`, and that path was not exercised. The paths below are examples, and `D:\bench` is a scratch folder outside the repository. Run every command from `src\tools\HybridEngineBenchmark` in a clone of the repository.

1. Build the two small tools.

   ```powershell
   dotnet publish LoadGen\LoadGen.csproj -c Release -o D:\bench\bin\loadgen

   git clone https://github.com/IEvangelist/astro-jint D:\bench\astro-jint
   git -C D:\bench\astro-jint checkout 3c4795cdaad1d07b6fd3bcabba336a5fb4c7b7d6
   dotnet publish JintHost\JintHost.csproj -c Release -p:AstroJintRoot=D:\bench\astro-jint\ -o D:\bench\bin\jinthost
   ```

   `JintHost` has its own `NuGet.config` because astro-jint needs a preview feed that the repository's `NuGet.config` does not allow.

2. Download the server bundles from CI. Always name the run: `gh run download` without a run id fails on this repository.

   | Bundle | Workflow | Artifact | Run used in the report |
   | --- | --- | --- | --- |
   | Node sidecar | `hybrid-api-docs-poc.yml` | `hybrid-api-docs-poc-windows`, or `hybrid-api-docs-poc` for the Linux build | `38658562951`, built at `2f75c4432` |
   | Jint | `hybrid-api-docs-jint.yml` | `hybrid-engine-jint` | `38818113616`, built at `43c5486ec` |

   ```powershell
   gh run download 38658562951 --repo microsoft/aspire.dev --name hybrid-api-docs-poc-windows --dir D:\bench\ci\win
   gh run download 38818113616 --repo microsoft/aspire.dev --name hybrid-engine-jint --dir D:\bench\ci\jint
   ```

3. Lay out the Node renderer like `src/frontend/Dockerfile.hybrid` does. From `src/frontend`, take `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json` and `patches/`, and install the production dependencies with `pnpm install --frozen-lockfile --prod`. The downloaded artifact has the layout of `dist-hybrid`. Take its `server/` as `server/`, its `renderer/client` as `client/`, its `renderer/.starlight-icons` as `.starlight-icons/`, and its `hybrid-api-docs.json`. Add `scripts/serve-api-docs.mjs`. This is the **as-deployed** renderer, `D:\bench\run-node`.

4. Make the two patched copies for the same-workload comparison. Copy the Jint bundle and the renderer, then patch the copies, never the originals.

   ```powershell
   Copy-Item D:\bench\ci\jint D:\bench\ci\jint-p2 -Recurse
   Copy-Item D:\bench\run-node D:\bench\run-node-p -Recurse

   node scripts\patch-server-bundle.mjs D:\bench\ci\jint-p2 --no-wasm --stub-node --plain-code
   node scripts\patch-server-bundle.mjs D:\bench\run-node-p --plain-code
   ```

   The patcher changes only files under `server\chunks`. The study linked `node_modules` and `client` in `run-node-p` to the originals with junctions instead of copying them, which saves 425 MB and about 30,000 files.

5. Make the path files.

   ```powershell
   node scripts\make-paths.mjs D:\bench\ci\win\hybrid-api-docs.json D:\bench\paths
   ```

6. Check parity.

   ```powershell
   node scripts\parity.mjs --renderer D:\bench\run-node-p --host D:\bench\bin\jinthost --dist D:\bench\ci\jint-p2 --paths D:\bench\paths --out D:\bench\results\parity
   ```

7. Run the benchmark once per bundle. `LOADGEN_EXE` points at the published load generator.

   ```powershell
   $env:LOADGEN_EXE = 'D:\bench\bin\loadgen\LoadGen.exe'

   node scripts\bundle-bench.mjs --engine node --renderer D:\bench\run-node-p --paths D:\bench\paths --out D:\bench\results\node-plain --label node-plain
   node scripts\bundle-bench.mjs --engine node --renderer D:\bench\run-node --paths D:\bench\paths --out D:\bench\results\node-as-deployed --label node-as-deployed
   node scripts\bundle-bench.mjs --engine jint --host D:\bench\bin\jinthost --dist D:\bench\ci\jint-p2 --paths D:\bench\paths --out D:\bench\results\jint-plain --label jint-plain --duration 45
   ```

   Use `--only cold,sequence,load,profile` to run part of the protocol and `--configs c1-uniform-x16,c4-uniform-x32` to run part of the load matrix. The matrix is `c<cores>-<mix>-x<connections>`: `c1-uniform-x1`, `c1-uniform-x4`, `c1-uniform-x16`, `c1-zipf-x16`, `c1-md-x16`, `c2-uniform-x16`, `c4-uniform-x32`, plus `c4-uniform-x32-wks` for Jint with workstation GC and `c1-zipf-x16-cached` for Node with the renderer's LRU cache on.

8. Summarize the Node CPU profile by region.

   ```powershell
   node scripts\analyze-cpuprofile.mjs D:\bench\results\node-plain\profile.cpuprofile 25 --server D:\bench\run-node-p\server
   ```

9. Run a soak, which holds one configuration for several minutes and reads the live set before and after.

   ```powershell
   node scripts\soak.mjs --engine jint --host D:\bench\bin\jinthost --dist D:\bench\ci\jint-p2 --paths D:\bench\paths --out D:\bench\results\soak --duration 240 --label jint-plain-soak
   node scripts\soak.mjs --engine node --renderer D:\bench\run-node-p --paths D:\bench\paths --out D:\bench\results\soak --duration 240 --label node-plain-soak
   node scripts\soak-report.mjs D:\bench\results\soak\soak-jint-plain-soak.json
   ```

10. Run the growth probes and the full-site crawls. A growth probe adds `--live-every <seconds>`, which forces a full collection at that interval and records the live set. A crawl uses one connection that walks `crawl-all` in file order: every HTML page and every Markdown endpoint once, 48,447 requests per pass.

    ```powershell
    node scripts\soak.mjs --engine jint --host D:\bench\bin\jinthost --dist D:\bench\ci\jint-p2 --paths D:\bench\paths --out D:\bench\results\soak --label jint-crawl --connections 1 --select sequential --mix crawl-all --interval 15 --window 60 --duration 3600 --live-every 120
    ```

    | Label | Bundle | Arguments |
    | --- | --- | --- |
    | `jint-growth-distinct`, `node-growth-distinct` | Jint, Node plain | `--duration 300 --live-every 30` |
    | `jint-growth-replay` | Jint | `--duration 150 --live-every 30 --mix replay-40` |
    | `node-plain-crawl` | Node plain | `--connections 1 --select sequential --mix crawl-all --interval 15 --window 60 --duration 240 --live-every 10` |
    | `node-as-deployed-crawl` | Node as deployed | The same crawl arguments with `--duration 360 --live-every 10` |
    | `jint-crawl` | Jint | The command above |

11. Try .NET runtime settings on the Jint host. Each run sets one `DOTNET_` variable, runs the one-core load, and clears the variable.

    ```powershell
    $env:DOTNET_TC_CallCountingDelayMs = '0'
    node scripts\bundle-bench.mjs --engine jint --host D:\bench\bin\jinthost --dist D:\bench\ci\jint-p2 --duration 45 --configs c1-uniform-x16 --paths D:\bench\paths --only load --out D:\bench\results\tune-tc-delay0 --label tune-tc-delay0
    Remove-Item Env:DOTNET_TC_CallCountingDelayMs
    ```

    | Run folder | Variable |
    | --- | --- |
    | `tune-default` | None |
    | `tune-pgo-off` | `DOTNET_TieredPGO=0` |
    | `tune-tc-off` | `DOTNET_TieredCompilation=0` |
    | `tune-tc-delay0` | `DOTNET_TC_CallCountingDelayMs=0` |
    | `tune-gc-nonconcurrent` | `DOTNET_gcConcurrent=0` |
    | `tune-gen0-256mb` | `DOTNET_GCgen0size=10000000` |
    | `tune-combined` | The delay, non-concurrent GC and gen0 size settings together, with `--configs c1-uniform-x16,c4-uniform-x32` |

    .NET reads `DOTNET_GCgen0size` as hexadecimal without a `0x` prefix, so `10000000` is 256 MiB.

12. Sample the managed call stacks of the Jint host. This needs `dotnet-trace`.

    ```powershell
    dotnet tool install dotnet-trace --tool-path D:\bench\tools
    node scripts\jint-trace.mjs --host D:\bench\bin\jinthost --dist D:\bench\ci\jint-p2 --paths D:\bench\paths --out D:\bench\results\jint-trace --tool D:\bench\tools\dotnet-trace.exe --lead 75 --seconds 40
    ```

    `--lead` is how long the load runs before sampling starts, and `--seconds` is the length of the sample. The profiler adds overhead, so use the shares and not the throughput.

13. Print the tables of the report.

    ```powershell
    node scripts\summarize-results.mjs D:\bench\results --paths D:\bench\paths
    ```

    `--section` limits the output to one of `cold`, `first-hits`, `sequence`, `load`, `variance`, `tuning`, `growth` or `profile`, and `--paths` adds the expected number of distinct pages to the growth tables. Without arguments the script prints the tables for the data committed in `results/`.

Keep the machine idle while a benchmark runs. Builds, tests and installs in the background change the numbers.

## Choosing quiet CPUs

The server is pinned to logical processors that are free of other work, and the generator to two more. The benchmark machine is an Intel Core i7-14700K with 8 hyper-threaded P-cores and 12 E-cores. The first attempt used logical processor 0, and under load the server got only 0.72 to 0.80 of a core. Those runs were discarded. The masks that gave the server 0.94 to 0.97 of a core under load are:

| Budget | Mask | Logical processors |
| --- | --- | --- |
| 1 core | `0x4` | 2 |
| 2 cores | `0x44` | 2, 6 |
| 4 cores | `0x1444` | 2, 6, 10, 12 |
| Load generator | `0x4010` | 4, 14 |

Bit `n` of a mask is logical processor `n`. Each server core is one hyper-thread of a different physical P-core, and the benchmark leaves the sibling thread free.

Measure your own machine before trusting these masks:

1. For each logical processor, start a single-threaded busy loop and set `Process.ProcessorAffinity` to that processor.
2. Let it spin for 5 seconds and divide its `TotalProcessorTime` by the wall time.
3. A value near 1.00 is a quiet processor. The benchmark machine measured 0.75 to 0.85 on processors 0, 4, 8, 16 and 18, and 0.97 or more on 2, 6, 10, 12 and 14.

Pass other masks with `--server-masks <1 core>,<2 cores>,<4 cores>` to `bundle-bench.mjs`, `--server-mask <mask>` to `soak.mjs`, and `--generator-cores <mask>` to either.

## Production-like comparison on Azure

The workstation runs isolate the engines on pinned cores. The Azure runs compare two complete deployments of the same site, each on its own App Service plan, with the load generated in the same region.

| | Node deployment | Jint deployment |
| --- | --- | --- |
| Containers per instance | StaticHost and two Node renderers | StaticHost with Jint in process |
| Plan | P0v3 with 1 vCPU and 4 GiB, 2 instances, elastic scale-out up to 10 | The same, set by hand to match |
| Origin | The existing hybrid test deployment | A new resource group in the same subscription, made with `aspire deploy` and `ASPIRE_HYBRID_ENGINE=jint` |
| Reached through | The App Service host name over plain HTTP | The same |

Requests come from an Azure Container Instances group with 2 vCPU and 4 GB in the region of the sites. A health probe takes 3 to 4 ms at the median from there. The generator uses plain HTTP against the App Service host names, so Front Door and TLS are outside the measurement. One suite is one container group, created and deleted by `run-suite.ps1`. Each suite alternates the order of the two sites between rounds, so a slow minute on the platform does not always land on the same site.

| Suite | Load | Reports |
| --- | --- | --- |
| `latency` | One connection and one request at a time, in three rounds per site. A round requests 20 static pages, 150 API pages and 100 Markdown endpoints, five times each, and uses pages that no earlier round used. The first request of a page is normally a cache miss, so the five requests separate the cost of a render from the cost of a cached answer. | 24 |
| `sweep` | 1, 2, 4, 8, 16, 32 and 64 connections over 20,000 random API pages, 30 seconds measured after 5 seconds of warm-up. Each step draws its pages with its own seed, and an unreported 20-second pass at 16 connections warms both sites first. Nearly every request is a cache miss, so the result is the rendering capacity of the site. | 14 |
| `mixed` | API pages with skewed popularity on 32 connections for 60 seconds, 50 hot API pages on 32 connections for 30 seconds, Markdown endpoints on 16 connections for 30 seconds, and static documentation pages on 16 connections for 20 seconds. | 8 |
| `soak` | 16 connections over every API page and Markdown endpoint, 10 minutes per site by default. The throughput per second shows whether a site stays steady, slows down or restarts. | 2 |

The suites read the path lists in `azure/paths/` and the lists that `make-paths.mjs` writes. The small lists are the ones the reported runs used. They are random samples of the API routes and of the localized documentation pages that both deployments serve as plain files, with no page shared between the latency rounds. Pages must exist in both deployments, so draw new lists when the content of either one changes.

1. Deploy the Jint build. Follow the Jint section of `CONTRIBUTING.md` to get the artifact and run `aspire deploy` into a new resource group. `aspire deploy` builds the StaticHost image on the machine that runs it and needs Docker. The site content comes from the CI artifact, so no part of aspire.dev is built locally.

2. Give the new plan the same capacity as the Node plan. A new deployment does not copy the scale settings. Set the instance count, elastic scale, the maximum elastic worker count and the site's minimum and pre-warmed instance counts with the portal, the Azure CLI or the REST API. Then compare the properties of both plans and both sites before measuring, and wait until every instance reports ready.

   An elastic plan adds instances when it answers slowly, up to the maximum elastic worker count. In the first sweep, with the maximum of 10 that the Node plan has, the Jint plan grew from 2 to 10 instances while the Node plan stayed at 2. For a fixed-capacity comparison, lower the maximum on the plan that you control to the instance count, and log the instance count of both sites during every suite.

3. Build and push the load generator image to a registry that a managed identity can pull from.

   ```powershell
   dotnet publish LoadGen\LoadGen.csproj -c Release -o D:\bench\loadgen-image\app
   New-Item -ItemType Directory D:\bench\loadgen-image\paths
   Copy-Item azure\paths\*.txt, D:\bench\paths\uniform-html.txt, D:\bench\paths\zipf-html.txt, D:\bench\paths\crawl-all.txt, D:\bench\paths\all-md.txt D:\bench\loadgen-image\paths
   Copy-Item azure\Dockerfile D:\bench\loadgen-image

   docker build -t REGISTRY.azurecr.io/hybridbench-loadgen:v1 D:\bench\loadgen-image
   az acr login --name REGISTRY
   docker push REGISTRY.azurecr.io/hybridbench-loadgen:v1
   ```

4. Run a suite. The signed-in `az` account must be able to create container groups in the resource group, and the identity needs `AcrPull` on the registry. The script prints no tokens, and the suite log and reports are written to `results\azure`.

   ```powershell
   azure\run-suite.ps1 -SubscriptionId SUBSCRIPTION -TenantId TENANT -ResourceGroup RESOURCE_GROUP -Image REGISTRY.azurecr.io/hybridbench-loadgen:v1 -IdentityResourceId IDENTITY_RESOURCE_ID -Suite latency -Sites node=http://NODE_SITE.azurewebsites.net,jint=http://JINT_SITE.azurewebsites.net
   ```

   Use `-Suite sweep`, `mixed` or `soak` for the other suites, and `-Environment @{ SOAK_SECONDS = 1200 }` to change the length of a soak. Do not run anything else against the sites while a suite runs.

5. Save the Azure Monitor metrics for the window of a suite, about five minutes after it ends, because the metrics arrive late. The suite log has a `#start` line and an `#end` line with the times in UTC.

   ```powershell
   azure\collect-metrics.ps1 -TenantId TENANT -Start START_UTC -End END_UTC -OutFile results\azure\metrics-sweep.json -Resources @{ node = NODE_SITE_ID; node_plan = NODE_PLAN_ID; jint = JINT_SITE_ID; jint_plan = JINT_PLAN_ID }
   ```

6. Compare the pages that the two deployments return.

   ```powershell
   node scripts\parity.mjs --node-url http://NODE_SITE.azurewebsites.net --jint-url http://JINT_SITE.azurewebsites.net --paths D:\bench\paths --out results\parity-azure --per-kind 25
   ```

7. Print the tables. `--section` limits the output to `latency`, `sweep`, `mixed`, `soak` or `metrics`, and `--instances` adds every metric series to the metrics tables.

   ```powershell
   node scripts\summarize-azure.mjs results\azure
   ```

The files committed in `results/azure/` and `results/parity-azure/` call the two sites `NODE_SITE` and `JINT_SITE` and name the platform instances in the metric series `instance-1`, `instance-2` and so on, in place of the real names. `results/azure/first-sweep/` is the first sweep, in which the Jint plan scaled out, and `results/azure/instances.log` records how many instances each site had, and how many were ready, about every 33 seconds in local time, UTC-5, from before the sweep to after the soak. A small polling loop over the Azure management API wrote it, and that loop is not included here. Azure Monitor labels each minute about 85 seconds after the traffic it counts, and the summarizer shifts the windows by that lag and keeps only whole minutes.

The Jint deployment, its Redis Enterprise cache and its Front Door profile cost money while they exist. Delete the resource group when the measurements are done.

## What the numbers do and do not tell you

- Jint runs the **patched** bundle. It cannot run Expressive Code, so its numbers are optimistic for the real site. The as-deployed Node run is the reference for what the hybrid POC runs.
- `LoadGen` sends one probe request before the measured window starts. On a cold Jint host the probe takes several seconds, so the server burns CPU before `startedUtc` in the report. The soak aligns its samples to `startedUtc` for this reason.
- `JintHost` gained more `/api/host` fields and `POST /api/gc` after the main matrix ran. The matrix only reads `/api/host` at the edges of a window. The soaks force a collection before and after the load, and with `--live-every` during it too, so read the growth probes and crawls as memory measurements and not as throughput measurements.
- Each CI build ran once, so build times are single samples. The Node hybrid build took 9:07 as the second build in the POC job and 14:12 as the control in the Jint workflow, so build time is reported but is not a differentiator.
- The workstation numbers come from one Windows machine and measure the engines alone. They leave out the hop from StaticHost to a sidecar, which the Azure runs include. No production traffic data was available.
- The Azure plans are P0v3 with 1 vCPU and 4 GiB per instance, 2 instances each. The runs send plain HTTP to the App Service host names, so Front Door, TLS and the CDN are outside the measurement.
- Each instance has its own cache. A load generator connection appears to stay on one instance, because the repeats of a page on one connection were always cache hits. Cache hit ratios therefore depend on how the platform routes connections.
- The Jint deployment serves pages without syntax highlighting, so its Azure numbers are a lower bound on the cost of rendering the real pages.
- The scale of the new Jint plan was set by hand. For the fixed-capacity runs its maximum elastic worker count was lowered to 2, while the Node plan kept the maximum of 10 it was deployed with.
- The two deployments were built from different content commits. The path lists hold only pages that both of them serve.
