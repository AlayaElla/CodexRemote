using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace VirtualMicroBroker;

internal static class Protocol
{
    internal const int RawReportLength = 64, MaxBatchReports = 64, MaxLineBytes = 64 * 1024;
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    internal static byte[] NeutralRelease()
    {
        return ControlRelease("ACT10");
    }
    internal static byte[] ControlRelease(string key)
    {
        var payload = Encoding.UTF8.GetBytes($"{{\"m\":\"v.oai.hid\",\"p\":{{\"k\":\"{key}\",\"act\":0}}}}\n");
        var raw = new byte[64];
        raw[0] = 6; raw[1] = 2; raw[2] = (byte)payload.Length;
        payload.CopyTo(raw, 3);
        return raw;
    }
    internal static bool TryNeutralRelease(JsonElement root, out string? error)
    {
        if (!TryReports(root, "releaseReports", out var reports, out error)) return false;
        if (reports.Length == 1 && reports[0].SequenceEqual(NeutralRelease())) return true;
        error = "releaseReports must contain the fixed neutral ACT10-up report only.";
        return false;
    }
    internal static bool TryValidateSubmitReports(IReadOnlyList<byte[]> reports, out string? key, out int action, out string? error)
    {
        key = null; action = 0; error = null;
        try
        {
            var payload = new UTF8Encoding(false, true).GetString(reports.SelectMany(report => report.AsSpan(3, report[2]).ToArray()).ToArray()).Trim();
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) { error = "Submit reports must encode one JSON object."; return false; }
            if (!root.TryGetProperty("m", out var method)) return true; // Host RPC response.
            if (method.ValueKind != JsonValueKind.String || method.GetString() != "v.oai.hid" ||
                !root.TryGetProperty("p", out var parameters) || parameters.ValueKind != JsonValueKind.Object ||
                !parameters.TryGetProperty("k", out var keyValue) || keyValue.ValueKind != JsonValueKind.String ||
                !parameters.TryGetProperty("act", out var actionValue) || !actionValue.TryGetInt32(out action))
            { error = "Invalid Micro HID control payload."; return false; }
            key = keyValue.GetString();
            var button = key is "ACT06" or "ACT07" or "ACT08" or "ACT09" or "ACT10" or "ACT12" or "AG00" or "AG01" or "AG02" or "AG03" or "AG04" or "AG05";
            var encoder = key is "ENC_CW" or "ENC_CC";
            if (!button && !encoder || (button && action is not (0 or 1)) || (encoder && action != 2))
            { error = "Unsupported Micro HID control."; return false; }
            return true;
        }
        catch (Exception ex) when (ex is DecoderFallbackException or JsonException)
        { error = "Submit reports must contain valid UTF-8 JSON."; return false; }
    }
    internal static bool TryReports(JsonElement root, string property, out byte[][] reports, out string? error)
    {
        reports = []; error = null;
        if (!root.TryGetProperty(property, out var element) || element.ValueKind != JsonValueKind.Array) { error = $"{property} must be an array."; return false; }
        if (element.GetArrayLength() is < 1 or > MaxBatchReports) { error = $"{property} must contain 1..64 reports."; return false; }
        try { reports = element.EnumerateArray().Select(x => { if (x.ValueKind != JsonValueKind.String || (x.GetString()?.Length ?? 0) != 88) throw new FormatException(); return Convert.FromBase64String(x.GetString()!); }).ToArray(); }
        catch (FormatException) { error = $"{property} contains invalid or oversized base64."; return false; }
        if (reports.Any(x => !IsRawReport(x))) { error = "Each report must be raw64: [6, channel 1|2, length <= 61, data]."; return false; }
        return true;
    }
    internal static bool IsRawReport(byte[] report) => report.Length == RawReportLength && report[0] == 6 && (report[1] is 1 or 2) && report[2] <= 61;
}

internal sealed class BoundedUtf8LineReader(Stream input)
{
    public async Task<string?> ReadAsync(CancellationToken cancellationToken)
    {
        var bytes = new List<byte>(256); var one = new byte[1];
        while (true) { var read = await input.ReadAsync(one, cancellationToken).ConfigureAwait(false); if (read == 0) return bytes.Count == 0 ? null : throw new InvalidDataException("stdin ended in a partial JSON line."); if (one[0] == (byte)'\n') break; bytes.Add(one[0]); if (bytes.Count > Protocol.MaxLineBytes) throw new InvalidDataException("JSON line exceeds 65536 UTF-8 bytes."); }
        if (bytes.Count > 0 && bytes[^1] == (byte)'\r') bytes.RemoveAt(bytes.Count - 1);
        try { return new UTF8Encoding(false, true).GetString(CollectionsMarshal.AsSpan(bytes)); } catch (DecoderFallbackException e) { throw new InvalidDataException("stdin line is not valid UTF-8.", e); }
    }
}
