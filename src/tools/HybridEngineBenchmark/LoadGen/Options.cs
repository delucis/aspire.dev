using System.Globalization;

namespace LoadGen;

internal sealed record Options(
    IReadOnlyList<Uri> Urls,
    IReadOnlyList<string> Paths,
    IReadOnlyList<string> Headers,
    string Mode,
    int Connections,
    TimeSpan Warmup,
    TimeSpan Duration,
    int Repeat,
    bool RandomSelection,
    int Seed,
    int[] Pids,
    string Label,
    string? OutPath,
    string? GcStatsPath,
    long? Affinity,
    long? ServerAffinity)
{
    /// <summary>The first address: it names the run, takes the Host header by default and serves the GC statistics.</summary>
    public Uri Url => Urls[0];

    public const string Usage = """
        Usage: LoadGen --url <http://host:port>[,<http://host:port>...] (--paths-file <file> | --path <p>...) [options]

          --url <addresses>        one address, or several separated by commas: connection i talks to address i mod count,
                                   which models a balancer that spreads the connections evenly over several servers

          --mode load|sequence     load: closed-loop connections for --duration (default). sequence: one connection, every
                                   path --repeat times in order, to read cold and warm latencies one request at a time.
          --connections <n>        keep-alive connections in load mode (default 16)
          --duration <s>           measured seconds in load mode (default 15)
          --warmup <s>             seconds that are sent but not counted (default 3)
          --repeat <n>             requests per path in sequence mode (default 5)
          --select random|sequential   how a connection picks its next path (default random; a path listed twice is twice as likely)
          --seed <n>               seed of the random selection (default 1)
          --header "Name: value"   sent with every request, repeatable (Host, X-Forwarded-*, Accept-Encoding...)
          --pid <id>[,<id>...]     server processes whose processor time and memory are measured
          --gc-stats <path>        a JSON endpoint with a "gc" object (gen0, gen1, gen2, pauseMs, allocatedBytes)
          --label <text>           names the run in the report
          --out <file.json>        writes the full result as JSON; '-' prints it to the standard output as one line that starts with "#json "
          --affinity <hex mask>    logical processors the generator itself may use (for example 0xFF00)
          --server-affinity <hex mask>   logical processors the --pid servers may use, to model a smaller machine
        """;

    public static Options Parse(string[] args)
    {
        IReadOnlyList<Uri> urls = [new Uri("http://127.0.0.1:4323")];
        long? affinity = null;
        long? serverAffinity = null;
        List<string> paths = [];
        List<string> headers = [];
        var mode = "load";
        var connections = 16;
        var warmup = 3d;
        var duration = 15d;
        var repeat = 5;
        var random = true;
        var seed = 1;
        int[] pids = [];
        var label = "run";
        string? outPath = null;
        string? gcStats = null;

        for (var i = 0; i < args.Length; i += 2)
        {
            var name = args[i];
            var value = i + 1 < args.Length ? args[i + 1] : throw new ArgumentException($"{name} needs a value.");
            switch (name)
            {
                case "--url":
                    urls = value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .Select(static v => Uri.TryCreate(v, UriKind.Absolute, out var parsed) && parsed.Scheme == Uri.UriSchemeHttp
                            ? parsed
                            : throw new ArgumentException($"--url must be absolute http addresses, not '{v}'."))
                        .ToArray();
                    break;
                case "--affinity":
                    affinity = Mask(name, value);
                    break;
                case "--server-affinity":
                    serverAffinity = Mask(name, value);
                    break;
                case "--paths-file":
                    paths.AddRange(File.ReadLines(value).Select(static l => l.Trim()).Where(static l => l.Length > 0 && l[0] != '#'));
                    break;
                case "--path":
                    paths.Add(value);
                    break;
                case "--header":
                    headers.Add(value);
                    break;
                case "--mode":
                    mode = value is "load" or "sequence" ? value : throw new ArgumentException("--mode is load or sequence.");
                    break;
                case "--connections":
                    connections = PositiveInt(name, value);
                    break;
                case "--duration":
                    duration = Seconds(name, value, 1);
                    break;
                case "--warmup":
                    warmup = Seconds(name, value, 0);
                    break;
                case "--repeat":
                    repeat = PositiveInt(name, value);
                    break;
                case "--select":
                    random = value is "random" ? true : value is "sequential" ? false : throw new ArgumentException("--select is random or sequential.");
                    break;
                case "--seed":
                    seed = int.Parse(value, CultureInfo.InvariantCulture);
                    break;
                case "--pid":
                    pids = value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .Select(static v => int.Parse(v, CultureInfo.InvariantCulture)).ToArray();
                    break;
                case "--gc-stats":
                    gcStats = value.StartsWith('/') ? value : throw new ArgumentException("--gc-stats must start with '/'.");
                    break;
                case "--label":
                    label = value;
                    break;
                case "--out":
                    outPath = value;
                    break;
                default:
                    throw new ArgumentException($"Unknown option {name}.");
            }
        }

        return paths.Count == 0
            ? throw new ArgumentException("Give --paths-file or at least one --path.")
            : urls.Count == 0
                ? throw new ArgumentException("Give at least one --url.")
                : new Options(urls, paths, headers, mode, connections, TimeSpan.FromSeconds(warmup), TimeSpan.FromSeconds(duration), repeat, random, seed, pids, label, outPath, gcStats, affinity, serverAffinity);
    }

    private static long Mask(string name, string value) =>
        long.TryParse(value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? value[2..] : value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var mask) && mask > 0
            ? mask
            : throw new ArgumentException($"{name} must be a hexadecimal processor mask such as 0xFF, not '{value}'.");

    private static int PositiveInt(string name, string value) =>
        int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var count) && count > 0
            ? count
            : throw new ArgumentException($"{name} must be a positive number, not '{value}'.");

    private static double Seconds(string name, string value, double minimum) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) && seconds >= minimum
            ? seconds
            : throw new ArgumentException($"{name} must be a number of seconds, at least {minimum}, not '{value}'.");
}
