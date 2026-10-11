using Aspire.Hosting;

namespace Aspire.Dev.AppHost.Tests;

public sealed class HybridApiDocsConfigurationTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("0", false)]
    [InlineData("1", true)]
    public void BuildModeRequiresExplicitOptIn(string? value, bool expected)
        => Assert.Equal(expected, HybridApiDocsExtensions.IsHybridApiDocsEnabled(value));

    [Fact]
    public void InvalidBuildModeFailsClearly()
        => Assert.Throws<InvalidOperationException>(() => HybridApiDocsExtensions.IsHybridApiDocsEnabled("true"));

    [Fact]
    public async Task LocalGraphUsesPrivateWorkerAndEndpointReferences()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"aspire-hybrid-graph-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path.Combine(directory, "dist-hybrid"));
        try
        {
            File.WriteAllText(Path.Combine(directory, "dist-hybrid", "hybrid-api-docs.json"),
                $$"""{"mode":"hybrid-api-docs","platform":"{{(OperatingSystem.IsWindows() ? "win32" : "linux")}}"}""");
            var builder = DistributedApplication.CreateBuilder(new DistributedApplicationOptions
            {
                DisableDashboard = true,
            });
            var website = builder.AddProject<Projects.StaticHost>("aspiredev");
            website.WithHybridApiDocs(builder, directory);
            await using var app = builder.Build();
            var worker = Assert.Single(builder.Resources.OfType<Aspire.Hosting.JavaScript.NodeAppResource>());
            Assert.Equal("api-docs", worker.Name);
            Assert.All(worker.Annotations.OfType<Aspire.Hosting.ApplicationModel.EndpointAnnotation>(),
                endpoint => Assert.False(endpoint.IsExternal));

            var environment = new Dictionary<string, object>();
            var context = new Aspire.Hosting.ApplicationModel.EnvironmentCallbackContext(
                builder.ExecutionContext, website.Resource, environment, CancellationToken.None);
            foreach (var annotation in website.Resource.Annotations
                .OfType<Aspire.Hosting.ApplicationModel.EnvironmentCallbackAnnotation>())
            {
                await annotation.Callback(context);
            }
            Assert.IsType<Aspire.Hosting.ApplicationModel.EndpointReference>(environment["HybridApiDocs__RendererUrl"]);
            Assert.Equal(Path.Combine(directory, "dist-hybrid", "hybrid-api-docs.json"),
                environment["HybridApiDocs__ArtifactPath"]);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
