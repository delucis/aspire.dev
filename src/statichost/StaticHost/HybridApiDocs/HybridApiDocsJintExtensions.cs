#if HYBRID_API_DOCS_JINT
using AstroJint.AspNetCore;

namespace StaticHost.HybridApiDocs;

internal static class HybridApiDocsJintExtensions
{
    /// <summary>Renders API pages in process with astro-jint instead of in Node sidecars.</summary>
    internal static void AddHybridApiDocsJint(this IServiceCollection services, HybridApiDocsArtifact artifact)
    {
        services.AddHybridApiDocsCore(artifact);
        services.AddOptions<AstroOptions>()
            .Configure(options =>
            {
                options.DistPath = artifact.RootDirectory;
                // StaticHost serves the client itself, so astro-jint keeps no copies of its files in memory.
                options.StaticFileCacheBytes = 0;
                // The engine's own 30 second deadline is the backstop; this one reports the more precise status.
                options.RequestTimeout = TimeSpan.FromSeconds(25);
            })
            .BindConfiguration("Astro");
        services.AddAstro();
        services.AddOptions<HybridApiDocsJintOptions>().BindConfiguration("HybridApiDocs:Jint");
        services.AddSingleton<HybridApiDocsJintEngine>();
        services.AddSingleton<IHybridApiDocsEngine>(provider => provider.GetRequiredService<HybridApiDocsJintEngine>());
    }
}
#endif
