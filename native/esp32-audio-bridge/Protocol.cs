using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Esp32AudioBridge;

internal static class Protocol
{
    internal const int MaxLineBytes = 16 * 1024;
    internal const int MaxIdLength = 128;
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    internal static bool TryIdAndOperation(JsonElement root, out string? id, out string? operation)
    {
        id = null;
        operation = null;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("id", out var idElement) || idElement.ValueKind != JsonValueKind.String ||
            !root.TryGetProperty("op", out var operationElement) || operationElement.ValueKind != JsonValueKind.String)
            return false;
        id = idElement.GetString();
        operation = operationElement.GetString();
        return !string.IsNullOrWhiteSpace(id) && id.Length <= MaxIdLength && !string.IsNullOrWhiteSpace(operation) && operation.Length <= 32;
    }

    internal static bool TryGetOptionalString(JsonElement root, string property, out string? value, out string? error)
    {
        value = null;
        error = null;
        if (!root.TryGetProperty(property, out var element) || element.ValueKind == JsonValueKind.Null) return true;
        if (element.ValueKind != JsonValueKind.String) { error = $"{property} must be a string."; return false; }
        value = element.GetString();
        if (value is not null && value.Length > 8192) { error = $"{property} is too long."; return false; }
        return true;
    }
}

internal sealed class BoundedUtf8LineReader(Stream input)
{
    public async Task<string?> ReadAsync(CancellationToken cancellationToken)
    {
        var bytes = new List<byte>(256);
        var one = new byte[1];
        while (true)
        {
            var read = await input.ReadAsync(one, cancellationToken).ConfigureAwait(false);
            if (read == 0)
                return bytes.Count == 0 ? null : throw new InvalidDataException("stdin ended in a partial JSONL command.");
            if (one[0] == (byte)'\n') break;
            if (bytes.Count >= Protocol.MaxLineBytes)
                throw new InvalidDataException("JSONL command exceeds 16384 UTF-8 bytes.");
            bytes.Add(one[0]);
        }
        if (bytes.Count > 0 && bytes[^1] == (byte)'\r') bytes.RemoveAt(bytes.Count - 1);
        try { return new UTF8Encoding(false, true).GetString(CollectionsMarshal.AsSpan(bytes)); }
        catch (DecoderFallbackException exception) { throw new InvalidDataException("JSONL command is not valid UTF-8.", exception); }
    }
}
