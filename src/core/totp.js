// Codes à usage unique (TOTP, RFC 6238) : SHA-1/256/512, 6 à 8 chiffres, période configurable.
// Web Crypto uniquement. Le secret ne sort jamais du service worker : l'interface ne reçoit que le code.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALGOS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export class TotpError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BAD_TOTP';
  }
}

export function base32Decode(input) {
  const s = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!s || /[^A-Z2-7]/.test(s)) throw new TotpError('Clé 2FA invalide (lettres A-Z et chiffres 2-7 attendus).');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Accepte une clé base32 seule ou un lien otpauth://totp/… Renvoie les paramètres validés. */
export function parseTotp(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new TotpError('Clé 2FA vide.');
  let secretText = raw;
  let algorithm = 'SHA-1';
  let digits = 6;
  let period = 30;
  let issuer = '';
  if (/^otpauth:\/\//i.test(raw)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new TotpError('Lien otpauth:// invalide.');
    }
    if (u.hostname.toLowerCase() !== 'totp') throw new TotpError('Seuls les codes TOTP (par durée) sont pris en charge.');
    const p = u.searchParams;
    secretText = p.get('secret') ?? '';
    if (p.get('algorithm')) {
      algorithm = ALGOS[p.get('algorithm').toUpperCase().replace('-', '')];
      if (!algorithm) throw new TotpError('Algorithme 2FA non pris en charge.');
    }
    if (p.get('digits')) digits = Number(p.get('digits'));
    if (p.get('period')) period = Number(p.get('period'));
    issuer = p.get('issuer') ?? '';
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new TotpError('Nombre de chiffres 2FA invalide (6 à 8).');
  if (!Number.isInteger(period) || period < 10 || period > 120) throw new TotpError('Période 2FA invalide (10 à 120 s).');
  const secret = base32Decode(secretText);
  if (secret.length < 8) throw new TotpError('Clé 2FA trop courte.');
  return { secret, algorithm, digits, period, issuer };
}

/** Code courant + secondes restantes. `now` en millisecondes. */
export async function totpCode(input, now = Date.now()) {
  const { secret, algorithm, digits, period } = parseTotp(input);
  const counter = Math.floor(now / 1000 / period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  const code = String(bin % 10 ** digits).padStart(digits, '0');
  return { code, period, remaining: period - (Math.floor(now / 1000) % period) };
}
