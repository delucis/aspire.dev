using Microsoft.AspNetCore.WebUtilities;

namespace StaticHost.HybridApiDocs;

/// <summary>
/// Reads the bundled images that on-demand pages reference through <c>/_image</c>. Under Jint, Astro's image endpoint
/// answers with the text "[object Object]" and no image library is available to resize with, so an in-process engine
/// returns the file as it is. For SVG that is what the Node renderer sends as well.
/// </summary>
internal static class HybridApiDocsLocalImages
{
    public static async Task<HybridApiDocsResponse> ReadAsync(HybridApiDocsArtifact artifact, string upstream)
    {
        var separator = upstream.IndexOf('?');
        var query = QueryHelpers.ParseQuery(separator < 0 ? string.Empty : upstream[separator..]);
        var href = query.TryGetValue("href", out var values) && values.Count == 1 ? values.ToString() : null;
        if (href is null || !artifact.IsLocalImage(href))
            return HybridApiDocsResponse.Failure(StatusCodes.Status404NotFound);

        var contentType = Path.GetExtension(href).ToLowerInvariant() switch
        {
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".avif" => "image/avif",
            ".gif" => "image/gif",
            _ => "application/octet-stream",
        };
        var body = await File.ReadAllBytesAsync(Path.Combine(artifact.ClientDirectory, href.TrimStart('/')));
        return new HybridApiDocsResponse(StatusCodes.Status200OK, [KeyValuePair.Create("Content-Type", new[] { contentType })],
            body, false, false);
    }
}
