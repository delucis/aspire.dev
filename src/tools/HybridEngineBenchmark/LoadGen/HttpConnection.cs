using System.Buffers.Text;
using System.Net;
using System.Net.Sockets;

namespace LoadGen;

/// <summary>Cache is the value of the X-Astro-Cache header: 0 when absent, 1 for HIT, 2 for MISS, 3 for any other value.</summary>
internal readonly record struct Exchange(int Status, long Bytes, bool Failed, byte Cache = 0);

/// <summary>
/// A keep-alive HTTP/1.1 connection that sends a prepared request and reads the response up to its last byte, either sized by
/// Content-Length or chunked (Astro's Node adapter streams, ASP.NET Core buffers). It is not a client: it drops the body as it
/// arrives so that the cost of the generator stays far below the server's.
/// </summary>
internal sealed class HttpConnection(EndPoint endPoint) : IDisposable
{
    private readonly byte[] _buffer = new byte[128 * 1024];
    private int _start;
    private int _end;
    private Socket? _socket;

    public async ValueTask<Exchange> SendAsync(ReadOnlyMemory<byte> request)
    {
        try
        {
            var socket = _socket ?? await ConnectAsync().ConfigureAwait(false);
            _start = _end = 0;
            await socket.SendAsync(request, SocketFlags.None).ConfigureAwait(false);
            var (status, bytes, keepAlive, cache) = await ReadResponseAsync(socket).ConfigureAwait(false);
            if (!keepAlive)
            {
                Close();
            }

            return new Exchange(status, bytes, false, cache);
        }
        catch (Exception ex) when (ex is SocketException or IOException or InvalidDataException or ObjectDisposedException)
        {
            Close();
            return new Exchange(0, 0, true);
        }
    }

    public void Dispose() => Close();

    private async ValueTask<Socket> ConnectAsync()
    {
        var socket = new Socket(endPoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(endPoint).ConfigureAwait(false);
        }
        catch
        {
            socket.Dispose();
            throw;
        }

        _socket = socket;
        return socket;
    }

    private void Close()
    {
        _socket?.Dispose();
        _socket = null;
    }

    private async ValueTask<(int Status, long Bytes, bool KeepAlive, byte Cache)> ReadResponseAsync(Socket socket)
    {
        int headerEnd;
        while ((headerEnd = _buffer.AsSpan(_start, _end - _start).IndexOf("\r\n\r\n"u8)) < 0)
        {
            await FillAsync(socket).ConfigureAwait(false);
        }

        headerEnd += 4;
        var (status, contentLength, chunked, keepAlive, cache) = ParseHeaders(_buffer.AsSpan(_start, headerEnd));
        long total = headerEnd;
        _start += headerEnd;

        if (status is 204 or 304 or (>= 100 and < 200))
        {
            return (status, total, keepAlive, cache);
        }

        if (chunked)
        {
            total += await SkipChunkedAsync(socket).ConfigureAwait(false);
        }
        else if (contentLength >= 0)
        {
            await SkipAsync(socket, contentLength).ConfigureAwait(false);
            total += contentLength;
        }
        else
        {
            keepAlive = false;
            try
            {
                while (true)
                {
                    total += _end - _start;
                    _start = _end;
                    await FillAsync(socket).ConfigureAwait(false);
                }
            }
            catch (IOException)
            {
            }
        }

        return (status, total, keepAlive, cache);
    }

    private static (int Status, long ContentLength, bool Chunked, bool KeepAlive, byte Cache) ParseHeaders(ReadOnlySpan<byte> headers)
    {
        if (headers.Length < 12 || !Utf8Parser.TryParse(headers.Slice(9, 3), out int status, out _))
        {
            throw new InvalidDataException("The response does not start with a status line.");
        }

        long contentLength = -1;
        byte cache = 0;
        var chunked = false;
        var keepAlive = !headers.StartsWith("HTTP/1.0"u8);
        var rest = headers;
        var firstLine = true;
        while (true)
        {
            var end = rest.IndexOf("\r\n"u8);
            if (end <= 0)
            {
                break;
            }

            var line = rest[..end];
            rest = rest[(end + 2)..];
            if (firstLine)
            {
                firstLine = false;
                continue;
            }

            var colon = line.IndexOf((byte)':');
            if (colon <= 0)
            {
                continue;
            }

            var name = line[..colon];
            var value = line[(colon + 1)..].Trim((byte)' ');
            if (name.Length == 14 && System.Text.Ascii.EqualsIgnoreCase(name, "Content-Length"u8))
            {
                Utf8Parser.TryParse(value, out contentLength, out _);
            }
            else if (name.Length == 17 && System.Text.Ascii.EqualsIgnoreCase(name, "Transfer-Encoding"u8))
            {
                chunked = value.IndexOf("chunked"u8) >= 0;
            }
            else if (name.Length == 10 && System.Text.Ascii.EqualsIgnoreCase(name, "Connection"u8))
            {
                keepAlive = !System.Text.Ascii.EqualsIgnoreCase(value, "close"u8);
            }
            else if (name.Length == 13 && System.Text.Ascii.EqualsIgnoreCase(name, "X-Astro-Cache"u8))
            {
                cache = System.Text.Ascii.EqualsIgnoreCase(value, "HIT"u8) ? (byte)1 : System.Text.Ascii.EqualsIgnoreCase(value, "MISS"u8) ? (byte)2 : (byte)3;
            }
        }

        return (status, contentLength, chunked, keepAlive, cache);
    }

    private async ValueTask<long> SkipChunkedAsync(Socket socket)
    {
        long total = 0;
        while (true)
        {
            int lineLength;
            while ((lineLength = _buffer.AsSpan(_start, _end - _start).IndexOf("\r\n"u8)) < 0)
            {
                await FillAsync(socket).ConfigureAwait(false);
            }

            var size = ParseChunkSize(_buffer.AsSpan(_start, lineLength));
            _start += lineLength + 2;
            total += lineLength + 2;
            if (size == 0)
            {
                while (true)
                {
                    int trailer;
                    while ((trailer = _buffer.AsSpan(_start, _end - _start).IndexOf("\r\n"u8)) < 0)
                    {
                        await FillAsync(socket).ConfigureAwait(false);
                    }

                    _start += trailer + 2;
                    total += trailer + 2;
                    if (trailer == 0)
                    {
                        return total;
                    }
                }
            }

            await SkipAsync(socket, size + 2).ConfigureAwait(false);
            total += size + 2;
        }
    }

    private static long ParseChunkSize(ReadOnlySpan<byte> line)
    {
        var semicolon = line.IndexOf((byte)';');
        if (semicolon >= 0)
        {
            line = line[..semicolon];
        }

        return Utf8Parser.TryParse(line, out long size, out _, 'X') ? size : throw new InvalidDataException("Bad chunk size.");
    }

    private async ValueTask SkipAsync(Socket socket, long count)
    {
        while (count > 0)
        {
            if (_start == _end)
            {
                await FillAsync(socket).ConfigureAwait(false);
            }

            var take = (int)Math.Min(count, _end - _start);
            _start += take;
            count -= take;
        }
    }

    private async ValueTask FillAsync(Socket socket)
    {
        if (_start == _end)
        {
            _start = _end = 0;
        }
        else if (_end == _buffer.Length)
        {
            if (_start == 0)
            {
                throw new InvalidDataException("The headers of the response do not fit the buffer.");
            }

            Buffer.BlockCopy(_buffer, _start, _buffer, 0, _end - _start);
            _end -= _start;
            _start = 0;
        }

        var read = await socket.ReceiveAsync(_buffer.AsMemory(_end), SocketFlags.None).ConfigureAwait(false);
        _end += read == 0 ? throw new IOException("The server closed the connection.") : read;
    }
}
