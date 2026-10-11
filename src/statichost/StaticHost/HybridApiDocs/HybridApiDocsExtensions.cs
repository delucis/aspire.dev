using System.Net;

namespace StaticHost.HybridApiDocs;

internal static class HybridApiDocsExtensions
{
    public static void AddHybridApiDocs(this IServiceCollection services,
        HybridApiDocsArtifact artifact, string? rendererUrl)
    {
        if (!Uri.TryCreate(rendererUrl, UriKind.Absolute, out var renderer) ||
            renderer.Scheme is not ("http" or "https"))
            throw new InvalidOperationException("HybridApiDocs:RendererUrl must specify the private Astro worker endpoint.");
        services.AddSingleton(artifact);
        services.AddHttpClient<HybridApiDocsRenderer>(client =>
        {
            client.BaseAddress = renderer;
            client.Timeout = Timeout.InfiniteTimeSpan;
            client.MaxResponseContentBufferSize = HybridApiDocsRenderer.MaximumBodySize;
        }).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
        {
            UseProxy = false, UseCookies = false, AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(5),
        });
        services.AddOutputCache(options =>
        {
            options.SizeLimit = 128 * 1024 * 1024;
            options.MaximumBodySize = HybridApiDocsRenderer.MaximumBodySize;
            options.AddPolicy("HybridApiDocs", policy => policy
                .Expire(TimeSpan.FromMinutes(30))
                .VaryByValue("build", artifact.Manifest.BuildId)
                .VaryByValue(context => new KeyValuePair<string, string>("representation",
                    context.Features.Get<HybridApiDocsRequest>()?.Representation ?? "none"))
                .AddPolicy<HybridApiDocsCachePolicy>());
        });
    }

    public static void UseHybridApiDocsRouting(this IApplicationBuilder app)
        => app.UseMiddleware<HybridApiDocsRoutingMiddleware>();

    public static void MapHybridApiDocs(this IEndpointRouteBuilder app)
    {
        app.MapMethods("/reference/api/{**path}", ["GET", "HEAD"],
            (HttpContext context, HybridApiDocsRenderer renderer) => renderer.RenderAsync(context))
            .CacheOutput("HybridApiDocs");
        app.MapMethods("/_image", ["GET", "HEAD"],
            (HttpContext context, HybridApiDocsRenderer renderer) => renderer.RenderAsync(context))
            .CacheOutput("HybridApiDocs");
    }
}
