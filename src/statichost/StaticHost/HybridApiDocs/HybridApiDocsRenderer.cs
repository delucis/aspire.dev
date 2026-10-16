using Microsoft.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

namespace StaticHost.HybridApiDocs;

internal sealed class HybridApiDocsRenderer(HybridApiDocsArtifact artifact, IHybridApiDocsEngine engine,
    HybridApiDocsFlights flights, ILogger<HybridApiDocsRenderer> logger)
{
    internal const long MaximumBodySize = 64 * 1024 * 1024;

    public async Task RenderAsync(HttpContext context)
    {
        var selection = context.Features.Get<HybridApiDocsRequest>();
        if (selection is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            context.Response.Headers.CacheControl = "no-store";
            await NotFoundPage.WriteAsync(context);
            return;
        }

        // Pages never vary by query string, so it is not forwarded and cannot multiply renders.
        var image = selection.Representation == "image";
        var upstream = image ? selection.RendererPath + context.Request.QueryString : selection.RendererPath;

        // A page is immutable for a build, so a matching validator is answered without the renderer.
        var etag = selection.Representation is "html" or "markdown" ? ETagFor(selection.RendererPath) : null;
        if (etag is not null && IsNotModified(context.Request, etag))
        {
            context.Response.StatusCode = StatusCodes.Status304NotModified;
            context.Response.Headers.ETag = etag;
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers["X-Aspire-Build-Id"] = artifact.Manifest.BuildId;
            return;
        }

        HybridApiDocsResponse result;
        try
        {
            var flight = flights.Requests.GetOrAdd(upstream, key => new(() => FetchSharedAsync(key)));
            result = await flight.Value.WaitAsync(context.RequestAborted);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            context.Abort();
            return;
        }

        if (result.Unavailable)
        {
            await HybridApiDocsErrorPages.WriteUnavailableAsync(context, result.Status);
            return;
        }

        var response = context.Response;
        response.StatusCode = result.Status;
        foreach (var (key, values) in result.Headers) response.Headers[key] = values;
        var vary = response.Headers.Vary.ToString().Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Where(value => !value.Equals("X-Aspire-Cache-Bypass", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (vary.Length == 0) response.Headers.Remove("Vary");
        else response.Headers.Vary = string.Join(", ", vary);
        if (selection.Representation == "markdown-negotiated")
        {
            response.Headers.CacheControl = "private, no-store";
            response.Headers.Vary = "Accept";
        }
        else if (result.Cacheable && etag is not null)
        {
            response.Headers.CacheControl = "no-cache";
            response.Headers.ETag = etag;
        }
        else
        {
            response.Headers.CacheControl = IsPrivate(result) ? "private, no-store" : "no-store";
        }
        response.Headers["X-Aspire-Build-Id"] = artifact.Manifest.BuildId;
        response.ContentLength = result.Body.Length;
        if (!HttpMethods.IsHead(context.Request.Method))
            await response.Body.WriteAsync(result.Body, context.RequestAborted);
        logger.LogInformation("Forwarded hybrid API {Path} ({Bytes} bytes, Astro cache {CacheStatus}) from build {BuildId}",
            selection.RendererPath, result.Body.Length, result.CacheStatus ?? "bypass", artifact.Manifest.BuildId);
    }

    public Task<bool> IsReadyAsync(CancellationToken cancellationToken) => engine.IsReadyAsync(cancellationToken);

    private async Task<HybridApiDocsResponse> FetchSharedAsync(string upstream)
    {
        // Yield so the in-flight entry is always registered before it can be removed.
        await Task.Yield();
        try
        {
            return await engine.RenderAsync(upstream);
        }
        finally
        {
            flights.Requests.TryRemove(upstream, out _);
        }
    }

    private static bool IsPrivate(HybridApiDocsResponse result) => result.Headers.Any(header =>
        header.Key.Equals("Cache-Control", StringComparison.OrdinalIgnoreCase)
        && header.Value.Any(value => value.Contains("private", StringComparison.OrdinalIgnoreCase)));

    private string ETagFor(string rendererPath)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{artifact.Manifest.BuildId}\n{rendererPath}"));
        return $"W/\"{Convert.ToHexStringLower(hash.AsSpan(0, 12))}\"";
    }

    private static bool IsNotModified(HttpRequest request, string etag)
    {
        var current = EntityTagHeaderValue.Parse(etag);
        return request.GetTypedHeaders().IfNoneMatch
            .Any(candidate => candidate == EntityTagHeaderValue.Any || candidate.Compare(current, useStrongComparison: false));
    }
}
