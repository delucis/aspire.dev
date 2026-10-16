using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace LoadGen;

internal sealed record LatencyMs(double Mean, double P50, double P90, double P95, double P99, double P999, double Max);

internal sealed record ServerUsage(
    double ServerCores,
    double ServerCpuSeconds,
    double GeneratorCores,
    long ServerRssStartBytes,
    long ServerRssEndBytes,
    long ServerRssPeakBytes,
    long ServerPrivatePeakBytes);

internal sealed record GcUsage(double PausePercent, long Gen0, long Gen1, long Gen2, long AllocatedBytes);

internal sealed record LoadReport(
    string Label,
    string Url,
    string StartedUtc,
    int Connections,
    int UniquePaths,
    double Seconds,
    long Requests,
    double RequestsPerSecond,
    long Errors,
    IReadOnlyDictionary<int, long> Statuses,
    IReadOnlyDictionary<int, long> Failures,
    double AverageBytes,
    LatencyMs Latency,
    long[] RequestsPerSecondTimeline,
    ServerUsage? Server,
    GcUsage? Gc);

internal sealed record SequenceEntry(string Path, int Status, long Bytes, double[] Milliseconds);

internal sealed record SequenceReport(string Label, string Url, string StartedUtc, IReadOnlyList<SequenceEntry> Entries);

internal static class Runner
{
    public static async Task<LoadReport> RunLoadAsync(Options options)
    {
        var endPoints = await Task.WhenAll(options.Urls.Select(ResolveAsync)).ConfigureAwait(false);
        var (requests, uniquePaths) = BuildRequests(options);
        foreach (var endPoint in endPoints)
        {
            await ProbeAsync(endPoint, requests[0]).ConfigureAwait(false);
        }

        var started = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        var measureStart = Stopwatch.GetTimestamp() + (long)(options.Warmup.TotalSeconds * Stopwatch.Frequency);
        var end = measureStart + (long)(options.Duration.TotalSeconds * Stopwatch.Frequency);
        var buckets = (int)Math.Ceiling(options.Duration.TotalSeconds) + 1;

        var workers = new Worker[options.Connections];
        var tasks = new Task[workers.Length];
        for (var i = 0; i < workers.Length; i++)
        {
            var worker = workers[i] = new Worker(buckets);
            var index = i;
            tasks[i] = Task.Run(() => worker.RunAsync(endPoints[index % endPoints.Length], requests, options.RandomSelection, options.Seed + index, index, measureStart, end));
        }

        var usage = MeasureUsageAsync(options.Pids, measureStart, end);
        var gc = MeasureGcAsync(options, measureStart, end);
        await Task.WhenAll(tasks).ConfigureAwait(false);

        var latency = new LatencyHistogram();
        var statuses = new Dictionary<int, long>();
        var failures = new Dictionary<int, long>();
        var timeline = new long[buckets];
        long errors = 0;
        long bytes = 0;
        foreach (var worker in workers)
        {
            latency.Add(worker.Latency);
            errors += worker.Errors;
            bytes += worker.Bytes;
            Merge(statuses, worker.Statuses);
            Merge(failures, worker.Failures);
            for (var i = 0; i < buckets; i++)
            {
                timeline[i] += worker.Timeline[i];
            }
        }

        var seconds = options.Duration.TotalSeconds;
        return new LoadReport(
            options.Label,
            string.Join(',', options.Urls),
            started,
            options.Connections,
            uniquePaths,
            seconds,
            latency.Count,
            latency.Count / seconds,
            errors,
            statuses,
            failures,
            latency.Count == 0 ? 0 : (double)bytes / latency.Count,
            new LatencyMs(
                latency.MeanMicroseconds / 1000,
                latency.Percentile(50) / 1000d,
                latency.Percentile(90) / 1000d,
                latency.Percentile(95) / 1000d,
                latency.Percentile(99) / 1000d,
                latency.Percentile(99.9) / 1000d,
                latency.MaxMicroseconds / 1000d),
            timeline[..(buckets - 1)],
            await usage.ConfigureAwait(false),
            await gc.ConfigureAwait(false));
    }

    public static async Task<SequenceReport> RunSequenceAsync(Options options)
    {
        var endPoint = await ResolveAsync(options.Url).ConfigureAwait(false);
        var started = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        var entries = new List<SequenceEntry>();
        using var connection = new HttpConnection(endPoint);
        foreach (var path in options.Paths)
        {
            var request = BuildRequest(options, path);
            var times = new double[options.Repeat];
            var status = 0;
            long bytes = 0;
            for (var i = 0; i < times.Length; i++)
            {
                var t0 = Stopwatch.GetTimestamp();
                var exchange = await connection.SendAsync(request).ConfigureAwait(false);
                times[i] = Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
                status = exchange.Status;
                bytes = exchange.Bytes;
            }

            entries.Add(new SequenceEntry(path, status, bytes, times));
        }

        return new SequenceReport(options.Label, options.Url.ToString(), started, entries);
    }

    private static void Merge(Dictionary<int, long> into, Dictionary<int, long> from)
    {
        foreach (var (key, count) in from)
        {
            into[key] = into.GetValueOrDefault(key) + count;
        }
    }

    private static (byte[][] Requests, int Unique) BuildRequests(Options options)
    {
        var byPath = new Dictionary<string, byte[]>();
        var requests = new byte[options.Paths.Count][];
        for (var i = 0; i < requests.Length; i++)
        {
            var path = options.Paths[i];
            if (!byPath.TryGetValue(path, out var bytes))
            {
                byPath[path] = bytes = BuildRequest(options, path);
            }

            requests[i] = bytes;
        }

        return (requests, byPath.Count);
    }

    private static byte[] BuildRequest(Options options, string path)
    {
        bool Has(string name) => options.Headers.Any(h => h.StartsWith(name + ":", StringComparison.OrdinalIgnoreCase));
        var request = new StringBuilder()
            .Append("GET ").Append(Escape(path)).Append(" HTTP/1.1\r\n");
        if (!Has("Host"))
        {
            request.Append("Host: ").Append(options.Url.Authority).Append("\r\n");
        }

        request.Append("Connection: keep-alive\r\n");
        if (!Has("Accept-Encoding"))
        {
            request.Append("Accept-Encoding: identity\r\n");
        }

        if (!Has("Accept"))
        {
            request.Append("Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n");
        }

        if (!Has("User-Agent"))
        {
            request.Append("User-Agent: HybridEngineBenchmark-LoadGen/1.0\r\n");
        }

        foreach (var header in options.Headers)
        {
            request.Append(header).Append("\r\n");
        }

        return Encoding.ASCII.GetBytes(request.Append("\r\n").ToString());
    }

    private static string Escape(string path)
    {
        if (path.All(static c => c is > ' ' and < (char)127))
        {
            return path;
        }

        var builder = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(path))
        {
            if (b is > (byte)' ' and < 127)
            {
                builder.Append((char)b);
            }
            else
            {
                builder.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }

        return builder.ToString();
    }

    private static async Task<IPEndPoint> ResolveAsync(Uri url)
    {
        var addresses = await Dns.GetHostAddressesAsync(url.Host).ConfigureAwait(false);
        var address = Array.Find(addresses, static a => a.AddressFamily == AddressFamily.InterNetwork) ?? addresses[0];
        return new IPEndPoint(address, url.Port);
    }

    private static async Task ProbeAsync(IPEndPoint endPoint, byte[] request)
    {
        using var connection = new HttpConnection(endPoint);
        var exchange = await connection.SendAsync(request).ConfigureAwait(false);
        if (exchange.Failed || exchange.Status is < 200 or > 399)
        {
            throw new InvalidOperationException($"The first request answered {(exchange.Failed ? "nothing usable" : exchange.Status)}. Is the server up, and are the Host headers right?");
        }
    }

    private static async Task<ServerUsage?> MeasureUsageAsync(int[] pids, long measureStart, long end)
    {
        if (pids.Length == 0)
        {
            return null;
        }

        var servers = pids.Select(Process.GetProcessById).ToArray();
        using var generator = Process.GetCurrentProcess();
        try
        {
            await DelayUntilAsync(measureStart).ConfigureAwait(false);
            double Cpu() => servers.Sum(static p => { p.Refresh(); return p.TotalProcessorTime.TotalSeconds; });
            long Sum(Func<Process, long> read) => servers.Sum(p => { p.Refresh(); return read(p); });
            var cpuStart = Cpu();
            generator.Refresh();
            var generatorStart = generator.TotalProcessorTime.TotalSeconds;
            var wallStart = Stopwatch.GetTimestamp();
            var rssStart = Sum(static p => p.WorkingSet64);
            var peakRss = rssStart;
            var peakPrivate = Sum(static p => p.PrivateMemorySize64);

            while (Stopwatch.GetTimestamp() < end)
            {
                await Task.Delay(200).ConfigureAwait(false);
                peakRss = Math.Max(peakRss, Sum(static p => p.WorkingSet64));
                peakPrivate = Math.Max(peakPrivate, Sum(static p => p.PrivateMemorySize64));
            }

            var wall = Stopwatch.GetElapsedTime(wallStart).TotalSeconds;
            var cpuSeconds = Cpu() - cpuStart;
            generator.Refresh();
            return new ServerUsage(
                cpuSeconds / wall,
                cpuSeconds,
                (generator.TotalProcessorTime.TotalSeconds - generatorStart) / wall,
                rssStart,
                Sum(static p => p.WorkingSet64),
                peakRss,
                peakPrivate);
        }
        finally
        {
            foreach (var server in servers)
            {
                server.Dispose();
            }
        }
    }

    private static async Task<GcUsage?> MeasureGcAsync(Options options, long measureStart, long end)
    {
        if (options.GcStatsPath is not { } path)
        {
            return null;
        }

        using var client = new HttpClient { BaseAddress = options.Url, Timeout = TimeSpan.FromSeconds(10) };
        await DelayUntilAsync(measureStart).ConfigureAwait(false);
        var before = await ReadGcAsync(client, path).ConfigureAwait(false);
        var wallStart = Stopwatch.GetTimestamp();
        await DelayUntilAsync(end).ConfigureAwait(false);
        var after = await ReadGcAsync(client, path).ConfigureAwait(false);
        var wallMilliseconds = Stopwatch.GetElapsedTime(wallStart).TotalMilliseconds;
        return new GcUsage(
            (after.PauseMs - before.PauseMs) / wallMilliseconds * 100,
            after.Gen0 - before.Gen0,
            after.Gen1 - before.Gen1,
            after.Gen2 - before.Gen2,
            after.Allocated - before.Allocated);
    }

    private static async Task<(long Gen0, long Gen1, long Gen2, double PauseMs, long Allocated)> ReadGcAsync(HttpClient client, string path)
    {
        await using var body = await client.GetStreamAsync(path).ConfigureAwait(false);
        using var document = await JsonDocument.ParseAsync(body).ConfigureAwait(false);
        var gc = document.RootElement.GetProperty("gc");
        return (
            gc.GetProperty("gen0").GetInt64(),
            gc.GetProperty("gen1").GetInt64(),
            gc.GetProperty("gen2").GetInt64(),
            gc.GetProperty("pauseMs").GetDouble(),
            gc.GetProperty("allocatedBytes").GetInt64());
    }

    private static async Task DelayUntilAsync(long timestamp)
    {
        var remaining = Stopwatch.GetElapsedTime(Stopwatch.GetTimestamp(), timestamp);
        if (remaining > TimeSpan.Zero)
        {
            await Task.Delay(remaining).ConfigureAwait(false);
        }
    }

    private sealed class Worker(int buckets)
    {
        public LatencyHistogram Latency { get; } = new();

        public long Errors { get; private set; }

        public long Bytes { get; private set; }

        public Dictionary<int, long> Statuses { get; } = [];

        public Dictionary<int, long> Failures { get; } = [];

        public long[] Timeline { get; } = new long[buckets];

        public async Task RunAsync(IPEndPoint endPoint, byte[][] requests, bool random, int seed, int offset, long measureStart, long end)
        {
            using var connection = new HttpConnection(endPoint);
            var rng = new Random(seed);
            for (var next = offset; ; next++)
            {
                var request = requests[random ? rng.Next(requests.Length) : next % requests.Length];
                var started = Stopwatch.GetTimestamp();
                if (started >= end)
                {
                    return;
                }

                var exchange = await connection.SendAsync(request).ConfigureAwait(false);
                if (started < measureStart)
                {
                    continue;
                }

                if (!exchange.Failed && exchange.Status is >= 200 and <= 399)
                {
                    Latency.Record(Stopwatch.GetElapsedTime(started).Ticks / (TimeSpan.TicksPerMillisecond / 1000));
                    Bytes += exchange.Bytes;
                    Statuses[exchange.Status] = Statuses.GetValueOrDefault(exchange.Status) + 1;
                    var bucket = (int)((started - measureStart) / Stopwatch.Frequency);
                    Timeline[Math.Min(bucket, Timeline.Length - 1)]++;
                }
                else
                {
                    Errors++;
                    Failures[exchange.Status] = Failures.GetValueOrDefault(exchange.Status) + 1;
                }
            }
        }
    }
}
