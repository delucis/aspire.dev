using System.Text.Json;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;

internal static class HybridApiDocsExtensions
{
    public static bool IsHybridApiDocsEnabled(string? value) => value switch
    {
        null or "0" => false,
        "1" => true,
        _ => throw new InvalidOperationException("ASPIRE_HYBRID_API_DOCS must be unset, 0, or 1."),
    };

    public static void WithHybridApiDocs(this IResourceBuilder<ProjectResource> website,
        IDistributedApplicationBuilder builder, string frontendDirectory)
    {
        var manifest = Path.GetFullPath(Path.Combine(frontendDirectory, "dist-hybrid", "hybrid-api-docs.json"));
        if (!File.Exists(manifest))
            throw new InvalidOperationException($"Download the opted-in hybrid CI artifact before starting: {manifest}");
        using var json = JsonDocument.Parse(File.ReadAllText(manifest));
        if (json.RootElement.GetProperty("mode").GetString() != "hybrid-api-docs")
            throw new InvalidOperationException("The selected artifact is not a hybrid API documentation build.");
        if (json.RootElement.GetProperty("platform").GetString() !=
            (OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux"))
            throw new InvalidOperationException("Download the hybrid CI artifact matching this operating system.");

        var worker = builder.AddNodeApp("api-docs", frontendDirectory, "scripts/serve-api-docs.mjs")
            .WithPnpm()
            .WithHttpEndpoint(env: "PORT")
            .WithEnvironment("HOST", "127.0.0.1")
            .WithEnvironment("HYBRID_API_DOCS_MANIFEST", manifest)
            .WithHttpHealthCheck("/__hybrid-api-docs/health");
        website.WithEnvironment("HybridApiDocs__ArtifactPath", manifest)
            .WithEnvironment("HybridApiDocs__RendererUrl", worker.GetEndpoint("http"));
    }
}
