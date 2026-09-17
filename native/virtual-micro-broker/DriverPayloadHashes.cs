using System.Security.Cryptography;

namespace VirtualMicroBroker;

// The build regenerates the companion source from the three bytes that will be
// bundled beside the installer. It is deliberately source embedded: a sibling
// JSON/manifest could be swapped after preflight and is not an authority.
internal static partial class DriverPayloadHashes
{
    internal static bool Verify(string package)
    {
        foreach (var name in DriverSetup.PackageFiles)
        {
            if (!ExpectedSha256.TryGetValue(name, out var expected) || expected.Length != 64) return false;
            using var stream = new FileStream(Path.Combine(package, name), FileMode.Open, FileAccess.Read, FileShare.Read);
            var actual = Convert.ToHexString(SHA256.HashData(stream));
            if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(expected), Convert.FromHexString(actual))) return false;
        }
        return ExpectedSha256.Count == DriverSetup.PackageFiles.Length;
    }

    internal static string SnapshotIdentity(string package)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var name in DriverSetup.PackageFiles.OrderBy(name => name, StringComparer.OrdinalIgnoreCase))
        {
            hash.AppendData(System.Text.Encoding.UTF8.GetBytes(name));
            using var stream = new FileStream(Path.Combine(package, name), FileMode.Open, FileAccess.Read, FileShare.Read);
            hash.AppendData(SHA256.HashData(stream));
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }
}
