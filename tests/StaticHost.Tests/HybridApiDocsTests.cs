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
    public async Task CachesSuccessfulResponsesAndCoalescesConcurrentMisses()
    {
        await using var host = await HybridHost.StartAsync();
        var responses = await Task.WhenAll(Enumerable.Range(0, 20)
            .Select(_ => host.Client.GetStringAsync("/reference/api/demo/")));
        Assert.All(responses, body => Assert.Equal("html:demo", body));
        Assert.Equal(1, host.Renderer.Calls["/reference/api/demo/"]);
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
        Assert.Equal(1, host.Renderer.Calls["/reference/api/demo/"]);
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
    public async Task DoesNotCacheAuthenticatedRequests()
    {
        await using var host = await HybridHost.StartAsync();
        host.Client.DefaultRequestHeaders.Authorization = new("Bearer", "test");
        await host.Client.GetStringAsync("/reference/api/demo/");
        await host.Client.GetStringAsync("/reference/api/demo/");
        Assert.Equal(2, host.Renderer.Calls["/reference/api/demo/"]);
    }

    [Fact]
    public async Task BuffersLargeResponsesAndKeepsStaticAndWarmOutputAvailableWithoutWorker()
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
        Assert.Equal("html:demo", await host.Client.GetStringAsync("/reference/api/demo/"));
        using var cold = await host.Client.GetAsync("/reference/api/cold/");
        Assert.Equal(HttpStatusCode.BadGateway, cold.StatusCode);
    }

    [Fact]
    public async Task CanonicalizesAndRedirectsWithoutInvokingWorker()
    {
        await using var host = await HybridHost.StartAsync();
        using var canonical = await host.Client.GetAsync("/REFERENCE/API/DEMO");
        Assert.Equal(HttpStatusCode.PermanentRedirect, canonical.StatusCode);
        Assert.Equal("/reference/api/demo/", canonical.Headers.Location!.OriginalString);
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
    public void RejectsMissingOrEscapingArtifacts()
    {
        using var root = new TempWebRoot();
        Assert.Throws<InvalidOperationException>(() => HybridApiDocsArtifact.Load(Path.Combine(root.Path, "missing.json")));
        root.WriteFile("hybrid.json", JsonSerializer.Serialize(new HybridApiManifest(
            1, "hybrid-api-docs", new string('a', 64), "../escape", "server/entry.mjs",
            "https://aspire.dev", [], []), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
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

    public static async Task<HybridHost> StartAsync()
    {
        var root = new TempWebRoot();
        root.WriteFile("client/guide/index.html", "static guide");
        root.WriteFile("server/entry.mjs", "private server");
        var pages = new[] { "demo", "private", "cookie", "failure", "broken", "mismatch", "oversize", "large", "cold" };
        root.WriteFile("hybrid.json", JsonSerializer.Serialize(new HybridApiManifest(
            1, "hybrid-api-docs", new string('a', 64), "client", "server/entry.mjs", "https://aspire.dev",
            pages.Select(page => new HybridApiRoute($"/reference/api/{page}/", $"/reference/api/{page}.md")).ToArray(),
            [new("/old-guide/", "/guide/", 302)]), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        var artifact = HybridApiDocsArtifact.Load(Path.Combine(root.Path, "hybrid.json"));
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { WebRootPath = artifact.ClientDirectory });
        builder.Logging.ClearProviders();
        builder.WebHost.UseTestServer();
        builder.Services.AddHybridApiDocs(artifact, "http://renderer/");
        var renderer = new TestApiRenderer();
        builder.Services.AddHttpClient<HybridApiDocsRenderer>().ConfigurePrimaryHttpMessageHandler(() => renderer);
        var app = builder.Build();
        app.UseHybridApiDocsRouting();
        app.UseAgentReadiness();
        app.UseDefaultFiles();
        app.UseStaticFiles();
        app.UseRouting();
        app.UseOutputCache();
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
    public bool Offline { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri!.AbsolutePath;
        Calls.AddOrUpdate(path, 1, (_, count) => count + 1);
        if (Offline) throw new HttpRequestException("Renderer unavailable.");
        await Task.Delay(30, cancellationToken);
        var page = path.Split('/').Last(segment => segment.Length > 0).Replace(".md", "");
        var response = new HttpResponseMessage(page == "failure" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK);
        response.Headers.Add("X-Aspire-Build-Id", new string(page == "mismatch" ? 'b' : 'a', 64));
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
