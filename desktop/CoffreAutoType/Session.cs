using System.Text.Json;

namespace CoffreAutoType;

public enum TypeMode { Both, PasswordOnly, UsernameOnly }

/// <summary>État du logiciel : coffre déchiffré en mémoire seulement tant qu'il est déverrouillé.</summary>
public sealed class Session
{
    public Settings Settings { get; } = Settings.Load();
    public List<Entry>? Entries { get; private set; }
    public DateTime LastUse { get; private set; } = DateTime.UtcNow;
    public bool Unlocked => Entries is not null;

    public void Touch() => LastUse = DateTime.UtcNow;

    public void Lock() => Entries = null;

    /// <summary>Télécharge le coffre chiffré depuis GitHub et le met en cache (rien n'est déchiffré ici).</summary>
    public async Task Download()
    {
        var json = await new GitHubClient(Settings.Repo, Settings.Token).FetchVault();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.GetProperty("v").GetInt32() != 1) throw new SyncException("BAD_FORMAT", "Le fichier distant n'est pas un coffre Coffre.");
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            throw new SyncException("BAD_FORMAT", "Le fichier distant n'est pas un coffre Coffre.");
        }
        Settings.WriteVaultCache(json);
    }

    /// <summary>Première configuration : dépôt + jeton, puis téléchargement du coffre. Rien n'est conservé si ça échoue.</summary>
    public async Task Join(string repo, string token)
    {
        var (oldRepo, oldToken) = (Settings.Repo, Settings.Token);
        Settings.Repo = repo.Trim();
        Settings.Token = token.Trim();
        try
        {
            await Download();
            Settings.Save();
        }
        catch
        {
            Settings.Repo = oldRepo;
            Settings.Token = oldToken;
            throw;
        }
    }

    /// <summary>Déverrouille avec le mot de passe maître (après une tentative de mise à jour du coffre ; hors ligne : copie en cache).</summary>
    public async Task Unlock(string masterPassword)
    {
        if (Settings.HasSync)
        {
            try { await Download(); } catch (SyncException) { }
        }
        var json = Settings.ReadVaultCache() ?? throw new VaultException("NO_VAULT", "Aucun coffre : configurez d'abord le dépôt et le jeton.");
        Entries = await Task.Run(() => VaultFile.Unlock(json, masterPassword));
        Touch();
    }
}
