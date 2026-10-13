using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using StaticHost.AgentReadiness;
using StaticHost.HybridApiDocs;

namespace StaticHost.Tests;

public sealed class HybridApiDocsTests
{
    [Fact]
    public async Task AlwaysForwardsRequestsEvenWhenAstroReportsCacheHits()
    {
        await using var host = await HybridHost.StartAsync();
        var responses = await Task.WhenAll(Enumerable.Range(0, 20)
            .Select(_ => host.Client.GetStringAsync("/reference/api/demo/")));
        Assert.All(responses, body => Assert.Equal("html:demo", body));
        Assert.Equal(20, host.Renderer.Calls["/reference/api/demo/"]);
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
        Assert.Equal(21, host.Renderer.Calls["/reference/api/demo/"]);
        using var response = await host.Client.GetAsync("/reference/api/demo/");
        Assert.Equal("HIT", Assert.Single(response.Headers.GetValues("X-Astro-Cache")));
        Assert.True(response.Headers.CacheControl!.NoStore);
        Assert.False(response.Headers.Contains("Vary"));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task KeepsMarkdownAndHtmlHeadersIsolatedInEitherOrder(bool negotiatedFirst)
    {
        await using var host = await HybridHost.StartAsync();
        async Task CheckNegotiated()
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/reference/api/demo/");
            request.Headers.Accept.ParseAdd("text/markdown");
            using var response = await host.Client.SendAsync(request);
            Assert.Equal("markdown:demo", await response.Content.ReadAsStringAsync());
            Assert.True(response.Headers.CacheControl!.Private);
            Assert.Contains("Accept", response.Headers.Vary);
        }
        if (negotiatedFirst) await CheckNegotiated();
        using var markdown = await host.Client.GetAsync("/reference/api/demo.md");
        Assert.Equal("markdown:demo", await markdown.Content.ReadAsStringAsync());
        Assert.False(markdown.Headers.CacheControl!.Private);
        using var html = await host.Client.GetAsync("/reference/api/demo/");
        Assert.Equal("html:demo", await html.Content.ReadAsStringAsync());
        Assert.Contains("text/html", html.Content.Headers.ContentType!.ToString());
        Assert.Contains("/reference/api/demo.md", string.Join("", html.Headers.GetValues("Link")));
        if (!negotiatedFirst) await CheckNegotiated();
        await CheckNegotiated();
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
    }

    [Fact]
    public async Task HeadDoesNotPoisonGetAndUsesTheCompleteContentLength()
    {
        await using var host = await HybridHost.StartAsync();
        using var head = await host.Client.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/reference/api/demo/"));
        Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        Assert.Equal("html:demo".Length, head.Content.Headers.ContentLength);
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
    }

    [Theory]
    [InlineData("failure", HttpStatusCode.ServiceUnavailable)]
    [InlineData("broken", HttpStatusCode.BadGateway)]
    [InlineData("mismatch", HttpStatusCode.BadGateway)]
    [InlineData("oversize", HttpStatusCode.BadGateway)]
    public async Task DoesNotCacheRendererErrors(string page, HttpStatusCode expected)
    {
        await using var host = await HybridHost.StartAsync();
        for (var index = 0; index < 2; index++)
        {
            using var response = await host.Client.GetAsync($"/reference/api/{page}/");
            Assert.Equal(expected, response.StatusCode);
        }
        Assert.Equal(2, host.Renderer.Calls[$"/reference/api/{page}/"]);
    }

    [Theory]
    [InlineData("private")]
    [InlineData("cookie")]
    public async Task DoesNotCachePrivateOrCookieSettingResponses(string page)
    {
        await using var host = await HybridHost.StartAsync();
        await host.Client.GetStringAsync($"/reference/api/{page}/");
        await host.Client.GetStringAsync($"/reference/api/{page}/");
        Assert.Equal(2, host.Renderer.Calls[$"/reference/api/{page}/"]);
    }

    [Fact]
    public async Task MarksAuthenticatedRequestsForNativeCacheBypass()
    {
        await using var host = await HybridHost.StartAsync();
        host.Client.DefaultRequestHeaders.Authorization = new("Bearer", "test");
        await host.Client.GetStringAsync("/reference/api/demo/");
        await host.Client.GetStringAsync("/reference/api/demo/");
        Assert.Equal(2, host.Renderer.Calls["/reference/api/demo/"]);
        Assert.True(host.Renderer.SawCacheBypass);
    }

    [Fact]
    public async Task ClientPreferenceCookiesDoNotDisablePublicCachingOrReachTheWorker()
    {
        await using var host = await HybridHost.StartAsync();
        host.Client.DefaultRequestHeaders.Add("Cookie", "preference=value");
        await host.Client.GetStringAsync("/reference/api/demo/");
        Assert.False(host.Renderer.SawCacheBypass);
        Assert.False(host.Renderer.SawCookie);
    }

    [Fact]
    public async Task RendererTimeoutsAreExplicitAndNotCached()
    {
        await using var host = await HybridHost.StartAsync();
        host.Renderer.Timeout = true;
        for (var index = 0; index < 2; index++)
        {
            using var response = await host.Client.GetAsync("/reference/api/demo/");
            Assert.Equal(HttpStatusCode.GatewayTimeout, response.StatusCode);
        }
        Assert.Equal(2, host.Renderer.Calls["/reference/api/demo/"]);
    }

    [Fact]
    public async Task BuffersLargeResponsesButRequiresWorkerEvenForPreviouslyVisitedApis()
    {
        await using var host = await HybridHost.StartAsync();
        using var large = await host.Client.GetAsync("/reference/api/large/");
        var body = await large.Content.ReadAsByteArrayAsync();
        Assert.True(body.Length >= 13_621_124);
        Assert.Equal(body.Length, large.Content.Headers.ContentLength);
        Assert.Empty(large.Headers.TransferEncoding);
        await host.Client.GetStringAsync("/reference/api/demo/");
        host.Renderer.Offline = true;
        Assert.Equal("static guide", await host.Client.GetStringAsync("/guide/"));
        using var previouslyVisited = await host.Client.GetAsync("/reference/api/demo/");
        Assert.Equal(HttpStatusCode.BadGateway, previouslyVisited.StatusCode);
        using var cold = await host.Client.GetAsync("/reference/api/cold/");
        Assert.Equal(HttpStatusCode.BadGateway, cold.StatusCode);
    }

    [Fact]
    public async Task FailsOverAndKeepsUsingTheHealthyReplica()
    {
        await using var host = await HybridHost.StartAsync(["http://primary/", "http://standby/"]);
        host.Renderer.OfflineHosts.Add("primary");
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
        Assert.Equal(1, host.Renderer.EndpointCalls["primary"]);
        Assert.Equal(1, host.Renderer.EndpointCalls["standby"]);
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
        Assert.Equal(1, host.Renderer.EndpointCalls["primary"]);
        Assert.Equal(2, host.Renderer.EndpointCalls["standby"]);
    }

    [Fact]
    public async Task ReadinessRequiresAnAvailableMatchingBuild()
    {
        await using var host = await HybridHost.StartAsync(["http://primary/", "http://standby/"]);
        host.Renderer.OfflineHosts.Add("primary");
        using var ready = await host.Client.GetAsync("/healthz/api-docs");
        Assert.Equal(HttpStatusCode.OK, ready.StatusCode);
        host.Renderer.MismatchedHosts.Add("standby");
        using var mismatch = await host.Client.GetAsync("/healthz/api-docs");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, mismatch.StatusCode);
        host.Renderer.Offline = true;
        using var down = await host.Client.GetAsync("/healthz/api-docs");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, down.StatusCode);
        Assert.Equal("static guide", await host.Client.GetStringAsync("/guide/"));
    }

    [Fact]
    public async Task RejectsMismatchedPrimaryAndRecoversAfterReplicaAvailabilityChanges()
    {
        await using var host = await HybridHost.StartAsync(["http://primary/", "http://standby/"]);
        host.Renderer.MismatchedHosts.Add("primary");
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
        host.Renderer.MismatchedHosts.Clear();
        host.Renderer.OfflineHosts.Add("standby");
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
        Assert.Equal(2, host.Renderer.EndpointCalls["primary"]);
        Assert.Equal(2, host.Renderer.EndpointCalls["standby"]);
    }

    [Fact]
    public async Task RetriesServerErrorsAgainstAnotherReplicaBeforeSendingTheResponse()
    {
        await using var host = await HybridHost.StartAsync(["http://primary/", "http://standby/"]);
        host.Renderer.ErrorHosts.Add("primary");
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
        Assert.Equal(1, host.Renderer.EndpointCalls["primary"]);
        Assert.Equal(1, host.Renderer.EndpointCalls["standby"]);
    }

    [Fact]
    public async Task CanonicalizesAndRedirectsWithoutInvokingWorker()
    {
        await using var host = await HybridHost.StartAsync();
        using var canonical = await host.Client.GetAsync("/REFERENCE/API/DEMO");
        Assert.Equal(HttpStatusCode.PermanentRedirect, canonical.StatusCode);
        Assert.Equal("/reference/api/demo/", canonical.Headers.Location!.OriginalString);
        using var markdown = await host.Client.GetAsync("/reference/api/demo.md/");
        Assert.Equal(HttpStatusCode.PermanentRedirect, markdown.StatusCode);
        Assert.Equal("/reference/api/demo.md", markdown.Headers.Location!.OriginalString);
        using var redirect = await host.Client.GetAsync("/old-guide/?a=1");
        Assert.Equal(HttpStatusCode.Found, redirect.StatusCode);
        Assert.Equal("/guide/?a=1", redirect.Headers.Location!.OriginalString);
        using var missing = await host.Client.GetAsync("/reference/api/not-a-page/");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        using var method = await host.Client.PostAsync("/reference/api/demo/", null);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, method.StatusCode);
        Assert.Empty(host.Renderer.Calls);
    }

    [Fact]
    public async Task AllowsOnlyBundledImagesAndBoundsTransformDimensions()
    {
        await using var host = await HybridHost.StartAsync();
        using var allowed = await host.Client.GetAsync("/_image?href=%2F_astro%2Flogo.svg&w=48&h=48");
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        using var remote = await host.Client.GetAsync("/_image?href=https%3A%2F%2Fexample.com%2Fimage.svg");
        Assert.Equal(HttpStatusCode.BadRequest, remote.StatusCode);
        using var oversized = await host.Client.GetAsync("/_image?href=%2F_astro%2Flogo.svg&w=999999");
        Assert.Equal(HttpStatusCode.BadRequest, oversized.StatusCode);
        Assert.Equal(1, host.Renderer.Calls["/_image"]);
    }

    [Fact]
    public void RejectsMissingOrEscapingArtifacts()
    {
        using var root = new TempWebRoot();
        Assert.Throws<InvalidOperationException>(() => HybridApiDocsArtifact.Load(Path.Combine(root.Path, "missing.json")));
        root.WriteFile("hybrid.json", JsonSerializer.Serialize(new HybridApiManifest(
            1, "hybrid-api-docs", new string('a', 64), "../escape", "server/entry.mjs",
            "https://aspire.dev", [], [], OperatingSystem.IsWindows() ? "win32" : "linux"), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        Assert.Throws<InvalidOperationException>(() => HybridApiDocsArtifact.Load(Path.Combine(root.Path, "hybrid.json")));
    }
}

internal sealed class HybridHost : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly TempWebRoot _root;
    public HttpClient Client { get; }
    public TestApiRenderer Renderer { get; }

    private HybridHost(WebApplication app, TempWebRoot root, TestApiRenderer renderer)
    {
        _app = app;
        _root = root;
        Renderer = renderer;
        Client = app.GetTestClient();
    }

    public static async Task<HybridHost> StartAsync(string[]? endpoints = null)
    {
        var root = new TempWebRoot();
        root.WriteFile("client/guide/index.html", "static guide");
        root.WriteFile("client/_astro/logo.svg", "<svg/>");
        root.WriteFile("server/entry.mjs", "private server");
        var pages = new[] { "demo", "private", "cookie", "failure", "broken", "mismatch", "oversize", "large", "cold" };
        root.WriteFile("hybrid.json", JsonSerializer.Serialize(new HybridApiManifest(
            1, "hybrid-api-docs", new string('a', 64), "client", "server/entry.mjs", "https://aspire.dev",
            pages.Select(page => new HybridApiRoute($"/reference/api/{page}/", $"/reference/api/{page}.md")).ToArray(),
            [new("/old-guide/", "/guide/", 302)], OperatingSystem.IsWindows() ? "win32" : "linux"),
            new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        var artifact = HybridApiDocsArtifact.Load(Path.Combine(root.Path, "hybrid.json"));
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { WebRootPath = artifact.ClientDirectory });
        builder.Logging.ClearProviders();
        builder.WebHost.UseTestServer();
        builder.Services.AddHybridApiDocs(artifact, endpoints ?? ["http://renderer/"]);
        var renderer = new TestApiRenderer();
        builder.Services.AddHttpClient<HybridApiDocsRenderer>().ConfigurePrimaryHttpMessageHandler(() => renderer);
        var app = builder.Build();
        app.UseHybridApiDocsRouting();
        app.UseAgentReadiness();
        app.UseDefaultFiles();
        app.UseStaticFiles();
        app.UseRouting();
        app.MapHybridApiDocs();
        await app.StartAsync();
        return new HybridHost(app, root, renderer);
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _app.DisposeAsync();
        _root.Dispose();
    }
}

internal sealed class TestApiRenderer : HttpMessageHandler
{
    public ConcurrentDictionary<string, int> Calls { get; } = new();
    public ConcurrentDictionary<string, int> EndpointCalls { get; } = new();
    public HashSet<string> OfflineHosts { get; } = [];
    public HashSet<string> MismatchedHosts { get; } = [];
    public HashSet<string> ErrorHosts { get; } = [];
    public bool Offline { get; set; }
    public bool Timeout { get; set; }
    public bool SawCacheBypass { get; private set; }
    public bool SawCookie { get; private set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri!.AbsolutePath;
        var endpoint = request.RequestUri.Host;
        EndpointCalls.AddOrUpdate(endpoint, 1, (_, count) => count + 1);
        SawCacheBypass = request.Headers.TryGetValues("X-Aspire-Cache-Bypass", out var bypass)
            && bypass.SequenceEqual(["1"]);
        SawCookie = request.Headers.Contains("Cookie");
        Calls.AddOrUpdate(path, 1, (_, count) => count + 1);
        if (Offline || OfflineHosts.Contains(endpoint)) throw new HttpRequestException("Renderer unavailable.");
        if (Timeout) throw new OperationCanceledException("Renderer timed out.");
        await Task.Delay(30, cancellationToken);
        var page = path.Split('/').Last(segment => segment.Length > 0).Replace(".md", "");
        var response = new HttpResponseMessage(page == "failure" || ErrorHosts.Contains(endpoint)
            ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK);
        response.Headers.Add("X-Aspire-Build-Id", new string(page == "mismatch" || MismatchedHosts.Contains(endpoint) ? 'b' : 'a', 64));
        response.Headers.Add("X-Astro-Cache", "HIT");
        response.Headers.Vary.Add("X-Aspire-Cache-Bypass");
        response.Content = page switch
        {
            "broken" => new BrokenContent(),
            "oversize" => new ByteArrayContent(new byte[HybridApiDocsRenderer.MaximumBodySize + 1]),
            "large" => new ByteArrayContent(new byte[13_621_124]),
            _ => new StringContent((path.EndsWith(".md") ? "markdown:" : "html:") + page),
        };
        response.Content.Headers.ContentType = new(path.EndsWith(".md") ? "text/markdown" : "text/html");
        if (page == "cookie") response.Headers.Add("Set-Cookie", "test=value");
        response.Headers.CacheControl = page == "private"
            ? new() { Private = true, NoStore = true } : new() { Public = true };
        return response;
    }

    private sealed class BrokenContent : HttpContent
    {
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => throw new IOException("Interrupted renderer body.");
    }
}
