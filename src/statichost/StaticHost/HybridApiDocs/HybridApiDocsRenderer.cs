using System.Net;

namespace StaticHost.HybridApiDocs;

internal sealed class HybridApiDocsRenderer(HttpClient client, HybridApiDocsArtifact artifact, HybridApiDocsEndpointPool endpoints,
    ILogger<HybridApiDocsRenderer> logger)
{
    internal const long MaximumBodySize = 64 * 1024 * 1024;
    private static readonly HashSet<string> ExcludedHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length", "TE", "Trailer",
        "Upgrade", "Proxy-Authenticate", "Proxy-Authorization", "X-Aspire-Build-Id",
    };

    public async Task RenderAsync(HttpContext context)
    {
        var selection = context.Features.Get<HybridApiDocsRequest>();
        if (selection is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        var candidates = endpoints.Candidates().ToArray();
        var timedOut = false;
        for (var index = 0; index < candidates.Length; index++)
        {
            using var attempt = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token);
            attempt.CancelAfter(TimeSpan.FromSeconds(10));
            using var request = new HttpRequestMessage(HttpMethod.Get,
                new Uri(candidates[index].Address, selection.RendererPath + context.Request.QueryString));
            request.Headers.Host = artifact.Site.Authority;
            request.Headers.TryAddWithoutValidation("X-Forwarded-Host", artifact.Site.Authority);
            request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", artifact.Site.Scheme);
            if (context.Request.Headers.Authorization.Count > 0 || context.User.Identity?.IsAuthenticated == true)
                request.Headers.TryAddWithoutValidation("X-Aspire-Cache-Bypass", "1");
            try
            {
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, attempt.Token);
                if (!MatchesBuild(response))
                    throw new HttpRequestException("The renderer and StaticHost have different build identities.");
                if ((int)response.StatusCode >= 500 && index < candidates.Length - 1)
                {
                    logger.LogWarning("Renderer {Endpoint} returned {Status}; trying another replica",
                        candidates[index].Address, (int)response.StatusCode);
                    continue;
                }
                await response.Content.LoadIntoBufferAsync(MaximumBodySize, attempt.Token);
                var body = await response.Content.ReadAsByteArrayAsync(attempt.Token);
                context.Response.StatusCode = (int)response.StatusCode;
                var excluded = new HashSet<string>(ExcludedHeaders, StringComparer.OrdinalIgnoreCase);
                foreach (var value in response.Headers.Connection) excluded.Add(value);
                foreach (var header in response.Headers.Concat(response.Content.Headers))
                {
                    if (!excluded.Contains(header.Key)) context.Response.Headers[header.Key] = header.Value.ToArray();
                }
                var vary = context.Response.Headers.Vary.ToString().Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                    .Where(value => !value.Equals("X-Aspire-Cache-Bypass", StringComparison.OrdinalIgnoreCase)).ToArray();
                if (vary.Length == 0) context.Response.Headers.Remove("Vary");
                else context.Response.Headers.Vary = string.Join(", ", vary);
                if (selection.Representation == "markdown-negotiated")
                {
                    context.Response.Headers.CacheControl = "private, no-store";
                    context.Response.Headers.Vary = "Accept";
                }
                else
                    context.Response.Headers.CacheControl = response.Headers.CacheControl?.Private == true
                        ? "private, no-store" : "no-store";
                if ((int)response.StatusCode >= 500) context.Response.Headers.CacheControl = "no-store";
                context.Response.Headers["X-Aspire-Build-Id"] = artifact.Manifest.BuildId;
                context.Response.ContentLength = body.Length;
                if ((int)response.StatusCode < 500) endpoints.Prefer(candidates[index].Index);
                if (!HttpMethods.IsHead(context.Request.Method))
                    await context.Response.Body.WriteAsync(body, context.RequestAborted);
                logger.LogInformation("Forwarded hybrid API {Path} ({Bytes} bytes, Astro cache {CacheStatus}) from build {BuildId}",
                    selection.RendererPath, body.Length,
                    response.Headers.TryGetValues("X-Astro-Cache", out var cacheStatus) ? string.Join(", ", cacheStatus) : "bypass",
                    artifact.Manifest.BuildId);
                return;
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                context.Abort();
                return;
            }
            catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException)
            {
                timedOut = error is OperationCanceledException;
                logger.LogWarning(error, "Hybrid API renderer {Endpoint} failed for {Path}",
                    candidates[index].Address, selection.RendererPath);
                if (context.Response.HasStarted)
                {
                    context.Abort();
                    return;
                }
                if (timeout.IsCancellationRequested) break;
            }
        }
        logger.LogError("All hybrid API renderers failed for {Path}", selection.RendererPath);
        context.Response.StatusCode = timedOut ? StatusCodes.Status504GatewayTimeout : StatusCodes.Status502BadGateway;
        context.Response.Headers.CacheControl = "no-store";
    }

    public async Task<bool> IsReadyAsync(CancellationToken cancellationToken)
    {
        foreach (var candidate in endpoints.Candidates())
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            try
            {
                using var response = await client.GetAsync(
                    new Uri(candidate.Address, "/__hybrid-api-docs/health"), HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if (response.IsSuccessStatusCode && MatchesBuild(response)) return true;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException)
            {
                logger.LogWarning(error, "Hybrid API readiness probe failed for {Endpoint}", candidate.Address);
            }
        }
        return false;
    }

    private bool MatchesBuild(HttpResponseMessage response)
        => response.Headers.TryGetValues("X-Aspire-Build-Id", out var ids)
            && ids.SequenceEqual([artifact.Manifest.BuildId]);
}
