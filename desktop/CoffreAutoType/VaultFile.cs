using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CoffreAutoType;

/// <summary>Un identifiant du coffre (lecture seule : ce logiciel ne modifie jamais le coffre).</summary>
public sealed record Entry(string Id, string Title, string Url, string Username, string Password)
{
    /// <summary>Nom d'hôte affichable (« mabanque.fr »), vide si l'adresse n'en contient pas.</summary>
    public string Host
    {
        get
        {
            var s = Url.Trim();
            if (s.Length == 0) return "";
            if (!s.Contains("://")) s = "https://" + s;
            return Uri.TryCreate(s, UriKind.Absolute, out var u) ? u.Host.StartsWith("www.") ? u.Host[4..] : u.Host : "";
        }
    }
}

public sealed class VaultException : Exception
{
    public string Code { get; }
    public VaultException(string code, string message) : base(message) => Code = code;
}

/// <summary>
/// Lit le coffre chiffré produit par l'extension / l'application web (même format) :
/// mot de passe maître → PBKDF2-SHA256 → clé qui déchiffre la clé du coffre (AES-256-GCM) → déchiffre les données.
/// </summary>
public static class VaultFile
{
    const string AadWrap = "coffre:wrap:1";
    const string AadData = "coffre:data:1";

    static byte[] Open(byte[] key, JsonElement sealedBox, string aad)
    {
        var iv = Convert.FromBase64String(sealedBox.GetProperty("iv").GetString()!);
        var ct = Convert.FromBase64String(sealedBox.GetProperty("ct").GetString()!);
        if (iv.Length != 12 || ct.Length < 16) throw new CryptographicException("format");
        var body = ct.AsSpan(0, ct.Length - 16); // WebCrypto : chiffré || étiquette de 16 octets
        var tag = ct.AsSpan(ct.Length - 16);
        var plain = new byte[body.Length];
        using var gcm = new AesGcm(key, 16);
        gcm.Decrypt(iv, body, tag, plain, Encoding.UTF8.GetBytes(aad));
        return plain;
    }

    /// <summary>Déchiffre le coffre. Lève VaultException WRONG_PASSWORD / BAD_FORMAT / CORRUPTED.</summary>
    public static List<Entry> Unlock(string storedJson, string masterPassword)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(storedJson);
        }
        catch (JsonException)
        {
            throw new VaultException("BAD_FORMAT", "Coffre illisible.");
        }
        using var _ = doc;
        var root = doc.RootElement;
        byte[] vaultKey;
        try
        {
            if (root.GetProperty("v").GetInt32() != 1) throw new VaultException("BAD_FORMAT", "Format de coffre inconnu.");
            var kdf = root.GetProperty("kdf");
            var salt = Convert.FromBase64String(kdf.GetProperty("salt").GetString()!);
            var iterations = kdf.GetProperty("iterations").GetInt32();
            if (iterations < 1 || iterations > 10_000_000) throw new VaultException("BAD_FORMAT", "Coffre illisible.");
            var kek = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(masterPassword.Normalize(NormalizationForm.FormKC)), salt, iterations, HashAlgorithmName.SHA256, 32);
            try
            {
                vaultKey = Open(kek, root.GetProperty("wrappedKey"), AadWrap);
            }
            catch (CryptographicException)
            {
                throw new VaultException("WRONG_PASSWORD", "Mot de passe maître incorrect.");
            }
        }
        catch (Exception e) when (e is KeyNotFoundException or FormatException or JsonException or InvalidOperationException)
        {
            throw new VaultException("BAD_FORMAT", "Coffre illisible.");
        }

        try
        {
            var data = Open(vaultKey, root.GetProperty("data"), AadData);
            using var dd = JsonDocument.Parse(data);
            var list = new List<Entry>();
            foreach (var e in dd.RootElement.GetProperty("entries").EnumerateArray())
            {
                string S(string name) => e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";
                list.Add(new Entry(S("id"), S("title"), S("url"), S("username"), S("password")));
            }
            return list.OrderBy(x => x.Title, StringComparer.CurrentCultureIgnoreCase).ToList();
        }
        catch (Exception e) when (e is CryptographicException or KeyNotFoundException or JsonException or FormatException)
        {
            throw new VaultException("CORRUPTED", "Coffre illisible ou altéré.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(vaultKey);
        }
    }
}
