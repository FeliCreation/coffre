// Client minimal de l'API GitHub « contents » : lit et écrit un seul fichier (le coffre CHIFFRÉ) dans un dépôt privé.
// Le jeton n'est envoyé qu'à api.github.com, jamais journalisé, jamais placé dans une URL.

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const PATH_RE = /^[A-Za-z0-9_.-][A-Za-z0-9_./-]{0,198}$/;

export function checkConfig({ repo, token, path = 'coffre.json' }) {
  if (!REPO_RE.test(repo ?? '')) throw new SyncError('BAD_REPO', 'Dépôt invalide : écrivez « compte/nom-du-dépôt ».');
  if (typeof token !== 'string' || token.trim().length < 20 || /\s/.test(token.trim())) throw new SyncError('BAD_TOKEN', 'Jeton invalide.');
  if (!PATH_RE.test(path) || path.includes('..')) throw new SyncError('BAD_PATH', 'Nom de fichier invalide.');
  return { repo, token: token.trim(), path };
}

const utf8ToB64 = (s) => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64ToUtf8 = (b64) => {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

async function call(fetchImpl, { token }, method, path, body) {
  let res;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('NETWORK', 'GitHub est injoignable (connexion ou délai dépassé).');
  }
  return res;
}

function httpError(res) {
  if (res.status === 401) return new SyncError('AUTH', 'Jeton refusé par GitHub (expiré ou révoqué).');
  if (res.status === 403 || res.status === 429) return new SyncError('FORBIDDEN', "Accès refusé par GitHub (droits du jeton ou limite d'appels).");
  return new SyncError('HTTP', `GitHub a répondu ${res.status}.`);
}

/** Lit le fichier. Renvoie { sha, json } ou null s'il n'existe pas encore. */
export async function getFile(cfg, fetchImpl = fetch) {
  const { repo, path } = cfg;
  const res = await call(fetchImpl, cfg, 'GET', `/repos/${repo}/contents/${path}`);
  if (res.status === 404) {
    const r = await call(fetchImpl, cfg, 'GET', `/repos/${repo}`);
    if (r.status === 404) throw new SyncError('NO_REPO', "Dépôt introuvable, ou le jeton n'y a pas accès.");
    if (!r.ok) throw httpError(r);
    return null;
  }
  if (!res.ok) throw httpError(res);
  const meta = await res.json();
  let text;
  if (meta.content && meta.encoding === 'base64') {
    text = b64ToUtf8(meta.content);
  } else {
    const blob = await call(fetchImpl, cfg, 'GET', `/repos/${repo}/git/blobs/${encodeURIComponent(meta.sha)}`); // fichier > 1 Mo
    if (!blob.ok) throw httpError(blob);
    text = b64ToUtf8((await blob.json()).content);
  }
  try {
    return { sha: meta.sha, json: JSON.parse(text) };
  } catch {
    throw new SyncError('BAD_FORMAT', "Le fichier distant n'est pas un coffre.");
  }
}

/** Écrit le fichier. `sha` = version qu'on croit remplacer (absent pour une création). */
export async function putFile(cfg, json, sha, fetchImpl = fetch) {
  const { repo, path } = cfg;
  const body = { message: 'Synchronisation du coffre', content: utf8ToB64(JSON.stringify(json)), ...(sha ? { sha } : {}) };
  const res = await call(fetchImpl, cfg, 'PUT', `/repos/${repo}/contents/${path}`, body);
  if (res.status === 409 || res.status === 422) throw new SyncError('CONFLICT', 'Le coffre distant a changé pendant la synchronisation.');
  if (!res.ok) throw httpError(res);
  return (await res.json()).content?.sha ?? null;
}
