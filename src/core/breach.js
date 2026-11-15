// Vérification de fuites par « k-anonymat » (Have I Been Pwned, gratuit, sans compte) :
// seuls les 5 premiers caractères de l'empreinte SHA-1 du mot de passe quittent l'appareil ; jamais le mot de passe lui-même.

const API = 'https://api.pwnedpasswords.com/range/';

export async function sha1Hex(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Renvoie une Map mot de passe → nombre de fuites connues (absent de la Map = aucune fuite connue). */
export async function checkPwned(passwords, { fetchImpl = fetch, concurrency = 4 } = {}) {
  const unique = [...new Set(passwords.filter(Boolean))];
  const hashes = new Map(); // mot de passe → empreinte
  const byPrefix = new Map(); // préfixe → Set de suffixes
  for (const pw of unique) {
    const h = await sha1Hex(pw);
    hashes.set(pw, h);
    const p = h.slice(0, 5);
    if (!byPrefix.has(p)) byPrefix.set(p, new Set());
    byPrefix.get(p).add(h.slice(5));
  }

  const counts = new Map(); // empreinte complète → nombre
  const queue = [...byPrefix.keys()];
  const worker = async () => {
    while (queue.length) {
      const prefix = queue.pop();
      let res;
      try {
        res = await fetchImpl(`${API}${prefix}`, { headers: { 'Add-Padding': 'true' }, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      } catch {
        throw Object.assign(new Error('Le service de vérification est injoignable.'), { code: 'NETWORK' });
      }
      if (!res.ok) throw Object.assign(new Error(`Le service de vérification a répondu ${res.status}.`), { code: 'HTTP' });
      for (const line of (await res.text()).split(/\r?\n/)) {
        const [suffix, n] = line.trim().split(':');
        if (suffix && byPrefix.get(prefix).has(suffix.toUpperCase())) counts.set(prefix + suffix.toUpperCase(), Number(n) || 0);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const out = new Map();
  for (const [pw, h] of hashes) if ((counts.get(h) ?? 0) > 0) out.set(pw, counts.get(h));
  return out;
}
