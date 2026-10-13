using System.Net;

namespace StaticHost.HybridApiDocs;

internal static class HybridApiDocsExtensions
{
    public static void AddHybridApiDocs(this IServiceCollection services,
        HybridApiDocsArtifact artifact, string? rendererUrl)
        => services.AddHybridApiDocs(artifact, [rendererUrl ?? ""]);

    public static void AddHybridApiDocs(this IServiceCollection services,
        HybridApiDocsArtifact artifact, IEnumerable<string> rendererUrls)
    {
        var endpoints = rendererUrls.Select(value =>
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out var endpoint) ||
                endpoint.Scheme is not ("http" or "https") ||
                endpoint.UserInfo.Length > 0 || endpoint.Query.Length > 0 || endpoint.Fragment.Length > 0)
                throw new InvalidOperationException("HybridApiDocs:RendererUrls must specify private Astro worker endpoints.");
            return endpoint;
        }).Distinct().ToArray();
        if (endpoints.Length == 0)
            throw new InvalidOperationException("At least one private Astro worker endpoint is required.");
        services.AddSingleton(artifact);
        services.AddSingleton(new HybridApiDocsEndpointPool(endpoints));
        services.AddHttpClient<HybridApiDocsRenderer>(client =>
        {
            client.Timeout = Timeout.InfiniteTimeSpan;
            client.MaxResponseContentBufferSize = HybridApiDocsRenderer.MaximumBodySize;
        }).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
        {
            UseProxy = false, UseCookies = false, AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(5),
        });
    }

    public static void UseHybridApiDocsRouting(this IApplicationBuilder app)
        => app.UseMiddleware<HybridApiDocsRoutingMiddleware>();

    public static void MapHybridApiDocs(this IEndpointRouteBuilder app)
    {
        app.MapMethods("/reference/api/{**path}", ["GET", "HEAD"],
            (HttpContext context, HybridApiDocsRenderer renderer) => renderer.RenderAsync(context));
        app.MapMethods("/_image", ["GET", "HEAD"],
            (HttpContext context, HybridApiDocsRenderer renderer) => renderer.RenderAsync(context));
        app.MapGet("/healthz/api-docs", async (HttpContext context, HybridApiDocsRenderer renderer) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Results.StatusCode(await renderer.IsReadyAsync(context.RequestAborted)
                ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable);
        });
    }
}
