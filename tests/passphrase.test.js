import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORDS } from '../src/core/wordlist.js';
import { generatePassphrase, passphraseBits, strengthFromBits, estimateStrength } from '../src/core/generator.js';
import { VERSION } from '../src/core/version.js';

test('liste de mots : assez grande, mots uniques en minuscules ASCII sans accent', () => {
  assert.ok(WORDS.length >= 512, `${WORDS.length} mots`);
  assert.equal(new Set(WORDS).size, WORDS.length);
  for (const w of WORDS) assert.match(w, /^[a-z]{3,10}$/, w);
});

test('phrase de passe : nombre de mots, séparateur, majuscules, chiffre', () => {
  const p = generatePassphrase({ words: 6, separator: '.' });
  const parts = p.split('.');
  assert.equal(parts.length, 6);
  assert.ok(parts.every((w) => WORDS.includes(w)));
  assert.equal(generatePassphrase({ words: 4, separator: '' }).match(/[a-z]+/)?.[0].length > 0, true);

  const cap = generatePassphrase({ words: 5, separator: ' ', capitalize: true });
  assert.ok(cap.split(' ').every((w) => /^[A-Z][a-z]+$/.test(w)));
  const num = generatePassphrase({ words: 5, separator: '-', number: true });
  assert.equal(num.match(/\d/g).length, 1);
});

test('phrase de passe : options invalides refusées', () => {
  for (const bad of [{ words: 2 }, { words: 21 }, { words: 5.5 }, { separator: 'abcd' }]) assert.throws(() => generatePassphrase(bad), RangeError, JSON.stringify(bad));
});

test('entropie annoncée = vraie entropie du tirage (pas celle de l\'estimateur de motifs)', () => {
  const per = Math.log2(WORDS.length);
  assert.equal(passphraseBits({ words: 7 }), Math.floor(7 * per));
  assert.ok(passphraseBits({ words: 7, number: true }) > passphraseBits({ words: 7 }));
  assert.equal(strengthFromBits(passphraseBits({ words: 3 })).label, 'faible');
  assert.ok(['bon', 'excellent'].includes(strengthFromBits(passphraseBits({ words: 8 })).label));
  // l'estimateur de caractères surestimerait fortement une phrase : on ne l'utilise pas pour elle
  assert.ok(estimateStrength(generatePassphrase({ words: 5 })).bits > passphraseBits({ words: 5 }));
});

test('tirage uniforme : chaque mot sort avec une fréquence cohérente', () => {
  const counts = new Map();
  const N = WORDS.length * 120;
  for (let i = 0; i < N; i++) {
    const w = generatePassphrase({ words: 3, separator: ' ' }).split(' ')[0];
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const vals = WORDS.map((w) => counts.get(w) ?? 0);
  assert.ok(Math.min(...vals) > 50 && Math.max(...vals) < 200, `min ${Math.min(...vals)} max ${Math.max(...vals)} (attendu ~120)`);
});

test('version affichée = version du manifeste', () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).version);
});
