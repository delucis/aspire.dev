var builder = DistributedApplication.CreateBuilder(args);
var hybridApiDocs = HybridApiDocsExtensions.IsHybridApiDocsEnabled(
    builder.Configuration["ASPIRE_HYBRID_API_DOCS"]);
if (hybridApiDocs && !builder.ExecutionContext.IsRunMode)
    throw new InvalidOperationException("Hybrid API documentation is a local POC; Azure publishing requires the normal static build.");

// For deployment: We want to pick AppService as the environment to publish to.
builder.AddAzureAppServiceEnvironment("production")
    .WithDashboard(false);

var cache = builder.AddAzureManagedRedis("cache")
    .RunAsContainer();

var staticHostWebsite = builder.AddProject<Projects.StaticHost>("aspiredev")
    .WithReference(cache)
    .WithExternalHttpEndpoints()
    .PublishAsAzureAppServiceWebsite((infra, website) =>
    {
        website.IsEndToEndEncryptionEnabled = true;

        // App Service negotiates HTTP/1.1 unless HTTP/2 is enabled, which limits browsers to six
        // connections per origin. The landing page loads dozens of small assets, so multiplexing
        // them over one connection matters most on slow, high-latency links.
        website.SiteConfig.IsHttp20Enabled = true;
    });

var frontDoor = builder.AddAzureFrontDoor(staticHostWebsite);

if (builder.ExecutionContext.IsRunMode)
{
    staticHostWebsite.WithLocalLiveStatusDevCommands();

    // For local development: Use ViteApp for hot reload and development experience.
    // The live-status client calls same-origin /api/live[/stream]; inject StaticHost's
    // origin so the Vite dev server can proxy those to the API (see astro.config.mjs).
    // Without this, /api/live 404s against the Vite origin under `aspire run`.
    if (hybridApiDocs)
    {
        staticHostWebsite.WithHybridApiDocs(builder, Path.GetFullPath("../../frontend", builder.AppHostDirectory));
    }
    else
    {
        builder.AddViteApp("frontend", "../../frontend")
           .WithPnpm()
           .WithEnvironment("ASPIRE_STATICHOST_URL", staticHostWebsite.GetEndpoint("https"))
           .WithUrlForEndpoint("http", static url => url.DisplayText = "aspire.dev (Local)")
           .WithExternalHttpEndpoints();
    }
}
else
{
    var secrets = builder.AddAzureKeyVault("secrets");
    staticHostWebsite.WithProductionLiveStatus(builder, secrets);

    var logsWorkspace = builder.AddAzureLogAnalyticsWorkspace("workspace-logs");
    frontDoor.WithDiagnostics(logsWorkspace);
    cache.WithDiagnostics(logsWorkspace);
}

builder.Build().Run();
