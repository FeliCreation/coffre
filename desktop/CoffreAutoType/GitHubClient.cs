using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CoffreAutoType;

public sealed class SyncException : Exception
{
    public string Code { get; }
    public SyncException(string code, string message) : base(message) => Code = code;
}

/// <summary>Lit le coffre CHIFFRÉ dans un dépôt GitHub privé (lecture seule). Le jeton ne va qu'à api.github.com.</summary>
public sealed class GitHubClient
{
    public static readonly Regex RepoRe = new(@"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$");
    readonly HttpClient http;
    readonly string baseUrl;
    readonly string repo;
    readonly string path;

    public GitHubClient(string repo, string token, string path = "coffre.json", string baseUrl = "https://api.github.com", HttpMessageHandler? handler = null)
    {
        if (!RepoRe.IsMatch(repo)) throw new SyncException("BAD_REPO", "Dépôt invalide : écrivez « compte/nom-du-dépôt ».");
        if (token.Trim().Length < 20 || token.Any(char.IsWhiteSpace)) throw new SyncException("BAD_TOKEN", "Jeton invalide.");
        this.repo = repo;
        this.path = path;
        this.baseUrl = baseUrl.TrimEnd('/');
        http = handler is null ? new HttpClient() : new HttpClient(handler);
        http.Timeout = TimeSpan.FromSeconds(15);
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        http.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
        http.DefaultRequestHeaders.UserAgent.ParseAdd("CoffreAutoType/1.0");
    }

    async Task<HttpResponseMessage> Get(string url)
    {
        try
        {
            return await http.GetAsync(url);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw new SyncException("NETWORK", "GitHub est injoignable (connexion ou délai dépassé).");
        }
    }

    static SyncException Http(HttpStatusCode c) => c switch
    {
        HttpStatusCode.Unauthorized => new SyncException("AUTH", "Jeton refusé par GitHub (expiré ou révoqué)."),
        HttpStatusCode.Forbidden or (HttpStatusCode)429 => new SyncException("FORBIDDEN", "Accès refusé par GitHub (droits du jeton ou limite d'appels)."),
        _ => new SyncException("HTTP", $"GitHub a répondu {(int)c}."),
    };

    /// <summary>Contenu JSON du coffre chiffré (texte), ou erreur explicite.</summary>
    public async Task<string> FetchVault()
    {
        using var res = await Get($"{baseUrl}/repos/{repo}/contents/{path}");
        if (res.StatusCode == HttpStatusCode.NotFound)
        {
            using var r = await Get($"{baseUrl}/repos/{repo}");
            if (r.StatusCode == HttpStatusCode.NotFound) throw new SyncException("NO_REPO", "Dépôt introuvable, ou le jeton n'y a pas accès.");
            throw new SyncException("NO_VAULT", "Ce dépôt ne contient pas encore de coffre : activez d'abord la synchronisation dans l'extension.");
        }
        if (!res.IsSuccessStatusCode) throw Http(res.StatusCode);
        using var meta = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        var root = meta.RootElement;
        string b64;
        if (root.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String && c.GetString()!.Length > 0 &&
            root.TryGetProperty("encoding", out var enc) && enc.GetString() == "base64")
        {
            b64 = c.GetString()!;
        }
        else
        {
            var sha = root.GetProperty("sha").GetString()!; // fichier > 1 Mo : API des « blobs »
            using var blob = await Get($"{baseUrl}/repos/{repo}/git/blobs/{Uri.EscapeDataString(sha)}");
            if (!blob.IsSuccessStatusCode) throw Http(blob.StatusCode);
            using var bj = JsonDocument.Parse(await blob.Content.ReadAsStringAsync());
            b64 = bj.RootElement.GetProperty("content").GetString()!;
        }
        return Encoding.UTF8.GetString(Convert.FromBase64String(b64.Replace("\n", "").Replace("\r", "")));
    }
}
