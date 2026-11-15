import test from 'node:test';
import assert from 'node:assert/strict';
import { totpCode, parseTotp, base32Decode } from '../src/core/totp.js';
import { Vault } from '../src/core/vault.js';
import { parseExport } from '../src/core/import.js';

// Vecteurs de test de la RFC 6238 (secrets ASCII « 1234567890… » en base32), codes à 8 chiffres.
const SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const SHA512 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';
const uri = (secret, algorithm) => `otpauth://totp/Test?secret=${secret.replace(/=+$/, '')}&digits=8&algorithm=${algorithm}`;

test('RFC 6238 : vecteurs SHA-1, SHA-256 et SHA-512', async () => {
  const cases = [[59, '94287082', '46119246', '90693936'], [1111111109, '07081804', '68084774', '25091201'], [20000000000, '65353130', '77737706', '47863826']];
  for (const [t, a, b, c] of cases) {
    assert.equal((await totpCode(uri(SHA1, 'SHA1'), t * 1000)).code, a, `SHA1 ${t}`);
    assert.equal((await totpCode(uri(SHA256, 'SHA256'), t * 1000)).code, b, `SHA256 ${t}`);
    assert.equal((await totpCode(uri(SHA512, 'SHA512'), t * 1000)).code, c, `SHA512 ${t}`);
  }
});

test('code à 6 chiffres par défaut, secondes restantes, clé saisie avec espaces et minuscules', async () => {
  const r = await totpCode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000);
  assert.equal(r.code, '287082'); // 6 derniers chiffres du vecteur 94287082
  assert.equal(r.period, 30);
  assert.equal(r.remaining, 1);
  assert.equal((await totpCode(SHA1, 60_000)).remaining, 30);
});

test('clés invalides refusées', () => {
  for (const bad of ['', '   ', 'ABCD', '0000 1111 8888 9999', 'otpauth://hotp/x?secret=' + SHA1, 'otpauth://totp/x', `otpauth://totp/x?secret=${SHA1}&digits=12`, `otpauth://totp/x?secret=${SHA1}&period=1`, `otpauth://totp/x?secret=${SHA1}&algorithm=MD5`]) {
    assert.throws(() => parseTotp(bad), { code: 'BAD_TOTP' }, bad);
  }
  assert.equal(base32Decode('MFRGG===').length, 3);
});

test('coffre : clé 2FA stockée chiffrée, jamais dans les listes, validée', async () => {
  const v = await Vault.create('correct horse battery staple', { iterations: 1000 });
  const { id } = v.addEntry({ title: 'GitHub', url: 'github.com', totp: SHA1 });
  const [row] = v.list();
  assert.equal(row.totp, undefined);
  assert.equal(row.hasTotp, true);
  assert.equal(v.getEntry(id).totp, SHA1);
  assert.throws(() => v.addEntry({ title: 'X', totp: 'pas une clé' }), { code: 'BAD_TOTP' });
  assert.throws(() => v.updateEntry(id, { totp: 'ABCD' }), { code: 'BAD_TOTP' });
  v.updateEntry(id, { totp: '' }); // effacer
  assert.equal(v.list()[0].hasTotp, false);
  const stored = JSON.stringify(await v.serialize());
  assert.ok(!stored.includes(SHA1));
});

test('import Dashlane/Bitwarden : clé 2FA valide → champ dédié ; invalide → conservée dans les notes', async () => {
  const csv = `username,username2,username3,title,password,note,url,category,otpUrl\nme,,,Valide,pw1,,a.fr,,otpauth://totp/A?secret=${SHA1}\nme,,,Court,pw2,,b.fr,,otpauth://totp/B?secret=ABCD\n`;
  const r = await parseExport(new TextEncoder().encode(csv), 'd.csv');
  const [ok, short] = r.entries;
  assert.equal(ok.totp, `otpauth://totp/A?secret=${SHA1}`);
  assert.ok(!ok.notes.includes('TOTP'));
  assert.equal(short.totp ?? '', '');
  assert.match(short.notes, /TOTP/);
  const v = await Vault.create('correct horse battery staple', { iterations: 1000 });
  assert.equal(v.importEntries(r.entries).added, 2);
  assert.equal(v.getEntry(v.list().find((e) => e.title === 'Valide').id).totp, ok.totp);
});
