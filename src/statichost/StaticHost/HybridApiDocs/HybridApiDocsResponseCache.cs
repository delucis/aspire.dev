namespace StaticHost.HybridApiDocs;

/// <summary>
/// A least-recently-used cache of successful renders for engines that run Astro in process. It is bounded by entry
/// count and by body bytes, and entries expire. The Node renderer gets the same behavior from Astro's memory cache.
/// </summary>
internal sealed class HybridApiDocsResponseCache(int maxEntries, long maxBytes, TimeSpan duration, TimeProvider? time = null)
{
    private readonly object _gate = new();
    private readonly Dictionary<string, LinkedListNode<Entry>> _entries = new(StringComparer.Ordinal);
    private readonly LinkedList<Entry> _recent = new();
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private long _bytes;

    public int Count
    {
        get { lock (_gate) return _entries.Count; }
    }

    public bool TryGet(string key, out HybridApiDocsResponse? response)
    {
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var node))
            {
                if (_time.GetUtcNow() < node.Value.Expires)
                {
                    _recent.Remove(node);
                    _recent.AddFirst(node);
                    response = node.Value.Response;
                    return true;
                }
                Remove(node);
            }
        }
        response = null;
        return false;
    }

    public void Set(string key, HybridApiDocsResponse response)
    {
        var size = response.Body.Length;
        if (maxEntries <= 0 || size > maxBytes) return;
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var existing)) Remove(existing);
            _entries[key] = _recent.AddFirst(new Entry(key, response, size, _time.GetUtcNow() + duration));
            _bytes += size;
            while (_entries.Count > maxEntries || _bytes > maxBytes) Remove(_recent.Last!);
        }
    }

    private void Remove(LinkedListNode<Entry> node)
    {
        _recent.Remove(node);
        _entries.Remove(node.Value.Key);
        _bytes -= node.Value.Size;
    }

    private readonly record struct Entry(string Key, HybridApiDocsResponse Response, int Size, DateTimeOffset Expires);
}
