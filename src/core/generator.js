// Générateur de mots de passe et de phrases de passe. Aléa cryptographique + tirage sans biais (rejection sampling).

import { WORDS } from './wordlist.js';

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/',
};
const AMBIGUOUS = /[Il1O0o|]/g;

export const DEFAULTS = Object.freeze({
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
});

/** Entier uniforme dans [0, max[. */
export function randomInt(max) {
  if (!Number.isInteger(max) || max < 1 || max > 2 ** 32) throw new RangeError('max invalide');
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

const pick = (s) => s[randomInt(s.length)];

export function generatePassword(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const classes = ['lower', 'upper', 'digits', 'symbols']
    .filter((k) => o[k])
    .map((k) => (o.excludeAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]));

  if (classes.length === 0) throw new RangeError('Activez au moins un type de caractères.');
  if (!Number.isInteger(o.length) || o.length < 4 || o.length > 128) throw new RangeError('Longueur : 4 à 128.');
  if (o.length < classes.length) throw new RangeError('Longueur trop courte pour les types choisis.');

  const pool = classes.join('');
  // Un caractère de chaque type activé, le reste dans le pool entier, puis mélange.
  const chars = classes.map(pick);
  while (chars.length < o.length) chars.push(pick(pool));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Estimation grossière de la force (bits d'entropie si tirage uniforme), avec pénalités
 * pour les motifs triviaux. Indicatif : sert à guider, pas à garantir.
 */
export function estimateStrength(password) {
  if (!password) return { bits: 0, label: 'vide', score: 0 };
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 24;
  let bits = password.length * Math.log2(pool || 1);

  const uniq = new Set(password).size;
  if (uniq <= password.length / 3) bits *= 0.5; // beaucoup de répétitions
  if (/(.)\1{2,}/.test(password)) bits -= 8;
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|azer)/i.test(password)) bits -= 10;
  if (/(password|motdepasse|azerty|qwerty|admin|123456)/i.test(password)) bits = Math.min(bits, 20);
  bits = Math.max(0, Math.round(bits));

  return strengthFromBits(bits);
}

/** Niveau (1 à 4) et libellé d'une entropie en bits. */
export function strengthFromBits(bits) {
  const [score, label] = bits < 40 ? [1, 'faible'] : bits < 60 ? [2, 'moyen'] : bits < 80 ? [3, 'bon'] : [4, 'excellent'];
  return { bits, label, score };
}

export const PASSPHRASE_DEFAULTS = Object.freeze({ words: 7, separator: '-', capitalize: false, number: false });

function checkPassphrase(options) {
  const o = { ...PASSPHRASE_DEFAULTS, ...options };
  if (!Number.isInteger(o.words) || o.words < 3 || o.words > 20) throw new RangeError('Nombre de mots : 3 à 20.');
  if (typeof o.separator !== 'string' || o.separator.length > 3) throw new RangeError('Séparateur : 3 caractères au plus.');
  return o;
}

/** Entropie RÉELLE (bits) d'une phrase tirée avec ces options : seuls les tirages aléatoires comptent. */
export function passphraseBits(options = {}) {
  const o = checkPassphrase(options);
  let bits = o.words * Math.log2(WORDS.length);
  if (o.number) bits += Math.log2(10 * o.words); // un chiffre ajouté à un mot tiré au hasard
  return Math.floor(bits);
}

/** Phrase de passe : mots français tirés uniformément (aléa cryptographique), séparés par `separator`. */
export function generatePassphrase(options = {}) {
  const o = checkPassphrase(options);
  const words = Array.from({ length: o.words }, () => WORDS[randomInt(WORDS.length)]);
  if (o.number) {
    const i = randomInt(words.length);
    words[i] += String(randomInt(10));
  }
  return words.map((w) => (o.capitalize ? w[0].toUpperCase() + w.slice(1) : w)).join(o.separator);
}
