using System.Runtime;
using AstroJint.AspNetCore;
using Microsoft.AspNetCore.HttpOverrides;

var builder = WebApplication.CreateBuilder(args);

// A line per request on the console would cost more than a small page renders in, so only warnings and the host's own
// start-up messages (how many engines, how long the warm-up took) are logged.
builder.Logging.AddFilter("Microsoft", LogLevel.Warning);
builder.Logging.AddFilter("System", LogLevel.Warning);

// Everything under "Astro" (environment variables such as Astro__DistPath, Astro__PoolSize, Astro__MemoryLimitBytes)
// becomes an option of the host.
builder.Services.AddOptions<AstroOptions>().BindConfiguration("Astro");
builder.Services.AddAstro();

// The load generator sends the headers that the proxy in front of the real renderers sends.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost);

var app = builder.Build();

app.UseForwardedHeaders();

app.MapGet("/healthz", () => Results.Text("ok"));

static object LastGc(GCKind kind)
{
    var info = GC.GetGCMemoryInfo(kind);
    return new
    {
        index = info.Index,
        generation = info.Generation,
        pauseMs = info.PauseDurations.Length > 0 ? info.PauseDurations[0].TotalMilliseconds : 0,
        promotedBytes = info.PromotedBytes,
        heapSizeBytes = info.HeapSizeBytes,
        fragmentedBytes = info.FragmentedBytes,
        compacted = info.Compacted,
        generationSizesAfterBytes = info.GenerationInfo.ToArray().Select(static generation => generation.SizeAfterBytes).ToArray(),
    };
}

// What the load generator reads before and after it measures (LoadGen --gc-stats <url>/api/host); the soak script also
// polls it to follow the heap, the garbage collector and the JIT over time.
app.MapGet("/api/host", () => Results.Json(new
{
    framework = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
    serverGarbageCollection = GCSettings.IsServerGC,
    processorCount = Environment.ProcessorCount,
    workingSetBytes = Environment.WorkingSet,
    cpuSeconds = System.Diagnostics.Process.GetCurrentProcess().TotalProcessorTime.TotalSeconds,
    gc = new
    {
        gen0 = GC.CollectionCount(0),
        gen1 = GC.CollectionCount(1),
        gen2 = GC.CollectionCount(2),
        pauseMs = GC.GetTotalPauseDuration().TotalMilliseconds,
        allocatedBytes = GC.GetTotalAllocatedBytes(),
        heapBytes = GC.GetTotalMemory(forceFullCollection: false),
        committedBytes = GC.GetGCMemoryInfo().TotalCommittedBytes,
        lastEphemeral = LastGc(GCKind.Ephemeral),
        lastFullBlocking = LastGc(GCKind.FullBlocking),
    },
    jit = new
    {
        methods = JitInfo.GetCompiledMethodCount(currentThread: false),
        ilBytes = JitInfo.GetCompiledILBytes(currentThread: false),
        ms = JitInfo.GetCompilationTime(currentThread: false).TotalMilliseconds,
    },
    threadPool = new { threads = ThreadPool.ThreadCount, pending = ThreadPool.PendingWorkItemCount },
}));

// A diagnostic for the soak test, called only before and after a measured run: a blocking, compacting collection, then what is
// still alive and how much memory the process keeps. It separates the live set of the engine from garbage that is waiting for
// a generation-2 collection.
app.MapPost("/api/gc", () =>
{
    GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
    GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
    GC.WaitForPendingFinalizers();
    GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
    var info = GC.GetGCMemoryInfo(GCKind.FullBlocking);
    return Results.Json(new
    {
        heapBytes = GC.GetTotalMemory(forceFullCollection: false),
        heapSizeBytes = info.HeapSizeBytes,
        promotedBytes = info.PromotedBytes,
        fragmentedBytes = info.FragmentedBytes,
        committedBytes = info.TotalCommittedBytes,
        workingSetBytes = Environment.WorkingSet,
        pauseMs = info.PauseDurations.Length > 0 ? info.PauseDurations[0].TotalMilliseconds : 0,
    });
});

app.UseAstro();

app.Run();
