import assert from 'node:assert/strict';

/** Faux GitHub : un seul fichier, contrôle du sha comme l'API réelle. */
export function fakeGithub(token, { repoExists = true, onPut } = {}) {
  const s = { file: null, sha: 0, calls: [], tokens: new Set() };
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  s.fetch = async (url, init) => {
    s.calls.push(`${init.method} ${url}`);
    s.tokens.add(init.headers.Authorization);
    const u = new URL(url);
    assert.equal(u.hostname, 'api.github.com');
    assert.ok(!url.includes(token), 'le jeton ne doit jamais être dans une URL');
    if (!repoExists) return json(404, {});
    if (u.pathname.endsWith('/contents/coffre.json')) {
      if (init.method === 'GET') {
        return s.file ? json(200, { sha: String(s.sha), encoding: 'base64', content: Buffer.from(s.file).toString('base64') }) : json(404, {});
      }
      const body = JSON.parse(init.body);
      onPut?.(s);
      if ((s.file && body.sha !== String(s.sha)) || (!s.file && body.sha)) return json(409, {});
      s.file = Buffer.from(body.content, 'base64').toString('utf8');
      s.sha++;
      return json(200, { content: { sha: String(s.sha) } });
    }
    return json(200, {}); // GET /repos/x/y
  };
  return s;
}

