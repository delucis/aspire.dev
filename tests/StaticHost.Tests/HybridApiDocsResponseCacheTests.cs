using StaticHost.HybridApiDocs;

namespace StaticHost.Tests;

public sealed class HybridApiDocsResponseCacheTests
{
    private static HybridApiDocsResponse Page(int bytes = 10) => new(200, [], new byte[bytes], false, true);

    [Fact]
    public void ReturnsWhatWasStored()
    {
        var cache = new HybridApiDocsResponseCache(4, 1024, TimeSpan.FromMinutes(30));
        var stored = Page();
        cache.Set("/a/", stored);
        Assert.True(cache.TryGet("/a/", out var found));
        Assert.Same(stored, found);
        Assert.False(cache.TryGet("/b/", out _));
    }

    [Fact]
    public void RemovesTheLeastRecentlyUsedEntryAtTheEntryLimit()
    {
        var cache = new HybridApiDocsResponseCache(2, 1024, TimeSpan.FromMinutes(30));
        cache.Set("a", Page());
        cache.Set("b", Page());
        Assert.True(cache.TryGet("a", out _));
        cache.Set("c", Page());
        Assert.True(cache.TryGet("a", out _));
        Assert.False(cache.TryGet("b", out _));
        Assert.True(cache.TryGet("c", out _));
    }

    [Fact]
    public void RemovesOldEntriesWhenBodiesExceedTheByteBudget()
    {
        var cache = new HybridApiDocsResponseCache(10, 100, TimeSpan.FromMinutes(30));
        cache.Set("a", Page(60));
        cache.Set("b", Page(60));
        Assert.False(cache.TryGet("a", out _));
        Assert.True(cache.TryGet("b", out _));
        Assert.Equal(1, cache.Count);
    }

    [Fact]
    public void IgnoresBodiesLargerThanTheBudget()
    {
        var cache = new HybridApiDocsResponseCache(10, 100, TimeSpan.FromMinutes(30));
        cache.Set("a", Page(101));
        Assert.Equal(0, cache.Count);
        Assert.False(cache.TryGet("a", out _));
    }

    [Fact]
    public void ReplacingAnEntryCountsItsBytesOnce()
    {
        var cache = new HybridApiDocsResponseCache(10, 100, TimeSpan.FromMinutes(30));
        cache.Set("a", Page(60));
        cache.Set("a", Page(60));
        cache.Set("b", Page(30));
        Assert.Equal(2, cache.Count);
        Assert.True(cache.TryGet("a", out _));
    }

    [Fact]
    public void ExpiresEntriesAfterTheirDuration()
    {
        var time = new ManualTime();
        var cache = new HybridApiDocsResponseCache(10, 100, TimeSpan.FromMinutes(30), time);
        cache.Set("a", Page());
        time.Advance(TimeSpan.FromMinutes(29));
        Assert.True(cache.TryGet("a", out _));
        time.Advance(TimeSpan.FromMinutes(2));
        Assert.False(cache.TryGet("a", out _));
        Assert.Equal(0, cache.Count);
    }

    private sealed class ManualTime : TimeProvider
    {
        private DateTimeOffset _now = new(2030, 1, 1, 0, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now += by;
    }
}
