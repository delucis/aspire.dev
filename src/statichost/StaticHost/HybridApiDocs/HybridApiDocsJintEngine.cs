#if HYBRID_API_DOCS_JINT
using System.Net;
using AstroJint.AspNetCore;
using Microsoft.Extensions.Options;

namespace StaticHost.HybridApiDocs;

/// <summary>Settings for rendering API pages in process, bound from <c>HybridApiDocs:Jint</c>.</summary>
internal sealed class HybridApiDocsJintOptions
{
    /// <summary>The most renders kept for reuse. The Node renderer keeps 128 in each of its two processes.</summary>
    public int CacheEntries { get; set; } = 256;

    /// <summary>The most body bytes kept for reuse, so large pages cannot exhaust the process.</summary>
    public long CacheBytes { get; set; } = 128L * 1024 * 1024;

    /// <summary>How long a render is reused. This matches the Astro cache of the Node renderer.</summary>
    public TimeSpan CacheDuration { get; set; } = TimeSpan.FromMinutes(30);
}

/// <summary>
/// Renders pages with astro-jint inside the StaticHost process. astro-jint exposes its renderer as an endpoint, so the
/// engine maps it on a private route table and calls the endpoint's delegate with a context of its own: no network hop,
/// no second process.
/// </summary>
internal sealed class HybridApiDocsJintEngine : IHybridApiDocsEngine
{
    private static readonly HashSet<string> ExcludedHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length", "TE", "Trailer",
        "Upgrade", "Proxy-Authenticate", "Proxy-Authorization", "X-Aspire-Build-Id",
    };

    private static readonly KeyValuePair<string, string[]> CacheHit = KeyValuePair.Create("X-Astro-Cache", new[] { "HIT" });
    private static readonly KeyValuePair<string, string[]> CacheMiss = KeyValuePair.Create("X-Astro-Cache", new[] { "MISS" });

    private readonly RequestDelegate _astro;
    private readonly IServiceProvider _services;
    private readonly HybridApiDocsArtifact _artifact;
    private readonly HybridApiDocsResponseCache _cache;
    private readonly ILogger<HybridApiDocsJintEngine> _logger;
    private readonly object _probeGate = new();
    private Task<bool>? _probe;
    private volatile bool _ready;

    public HybridApiDocsJintEngine(IServiceProvider services, HybridApiDocsArtifact artifact,
        IOptions<HybridApiDocsJintOptions> options, ILogger<HybridApiDocsJintEngine> logger)
    {
        _services = services;
        _artifact = artifact;
        _logger = logger;
        var settings = options.Value;
        _cache = new HybridApiDocsResponseCache(settings.CacheEntries, settings.CacheBytes, settings.CacheDuration);

        var routes = new PrivateRouteBuilder(services);
        routes.MapAstro();
        _astro = routes.DataSources.SelectMany(source => source.Endpoints).OfType<RouteEndpoint>().Single().RequestDelegate
            ?? throw new InvalidOperationException("astro-jint mapped an endpoint without a request delegate.");
    }

    public async Task<HybridApiDocsResponse> RenderAsync(string upstream)
    {
        if (_cache.TryGet(upstream, out var cached))
            return Tag(cached!, CacheHit);

        var result = await RenderCoreAsync(upstream);
        if (result.Unavailable) return result;
        if (result is { Status: 200, Cacheable: true }) _cache.Set(upstream, result);
        return Tag(result, CacheMiss);
    }

    public Task<bool> IsReadyAsync(CancellationToken cancellationToken)
    {
        if (_ready) return Task.FromResult(true);
        Task<bool> probe;
        lock (_probeGate)
        {
            // A failed probe is replaced by the next caller, so readiness recovers without a restart.
            if (_probe is not { IsCompleted: false }) _probe = Task.Run(ProbeAsync, CancellationToken.None);
            probe = _probe;
        }
        return probe.WaitAsync(cancellationToken);
    }

    // The first render loads the site's data layer, so it doubles as the warm-up that readiness waits for.
    private async Task<bool> ProbeAsync()
    {
        try
        {
            var path = _artifact.Manifest.Routes.Select(route => route.Html)
                .FirstOrDefault(html => html?.Split('/').Length >= 7);
            if (path is null)
            {
                _logger.LogError("The artifact has no API detail route for rendering readiness.");
                return false;
            }

            var result = await RenderCoreAsync(path);
            _ready = result is { Unavailable: false, Status: 200 } && result.Body.AsSpan().IndexOf("<html"u8) >= 0;
            if (!_ready)
                _logger.LogWarning("Jint readiness render of {Path} returned HTTP {Status}", path, result.Status);
            return _ready;
        }
        catch (Exception error)
        {
            _logger.LogError(error, "Jint readiness render failed");
            return false;
        }
    }

    private async Task<HybridApiDocsResponse> RenderCoreAsync(string upstream)
    {
        // The shared render outlives any single caller, so only this deadline cancels it.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var separator = upstream.IndexOf('?');
        var context = new DefaultHttpContext { RequestServices = _services, RequestAborted = timeout.Token };
        var request = context.Request;
        request.Method = HttpMethods.Get;
        request.Scheme = _artifact.Site.Scheme;
        request.Host = new HostString(_artifact.Site.Authority);
        request.Path = new PathString(separator < 0 ? upstream : upstream[..separator]);
        request.QueryString = separator < 0 ? QueryString.Empty : new QueryString(upstream[separator..]);
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        using var body = new MemoryStream();
        context.Response.Body = body;

        try
        {
            await _astro(context);
        }
        catch (Exception error) when (error is not OperationCanceledException || !timeout.IsCancellationRequested)
        {
            _logger.LogError(error, "Hybrid API Jint render failed for {Path}", upstream);
            return HybridApiDocsResponse.Failure(StatusCodes.Status502BadGateway);
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("Hybrid API Jint render timed out for {Path}", upstream);
            return HybridApiDocsResponse.Failure(StatusCodes.Status504GatewayTimeout);
        }

        var response = context.Response;
        if (timeout.IsCancellationRequested)
            return HybridApiDocsResponse.Failure(StatusCodes.Status504GatewayTimeout);
        if (response.StatusCode is StatusCodes.Status502BadGateway or StatusCodes.Status503ServiceUnavailable
            or StatusCodes.Status504GatewayTimeout)
        {
            _logger.LogWarning("Hybrid API Jint render of {Path} returned HTTP {Status}", upstream, response.StatusCode);
            return HybridApiDocsResponse.Failure(response.StatusCode);
        }
        if (body.Length > HybridApiDocsRenderer.MaximumBodySize)
        {
            _logger.LogError("Hybrid API Jint render of {Path} exceeded the maximum body size", upstream);
            return HybridApiDocsResponse.Failure(StatusCodes.Status502BadGateway);
        }

        var headers = response.Headers.Where(header => !ExcludedHeaders.Contains(header.Key))
            .Select(header => KeyValuePair.Create(header.Key, header.Value.OfType<string>().ToArray())).ToArray();
        var privateOrCookie = response.Headers.CacheControl.ToString().Contains("private", StringComparison.OrdinalIgnoreCase)
            || response.Headers.ContainsKey("Set-Cookie");
        return new HybridApiDocsResponse(response.StatusCode, headers, body.ToArray(), false,
            response.StatusCode is >= 200 and < 300 && !privateOrCookie);
    }

    private static HybridApiDocsResponse Tag(HybridApiDocsResponse response, KeyValuePair<string, string[]> status)
        => response with { Headers = [.. response.Headers, status] };

    // astro-jint maps itself as a fallback endpoint; this route table lets the engine reach that endpoint's delegate
    // without registering a fallback on the application, which would render every unmatched request.
    private sealed class PrivateRouteBuilder(IServiceProvider services) : IEndpointRouteBuilder
    {
        public IServiceProvider ServiceProvider => services;

        public ICollection<EndpointDataSource> DataSources { get; } = [];

        public IApplicationBuilder CreateApplicationBuilder() => new ApplicationBuilder(services);
    }
}
#endif
