using System.Net;
using System.Text;
using System.Text.Json;

namespace CoffreAutoType;

/// <summary>
/// Test de compatibilité : CoffreAutoType.exe --selftest sortie.json coffre.json motdepasse
/// Déchiffre un coffre produit par le code JavaScript et exerce le client GitHub avec de fausses réponses.
/// </summary>
static class SelfTest
{
    sealed class FakeHandler : HttpMessageHandler
    {
        public Func<HttpRequestMessage, HttpResponseMessage> Respond { get; set; } = _ => new HttpResponseMessage(HttpStatusCode.NotFound);
        public List<string> Requests { get; } = new();
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add($"{request.Method} {request.RequestUri!.AbsolutePath} auth={(request.Headers.Authorization is not null)}");
            return Task.FromResult(Respond(request));
        }
    }

    static HttpResponseMessage Json(HttpStatusCode code, object body) => new(code) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    public static int Run(string[] args)
    {
        var result = new Dictionary<string, object?>();
        try
        {
            var vaultJson = File.ReadAllText(args[2]);
            var password = args[3];
            var entries = VaultFile.Unlock(vaultJson, password);
            result["count"] = entries.Count;
            result["entries"] = entries.Select(e => new { e.Title, e.Url, e.Username, e.Password, e.Host }).ToList();

            result["wrongPassword"] = Code(() => VaultFile.Unlock(vaultJson, password + "x"));
            result["badFormat"] = Code(() => VaultFile.Unlock("{\"v\":2}", password));
            result["notJson"] = Code(() => VaultFile.Unlock("pas du json", password));
            result["corrupted"] = Code(() =>
            {
                using var d = JsonDocument.Parse(vaultJson);
                var data = d.RootElement.GetProperty("data");
                var ct = Convert.FromBase64String(data.GetProperty("ct").GetString()!);
                ct[0] ^= 1;
                var tampered = vaultJson.Replace(data.GetProperty("ct").GetString()!, Convert.ToBase64String(ct));
                VaultFile.Unlock(tampered, password);
            });

            // Client GitHub (fausses réponses)
            var token = "github_pat_" + new string('t', 30);
            var h = new FakeHandler();
            var content = Convert.ToBase64String(Encoding.UTF8.GetBytes(vaultJson));
            h.Respond = r => r.RequestUri!.AbsolutePath.EndsWith("/contents/coffre.json")
                ? Json(HttpStatusCode.OK, new { sha = "abc", encoding = "base64", content = string.Join("\n", Chunk(content, 60)) })
                : Json(HttpStatusCode.OK, new { });
            result["githubSame"] = new GitHubClient("moi/donnees", token, handler: h).FetchVault().GetAwaiter().GetResult() == vaultJson;
            result["githubAuth"] = h.Requests.All(x => x.Contains("auth=True"));

            h.Respond = r => r.RequestUri!.AbsolutePath.EndsWith("/contents/coffre.json")
                ? Json(HttpStatusCode.OK, new { sha = "big", encoding = "none", content = "" })
                : r.RequestUri!.AbsolutePath.EndsWith("/git/blobs/big") ? Json(HttpStatusCode.OK, new { content }) : new HttpResponseMessage(HttpStatusCode.NotFound);
            result["githubBlob"] = new GitHubClient("moi/donnees", token, handler: h).FetchVault().GetAwaiter().GetResult() == vaultJson;

            result["github404repo"] = Code(() => new GitHubClient("moi/donnees", token, handler: new FakeHandler()).FetchVault().GetAwaiter().GetResult());
            h.Respond = r => r.RequestUri!.AbsolutePath.EndsWith("/contents/coffre.json") ? new HttpResponseMessage(HttpStatusCode.NotFound) : Json(HttpStatusCode.OK, new { });
            result["github404file"] = Code(() => new GitHubClient("moi/donnees", token, handler: h).FetchVault().GetAwaiter().GetResult());
            h.Respond = _ => new HttpResponseMessage(HttpStatusCode.Unauthorized);
            result["github401"] = Code(() => new GitHubClient("moi/donnees", token, handler: h).FetchVault().GetAwaiter().GetResult());
            result["badRepo"] = Code(() => new GitHubClient("pas bon", token));
            result["badToken"] = Code(() => new GitHubClient("moi/donnees", "court"));

            // Réglages : le jeton est protégé (jamais en clair dans le fichier) et se relit
            Settings.Dir = Path.Combine(Path.GetTempPath(), "coffre-autotype-selftest-" + Guid.NewGuid().ToString("N"));
            var s = new Settings { Repo = "moi/donnees" };
            s.Token = token;
            s.Save();
            var raw = File.ReadAllText(Path.Combine(Settings.Dir, "config.json"));
            result["tokenNotPlain"] = !raw.Contains(token);
            result["tokenRoundTrip"] = Settings.Load().Token == token;
            Directory.Delete(Settings.Dir, true);
            result["ok"] = true;
        }
        catch (Exception e)
        {
            result["ok"] = false;
            result["error"] = e.ToString();
        }
        File.WriteAllText(args[1], JsonSerializer.Serialize(result));
        return (bool)result["ok"]! ? 0 : 1;
    }

    static IEnumerable<string> Chunk(string s, int n) { for (var i = 0; i < s.Length; i += n) yield return s.Substring(i, Math.Min(n, s.Length - i)); }

    static string Code(Action a)
    {
        try { a(); return "none"; }
        catch (VaultException e) { return e.Code; }
        catch (SyncException e) { return e.Code; }
    }
}
