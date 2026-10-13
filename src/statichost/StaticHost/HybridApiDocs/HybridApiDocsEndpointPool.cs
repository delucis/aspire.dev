namespace StaticHost.HybridApiDocs;

internal sealed class HybridApiDocsEndpointPool(Uri[] endpoints)
{
    private int _preferred;

    public IEnumerable<(int Index, Uri Address)> Candidates()
    {
        var first = Volatile.Read(ref _preferred);
        for (var offset = 0; offset < endpoints.Length; offset++)
        {
            var index = (first + offset) % endpoints.Length;
            yield return (index, endpoints[index]);
        }
    }

    public void Prefer(int index) => Interlocked.Exchange(ref _preferred, index);
}
