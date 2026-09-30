namespace BCookieSubs.Shared.Services.Media;

public static class PgsSupParser
{
    private const byte SegmentPcs = 0x16;
    private const byte EpochStart = 0x80;

    public static int CountEvents(string supPath)
    {
        using var stream = File.OpenRead(supPath);
        return CountEvents(stream);
    }

    public static int CountEvents(Stream stream)
    {
        var events = 0;
        Span<byte> header = stackalloc byte[13];
        while (ReadExactlyOrNull(stream, header))
        {
            if (header[0] != 0x50 || header[1] != 0x47) continue;
            var segmentType = header[10];
            var segmentLength = (header[11] << 8) | header[12];
            if (segmentType != SegmentPcs)
            {
                stream.Seek(segmentLength, SeekOrigin.Current);
                continue;
            }

            var payload = new byte[segmentLength];
            if (!ReadExactlyOrNull(stream, payload)) continue;

            if (payload.Length < 11) continue;
            var compositionState = payload[7];
            var objectCount = payload[10];
            if (compositionState == EpochStart && objectCount >= 1) events++;
        }
        return events;
    }

    private static bool ReadExactlyOrNull(Stream stream, Span<byte> buffer)
    {
        var read = 0;
        while (read < buffer.Length)
        {
            var n = stream.Read(buffer[read..]);
            if (n == 0) return false;
            read += n;
        }
        return true;
    }
}

public static class VobSubIdxParser
{
    public static int CountEvents(string idxPath)
    {
        var count = 0;
        foreach (var line in File.ReadLines(idxPath))
        {
            if (line.Contains("timestamp:", StringComparison.OrdinalIgnoreCase)) count++;
        }
        return count;
    }

    public static int CountEvents(Stream stream)
    {
        var count = 0;
        using var reader = new StreamReader(stream);
        while (reader.ReadLine() is { } line)
        {
            if (line.Contains("timestamp:", StringComparison.OrdinalIgnoreCase)) count++;
        }
        return count;
    }
}