using System.Text.Json;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Azure;
using Azure.Provisioning.AppService;

internal static class HybridApiDocsExtensions
{
    public static bool IsHybridApiDocsEnabled(string? value) => value switch
    {
        null or "0" => false,
        "1" => true,
        _ => throw new InvalidOperationException("ASPIRE_HYBRID_API_DOCS must be unset, 0, or 1."),
    };

    /// <summary>Selects how the on-demand API pages are rendered: Node sidecars (default) or Jint inside StaticHost.</summary>
    public static string HybridEngine(string? value) => value switch
    {
        null or "" or "node" => "node",
        "jint" => "jint",
        _ => throw new InvalidOperationException("ASPIRE_HYBRID_ENGINE must be unset, node, or jint."),
    };

    public static void WithHybridApiDocs(this IResourceBuilder<ProjectResource> website,
        IDistributedApplicationBuilder builder, string frontendDirectory)
    {
        var engine = HybridEngine(builder.Configuration["ASPIRE_HYBRID_ENGINE"]);
        var artifactDirectory = builder.Configuration["HybridApiDocsArtifactDirectory"]
            ?? Path.Combine(frontendDirectory, "dist-hybrid");
        var manifest = Path.GetFullPath(Path.Combine(artifactDirectory, "hybrid-api-docs.json"));
        if (!File.Exists(manifest))
            throw new InvalidOperationException($"Build or download the opted-in hybrid CI artifact: {manifest}");
        using var json = JsonDocument.Parse(File.ReadAllText(manifest));
        if (json.RootElement.GetProperty("mode").GetString() != "hybrid-api-docs")
            throw new InvalidOperationException("The selected artifact is not a hybrid API documentation build.");
        var platform = builder.ExecutionContext.IsRunMode
            ? OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux"
            : "linux";
        if (json.RootElement.GetProperty("platform").GetString() != platform)
            throw new InvalidOperationException($"The hybrid artifact must target {platform} for this execution mode.");

        if (engine == "jint")
        {
            website.WithJintHybridApiDocs(builder, Path.GetDirectoryName(manifest)!, manifest);
            return;
        }

        if (builder.ExecutionContext.IsPublishMode)
        {
            var image = builder.AddParameter("api-docs-image");
            website.WithEnvironment("HybridApiDocs__ArtifactPath", "/app/hybrid/hybrid-api-docs.json");
            for (var index = 0; index < 2; index++)
            {
                var endpoint = $"http://127.0.0.1:{4323 + index}";
                website.WithEnvironment($"HybridApiDocs__RendererUrls__{index}", endpoint);
            }
            website.PublishAsAzureAppServiceWebsite((infra, site) =>
            {
                ConfigureHealthAndWarmup(site);
                var main = infra.GetProvisionableResources().OfType<SiteContainer>()
                    .Single(container => ReferenceEquals(container.Parent, site) && container.IsMain.Value);
                for (var index = 0; index < 2; index++)
                {
                    // A sidecar environment variable's value names an app setting; it is not a literal.
                    var portSetting = $"API_DOCS_PORT_{index}";
                    site.SiteConfig.AppSettings.Add(new AppServiceNameValuePair
                    {
                        Name = portSetting, Value = $"{4323 + index}",
                    });
                    var sidecar = new SiteContainer($"apiDocs{index}")
                    {
                        Parent = site,
                        Name = index == 0 ? "api-docs" : "api-docs-standby",
                        Image = image.Resource.AsProvisioningParameter(infra),
                        IsMain = false,
                        TargetPort = $"{4323 + index}",
                        AuthType = main.AuthType,
                        UserManagedIdentityClientId = main.UserManagedIdentityClientId,
                        InheritAppSettingsAndConnectionStrings = false,
                    };
                    sidecar.EnvironmentVariables.Add(new WebAppEnvironmentVariable { Name = "PORT", Value = portSetting });
                    infra.Add(sidecar);
                }
            });
            return;
        }

        for (var index = 0; index < 2; index++)
        {
            var worker = builder.AddNodeApp(index == 0 ? "api-docs" : "api-docs-standby", frontendDirectory, "scripts/serve-api-docs.mjs")
                .WithPnpm(install: false)
                .WithHttpEndpoint(env: "PORT")
                .WithEnvironment("HOST", "127.0.0.1")
                .WithEnvironment("NODE_OPTIONS", "--max-old-space-size=1024")
                .WithEnvironment("HYBRID_API_DOCS_MANIFEST", manifest)
                .WithHttpHealthCheck("/__hybrid-api-docs/health");
            website.WithEnvironment($"HybridApiDocs__RendererUrls__{index}", worker.GetEndpoint("http"));
        }
        website.WithEnvironment("HybridApiDocs__ArtifactPath", manifest)
            .WithHttpHealthCheck("/healthz/api-docs");
    }

    /// <summary>
    /// Renders the API pages inside StaticHost with astro-jint, so the website needs no sidecar containers or
    /// worker processes. StaticHost reads the Astro server bundle from the artifact folder next to the manifest.
    /// </summary>
    private static void WithJintHybridApiDocs(this IResourceBuilder<ProjectResource> website,
        IDistributedApplicationBuilder builder, string artifactDirectory, string manifest)
    {
        foreach (var required in new[] { "astro-jint.json", "server/entry.mjs" })
        {
            if (!File.Exists(Path.Combine(artifactDirectory, required)))
                throw new InvalidOperationException($"The Jint hybrid artifact is missing {required}: {artifactDirectory}");
        }

        // Astro's data layer allocates well over the library's default per-request limit; the App Service
        // instance memory is the real bound, so this only needs to sit above the largest single render.
        website.WithEnvironment("Astro__MemoryLimitBytes", "6442450944");
        if (builder.ExecutionContext.IsPublishMode)
        {
            website.WithEnvironment("HybridApiDocs__ArtifactPath", "/app/hybrid/hybrid-api-docs.json")
                .WithEnvironment("Astro__DistPath", "/app/hybrid");
            website.PublishAsAzureAppServiceWebsite((infra, site) => ConfigureHealthAndWarmup(site));
            return;
        }

        website.WithEnvironment("HybridApiDocs__ArtifactPath", manifest)
            .WithEnvironment("Astro__DistPath", artifactDirectory)
            .WithHttpHealthCheck("/healthz/api-docs");
    }

    private static void ConfigureHealthAndWarmup(WebSite site)
    {
        site.SiteConfig.IsAlwaysOn = true;
        // Renderer readiness only gates warmup; a renderer outage must not make the instance unhealthy.
        site.SiteConfig.HealthCheckPath = "/healthz";
        site.SiteConfig.AppSettings.Add(new AppServiceNameValuePair
        {
            Name = "WEBSITE_HEALTHCHECK_MAXPINGFAILURES", Value = "2",
        });
        site.SiteConfig.AppSettings.Add(new AppServiceNameValuePair
        {
            Name = "WEBSITE_WARMUP_PATH", Value = "/healthz/api-docs",
        });
        site.SiteConfig.AppSettings.Add(new AppServiceNameValuePair
        {
            Name = "WEBSITE_WARMUP_STATUSES", Value = "200",
        });
    }
}
