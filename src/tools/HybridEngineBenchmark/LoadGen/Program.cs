using System.Diagnostics;
using System.Globalization;
using System.Runtime.Versioning;
using System.Text.Json;

namespace LoadGen;

internal static class Program
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static async Task<int> Main(string[] args)
    {
        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException or IOException)
        {
            Console.Error.WriteLine(ex.Message);
            Console.Error.WriteLine(Options.Usage);
            return 2;
        }

        try
        {
            if (options.Affinity is not null || options.ServerAffinity is not null)
            {
                if (OperatingSystem.IsWindows() || OperatingSystem.IsLinux())
                {
                    ApplyAffinity(options);
                }
                else
                {
                    throw new InvalidOperationException("Processor affinity is supported on Windows and Linux only.");
                }
            }

            object report;
            if (options.Mode == "sequence")
            {
                var sequence = await Runner.RunSequenceAsync(options).ConfigureAwait(false);
                PrintSequence(sequence);
                report = sequence;
            }
            else
            {
                var load = await Runner.RunLoadAsync(options).ConfigureAwait(false);
                PrintLoad(load);
                report = load;
            }

            if (options.OutPath is { } path)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
                await File.WriteAllTextAsync(path, JsonSerializer.Serialize(report, s_json)).ConfigureAwait(false);
            }

            return 0;
        }
        catch (InvalidOperationException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    private static string Mb(long bytes) => (bytes / 1048576d).ToString("N0", CultureInfo.InvariantCulture) + " MB";

    [SupportedOSPlatform("windows")]
    [SupportedOSPlatform("linux")]
    private static void ApplyAffinity(Options options)
    {
        if (options.Affinity is { } own)
        {
            using var self = Process.GetCurrentProcess();
            self.ProcessorAffinity = (nint)own;
        }

        if (options.ServerAffinity is { } mask)
        {
            foreach (var pid in options.Pids)
            {
                using var server = Process.GetProcessById(pid);
                server.ProcessorAffinity = (nint)mask;
            }
        }
    }

    private static string Ms(double ms) => ms >= 100 ? ms.ToString("N0", CultureInfo.InvariantCulture) : ms.ToString("N2", CultureInfo.InvariantCulture);

    private static void PrintLoad(LoadReport r)
    {
        var c = CultureInfo.InvariantCulture;
        Console.WriteLine($"[{r.Label}] {r.Connections} connections, {r.Seconds:N0}s, {r.UniquePaths:N0} distinct paths -> {r.Url}");
        Console.WriteLine($"  requests {r.Requests:N0}  rps {r.RequestsPerSecond.ToString("N1", c)}  errors {r.Errors:N0}{(r.Failures.Count > 0 ? " (" + string.Join(", ", r.Failures.Select(f => f.Key + ":" + f.Value)) + ")" : string.Empty)}  avg {(r.AverageBytes / 1024).ToString("N1", c)} KB  status {string.Join(", ", r.Statuses.Select(s => s.Key + ":" + s.Value))}");
        Console.WriteLine($"  latency ms  mean {Ms(r.Latency.Mean)}  p50 {Ms(r.Latency.P50)}  p90 {Ms(r.Latency.P90)}  p95 {Ms(r.Latency.P95)}  p99 {Ms(r.Latency.P99)}  p99.9 {Ms(r.Latency.P999)}  max {Ms(r.Latency.Max)}");
        if (r.Server is { } s)
        {
            Console.WriteLine($"  server  cores {s.ServerCores.ToString("N2", c)}  cpu-ms/request {(r.Requests == 0 ? 0 : s.ServerCpuSeconds * 1000 / r.Requests).ToString("N2", c)}  rss {Mb(s.ServerRssStartBytes)} -> {Mb(s.ServerRssEndBytes)} (peak {Mb(s.ServerRssPeakBytes)}, private peak {Mb(s.ServerPrivatePeakBytes)})  | generator cores {s.GeneratorCores.ToString("N2", c)}");
        }

        if (r.Gc is { } gc)
        {
            Console.WriteLine($"  gc      pause {gc.PausePercent.ToString("N1", c)}%  gen0 {gc.Gen0:N0}  gen1 {gc.Gen1:N0}  gen2 {gc.Gen2:N0}  allocated {(r.Requests == 0 ? 0 : gc.AllocatedBytes / 1024d / r.Requests).ToString("N0", c)} KB/request");
        }
    }

    private static void PrintSequence(SequenceReport r)
    {
        var c = CultureInfo.InvariantCulture;
        Console.WriteLine($"[{r.Label}] sequence -> {r.Url}");
        Console.WriteLine($"  {"first",9} {"second",9} {"median*",9} {"min",9}  status  {"KB",7}  path");
        foreach (var e in r.Entries)
        {
            var rest = e.Milliseconds.Skip(1).Order().ToArray();
            var median = rest.Length == 0 ? double.NaN : rest[rest.Length / 2];
            Console.WriteLine($"  {Ms(e.Milliseconds[0]),9} {(e.Milliseconds.Length > 1 ? Ms(e.Milliseconds[1]) : "-"),9} {(double.IsNaN(median) ? "-" : Ms(median)),9} {Ms(e.Milliseconds.Min()),9}  {e.Status,6}  {(e.Bytes / 1024d).ToString("N1", c),7}  {e.Path}");
        }

        Console.WriteLine("  (* median of requests after the first)");
    }
}
