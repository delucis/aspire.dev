namespace StaticHost.HybridApiDocs;

/// <summary>
/// Produces the response for one on-demand API reference path. <see cref="HybridApiDocsRenderer"/> owns validators,
/// request collapsing and response headers, so engines differ only in where Astro runs.
/// </summary>
internal interface IHybridApiDocsEngine
{
    /// <summary>
    /// Renders <paramref name="upstream"/>, a path with an optional query string. The render is shared by every caller
    /// waiting for the same path, so the engine applies its own deadline.
    /// </summary>
    Task<HybridApiDocsResponse> RenderAsync(string upstream);

    /// <summary>Reports whether the engine can render pages for the build that StaticHost serves.</summary>
    Task<bool> IsReadyAsync(CancellationToken cancellationToken);
}
