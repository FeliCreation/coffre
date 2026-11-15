import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword, estimateStrength, randomInt } from '../src/core/generator.js';

test('longueur respectée et types garantis', () => {
  for (let i = 0; i < 200; i++) {
    const p = generatePassword({ length: 8 });
    assert.equal(p.length, 8);
    assert.match(p, /[a-z]/);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[0-9]/);
    assert.match(p, /[^a-zA-Z0-9]/);
  }
});

test('types désactivés absents', () => {
  const p = generatePassword({ length: 64, symbols: false, digits: false });
  assert.match(p, /^[a-zA-Z]+$/);
});

test('caractères ambigus exclus', () => {
  for (let i = 0; i < 100; i++) assert.doesNotMatch(generatePassword({ length: 64, excludeAmbiguous: true }), /[Il1O0o|]/);
});

test('options invalides rejetées', () => {
  assert.throws(() => generatePassword({ lower: false, upper: false, digits: false, symbols: false }), RangeError);
  assert.throws(() => generatePassword({ length: 3 }), RangeError);
  assert.throws(() => generatePassword({ length: 500 }), RangeError);
});

test('deux tirages différents', () => {
  assert.notEqual(generatePassword(), generatePassword());
});

test('randomInt reste dans les bornes et couvre la plage', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const n = randomInt(6);
    assert.ok(n >= 0 && n < 6);
    seen.add(n);
  }
  assert.equal(seen.size, 6);
  assert.throws(() => randomInt(0), RangeError);
});

test('estimation de force', () => {
  assert.equal(estimateStrength('').score, 0);
  assert.equal(estimateStrength('password').label, 'faible');
  assert.equal(estimateStrength('aaaaaaaaaaaa').label, 'faible');
  assert.ok(estimateStrength(generatePassword({ length: 24 })).score >= 4);
});
