using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoffreAutoType;

/// <summary>Réglages locaux. Le jeton GitHub est protégé par DPAPI (lié à votre session Windows) ; le coffre en cache reste chiffré.</summary>
public sealed class Settings
{
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes("CoffreAutoType:token:v1");
    /// <summary>Dossier des réglages (COFFRE_AUTOTYPE_DIR : seulement pour les tests automatiques).</summary>
    public static string Dir { get; set; } = Environment.GetEnvironmentVariable("COFFRE_AUTOTYPE_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CoffreAutoType");
    static string ConfigPath => Path.Combine(Dir, "config.json");
    public static string VaultCachePath => Path.Combine(Dir, "vault.json");

    public string Repo { get; set; } = "";
    public string TokenProtected { get; set; } = "";
    public string Hotkey { get; set; } = "Ctrl+Alt+K";
    public int AutoLockMinutes { get; set; } = 5;
    public bool PressEnter { get; set; } = false;

    [JsonIgnore]
    public string Token
    {
        get
        {
            if (TokenProtected.Length == 0) return "";
            try
            {
                return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(TokenProtected), Entropy, DataProtectionScope.CurrentUser));
            }
            catch (Exception e) when (e is CryptographicException or FormatException)
            {
                return ""; // config copiée d'une autre session : il faudra ressaisir le jeton
            }
        }
        set => TokenProtected = value.Length == 0 ? "" : Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), Entropy, DataProtectionScope.CurrentUser));
    }

    [JsonIgnore] public bool HasSync => Repo.Length > 0 && Token.Length > 0;
    [JsonIgnore] public bool HasVault => File.Exists(VaultCachePath);

    public static Settings Load()
    {
        try
        {
            if (File.Exists(ConfigPath)) return JsonSerializer.Deserialize<Settings>(File.ReadAllText(ConfigPath)) ?? new Settings();
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { }
        return new Settings();
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    public static string? ReadVaultCache() => File.Exists(VaultCachePath) ? File.ReadAllText(VaultCachePath) : null;

    public static void WriteVaultCache(string json)
    {
        Directory.CreateDirectory(Dir);
        var tmp = VaultCachePath + ".tmp";
        File.WriteAllText(tmp, json);
        File.Move(tmp, VaultCachePath, overwrite: true); // jamais de fichier à moitié écrit
    }
}
