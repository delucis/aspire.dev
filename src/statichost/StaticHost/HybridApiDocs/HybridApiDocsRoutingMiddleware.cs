using Microsoft.AspNetCore.Http.Extensions;

namespace StaticHost.HybridApiDocs;

internal sealed record HybridApiDocsRequest(string RendererPath, string Representation, string? MarkdownPeer)
{
    public bool Cacheable { get; set; } = true;
}

internal sealed class HybridApiDocsRoutingMiddleware(RequestDelegate next, HybridApiDocsArtifact artifact)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "/";
        if (artifact.TryCanonical(path, out var canonical) && canonical != path)
        {
            context.Response.Redirect(UriHelper.BuildRelative(
                context.Request.PathBase, new PathString(canonical), context.Request.QueryString),
                permanent: true, preserveMethod: true);
            return;
        }
        if (artifact.TryRedirect(path, out var redirect))
        {
            context.Response.StatusCode = redirect!.Status;
            context.Response.Headers.Location = redirect.Destination + context.Request.QueryString;
            return;
        }
        if (!context.Request.Path.StartsWithSegments("/reference/api"))
        {
            await next(context);
            return;
        }
        if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
        {
            context.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
            context.Response.Headers.Allow = "GET, HEAD";
            return;
        }
        if (!artifact.TryRoute(path, out var route))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            context.Response.Headers.CacheControl = "no-store";
            return;
        }
        var isMarkdown = path.EndsWith(".md", StringComparison.Ordinal);
        var negotiation = AcceptHeaderParser.Negotiate(context.Request.Headers.Accept);
        var negotiated = !isMarkdown && negotiation.PrefersMarkdown;
        if (!isMarkdown && !negotiated && !negotiation.AcceptsHtml)
        {
            context.Response.StatusCode = StatusCodes.Status406NotAcceptable;
            return;
        }
        context.Features.Set(new HybridApiDocsRequest(
            negotiated ? route!.Markdown : path,
            negotiated ? "markdown-negotiated" : isMarkdown ? "markdown" : "html",
            isMarkdown || negotiated ? null : route!.Markdown));
        await next(context);
    }
}
