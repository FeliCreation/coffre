// Primitives cryptographiques (Web Crypto uniquement, zéro dépendance).
// AES-256-GCM pour le chiffrement, PBKDF2-SHA256 pour dériver la clé du mot de passe maître.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const KDF_ITERATIONS = 600_000; // recommandation OWASP pour PBKDF2-HMAC-SHA256

export class CryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

export function toB64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const toB64Url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromB64Url(str) {
  const p = str.replace(/-/g, '+').replace(/_/g, '/');
  return fromB64(p + '='.repeat((4 - (p.length % 4)) % 4));
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Clé de chiffrement de clé (KEK) dérivée du mot de passe maître. Non exportable. */
export async function deriveKek(password, salt, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Clé aléatoire du coffre. Exportable pour être gardée en session (mémoire seulement). */
export const newVaultKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

export const importVaultKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);

export async function exportKey(key) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

/** Chiffre des octets. `aad` lie le chiffré à son usage (empêche de permuter des blocs). */
export async function seal(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes);
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function open(key, sealed, aad) {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: enc.encode(aad) },
      key,
      fromB64(sealed.ct),
    );
    return new Uint8Array(pt);
  } catch {
    throw new CryptoError('DECRYPT_FAILED', 'Déchiffrement impossible (clé incorrecte ou données altérées).');
  }
}

export const sealJson = (key, obj, aad) => seal(key, enc.encode(JSON.stringify(obj)), aad);
export const openJson = async (key, sealed, aad) => JSON.parse(dec.decode(await open(key, sealed, aad)));

export async function sha256Hex(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}
