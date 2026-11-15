// Kit de récupération : un code aléatoire de 160 bits (32 caractères base32) qui peut rouvrir le coffre
// si le mot de passe maître est oublié. Il est affiché une seule fois et n'est stocké nulle part.

import { randomBytes } from './crypto.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648
export const RECOVERY_BYTES = 20;

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Nouveau code, au format affiché « ABCD-EFGH-… » (8 groupes de 4). */
export function newRecoveryCode() {
  return base32(randomBytes(RECOVERY_BYTES)).match(/.{4}/g).join('-');
}

/** Forme canonique d'un code saisi (espaces, tirets et minuscules tolérés). Renvoie null si invalide. */
export function normalizeRecoveryCode(input) {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${ALPHABET}]{${(RECOVERY_BYTES * 8) / 5}}$`).test(s) ? s : null;
}
