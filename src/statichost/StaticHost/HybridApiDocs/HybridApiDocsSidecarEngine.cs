namespace StaticHost.HybridApiDocs;

/// <summary>Renders pages in private Node sidecars that StaticHost reaches over loopback HTTP.</summary>
internal sealed class HybridApiDocsSidecarEngine(HttpClient client, HybridApiDocsArtifact artifact,
    HybridApiDocsEndpointPool endpoints, ILogger<HybridApiDocsSidecarEngine> logger) : IHybridApiDocsEngine
{
    private static readonly HashSet<string> ExcludedHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length", "TE", "Trailer",
        "Upgrade", "Proxy-Authenticate", "Proxy-Authorization", "X-Aspire-Build-Id",
    };

    public async Task<bool> IsReadyAsync(CancellationToken cancellationToken)
    {
        foreach (var candidate in endpoints.Candidates(""))
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

    public async Task<HybridApiDocsResponse> RenderAsync(string upstream)
    {
        // The shared render outlives any single caller, so only this deadline cancels it.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var candidates = endpoints.Candidates(upstream).ToArray();
        var timedOut = false;
        for (var index = 0; index < candidates.Length; index++)
        {
            using var attempt = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token);
            attempt.CancelAfter(TimeSpan.FromSeconds(10));
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(candidates[index].Address, upstream));
            request.Headers.Host = artifact.Site.Authority;
            request.Headers.TryAddWithoutValidation("X-Forwarded-Host", artifact.Site.Authority);
            request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", artifact.Site.Scheme);
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
                await response.Content.LoadIntoBufferAsync(HybridApiDocsRenderer.MaximumBodySize, attempt.Token);
                var body = await response.Content.ReadAsByteArrayAsync(attempt.Token);
                if ((int)response.StatusCode < 500) endpoints.MarkHealthy(candidates[index].Index);

                var excluded = new HashSet<string>(ExcludedHeaders, StringComparer.OrdinalIgnoreCase);
                foreach (var value in response.Headers.Connection) excluded.Add(value);
                var headers = response.Headers.Concat(response.Content.Headers)
                    .Where(header => !excluded.Contains(header.Key))
                    .Select(header => KeyValuePair.Create(header.Key, header.Value.ToArray())).ToArray();
                var status = (int)response.StatusCode;
                var privateOrCookie = response.Headers.CacheControl?.Private == true || response.Headers.Contains("Set-Cookie");
                return new HybridApiDocsResponse(status, headers, body, false, status is >= 200 and < 300 && !privateOrCookie);
            }
            catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException)
            {
                timedOut = error is OperationCanceledException;
                endpoints.MarkFailed(candidates[index].Index);
                logger.LogWarning(error, "Hybrid API renderer {Endpoint} failed for {Path}", candidates[index].Address, upstream);
                if (timeout.IsCancellationRequested) break;
            }
        }
        logger.LogError("All hybrid API renderers failed for {Path}", upstream);
        return HybridApiDocsResponse.Failure(timedOut ? StatusCodes.Status504GatewayTimeout : StatusCodes.Status502BadGateway);
    }

    private bool MatchesBuild(HttpResponseMessage response)
        => response.Headers.TryGetValues("X-Aspire-Build-Id", out var ids)
            && ids.SequenceEqual([artifact.Manifest.BuildId]);
}
