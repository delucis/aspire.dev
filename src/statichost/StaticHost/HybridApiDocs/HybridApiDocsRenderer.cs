using System.Net;
using Microsoft.AspNetCore.OutputCaching;

namespace StaticHost.HybridApiDocs;

internal sealed class HybridApiDocsRenderer(HttpClient client, HybridApiDocsArtifact artifact,
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
        using var request = new HttpRequestMessage(HttpMethod.Get,
            selection.RendererPath + context.Request.QueryString);
        request.Headers.Host = artifact.Site.Authority;
        request.Headers.TryAddWithoutValidation("X-Forwarded-Host", artifact.Site.Authority);
        request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", artifact.Site.Scheme);
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.Headers.TryGetValues("X-Aspire-Build-Id", out var ids) ||
                ids.SingleOrDefault() != artifact.Manifest.BuildId)
                throw new HttpRequestException("The renderer and StaticHost have different build identities.");
            await response.Content.LoadIntoBufferAsync(MaximumBodySize, timeout.Token);
            var body = await response.Content.ReadAsByteArrayAsync(timeout.Token);
            var control = response.Headers.CacheControl;
            selection.Cacheable = !(control?.Private == true || control?.NoStore == true || control?.NoCache == true);
            context.Response.StatusCode = (int)response.StatusCode;
            var excluded = new HashSet<string>(ExcludedHeaders, StringComparer.OrdinalIgnoreCase);
            foreach (var value in response.Headers.Connection) excluded.Add(value);
            foreach (var header in response.Headers.Concat(response.Content.Headers))
            {
                if (!excluded.Contains(header.Key)) context.Response.Headers[header.Key] = header.Value.ToArray();
            }
            if (selection.Representation == "markdown-negotiated")
            {
                context.Response.Headers.CacheControl = "private, max-age=0, must-revalidate";
                context.Response.Headers.Vary = "Accept";
            }
            else if (!context.Response.Headers.ContainsKey("Cache-Control"))
                context.Response.Headers.CacheControl = "public, max-age=0, must-revalidate";
            context.Response.Headers["X-Aspire-Build-Id"] = artifact.Manifest.BuildId;
            context.Response.ContentLength = body.Length;
            if (!HttpMethods.IsHead(context.Request.Method))
                await context.Response.Body.WriteAsync(body, context.RequestAborted);
            logger.LogInformation("Rendered hybrid API {Path} ({Bytes} bytes) from build {BuildId}",
                selection.RendererPath, body.Length, artifact.Manifest.BuildId);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            selection.Cacheable = false;
            context.Abort();
        }
        catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException)
        {
            selection.Cacheable = false;
            logger.LogError(error, "Hybrid API rendering failed for {Path}", selection.RendererPath);
            if (context.Response.HasStarted)
            {
                context.Abort();
                return;
            }
            context.Response.StatusCode = error is OperationCanceledException
                ? StatusCodes.Status504GatewayTimeout : StatusCodes.Status502BadGateway;
            context.Response.Headers.CacheControl = "no-store";
        }
    }
}

internal sealed class HybridApiDocsCachePolicy : IOutputCachePolicy
{
    public ValueTask CacheRequestAsync(OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;

    public ValueTask ServeFromCacheAsync(OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;

    public ValueTask ServeResponseAsync(OutputCacheContext context, CancellationToken cancellationToken)
    {
        if (context.HttpContext.Features.Get<HybridApiDocsRequest>()?.Cacheable != true)
            context.AllowCacheStorage = false;
        return ValueTask.CompletedTask;
    }
}
