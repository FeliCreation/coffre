import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.js';
import { openShare, parsePublicCode, fingerprint } from '../src/core/share.js';

const FAST = { iterations: 1000 };

async function twoVaults() {
  return [await Vault.create('mot de passe alice 1', FAST), await Vault.create('mot de passe bob 22', FAST)];
}

test('partage de bout en bout entre deux coffres', async () => {
  const [alice, bob] = await twoVaults();
  const { id } = alice.addEntry({ title: 'Netflix', url: 'netflix.com', username: 'famille', password: 'Tr3s-S3cret', notes: 'profil 2' });

  const code = await alice.shareEntry(id, await bob.myPublicCode());
  assert.ok(!code.includes('Tr3s'), 'le code ne doit pas contenir le secret');

  const { entry, senderFingerprint } = await bob.importShare(code);
  const full = bob.getEntry(entry.id);
  assert.equal(full.password, 'Tr3s-S3cret');
  assert.equal(full.username, 'famille');
  assert.equal(full.notes, 'profil 2');
  assert.equal(senderFingerprint, await alice.myFingerprint());
  assert.ok(full.source.sharedBy);
});

test('un tiers ne peut pas ouvrir le partage', async () => {
  const [alice, bob] = await twoVaults();
  const eve = await Vault.create('mot de passe eve 333', FAST);
  const { id } = alice.addEntry({ title: 'X', password: 'p' });
  const code = await alice.shareEntry(id, await bob.myPublicCode());
  await assert.rejects(eve.importShare(code), { code: 'NOT_FOR_YOU' });
});

test('partage altéré refusé', async () => {
  const [alice, bob] = await twoVaults();
  const { id } = alice.addEntry({ title: 'X', password: 'p' });
  const code = await alice.shareEntry(id, await bob.myPublicCode());
  const prefix = 'coffre-share:1:';
  const blob = JSON.parse(Buffer.from(code.slice(prefix.length), 'base64url').toString());
  const ct = Buffer.from(blob.ct, 'base64');
  ct[0] ^= 1;
  blob.ct = ct.toString('base64');
  const forged = prefix + Buffer.from(JSON.stringify(blob)).toString('base64url');
  await assert.rejects(bob.importShare(forged), { code: 'DECRYPT_FAILED' });
});

test('substitution de l\'expéditeur détectée', async () => {
  const [alice, bob] = await twoVaults();
  const eve = await Vault.create('mot de passe eve 333', FAST);
  const { id } = alice.addEntry({ title: 'X', password: 'p' });
  const code = await alice.shareEntry(id, await bob.myPublicCode());
  const prefix = 'coffre-share:1:';
  const blob = JSON.parse(Buffer.from(code.slice(prefix.length), 'base64url').toString());
  blob.from = eve.identity.publicKey; // Eve se fait passer pour l'expéditeur
  const forged = prefix + Buffer.from(JSON.stringify(blob)).toString('base64url');
  await assert.rejects(bob.importShare(forged), { code: 'DECRYPT_FAILED' });
});

test('partage expiré refusé', async () => {
  const [alice, bob] = await twoVaults();
  const { id } = alice.addEntry({ title: 'X', password: 'p' });
  const code = await alice.shareEntry(id, await bob.myPublicCode(), { ttlHours: 1 });
  await assert.rejects(openShare(bob.identity, code, { now: Date.now() + 2 * 3600_000 }), { code: 'EXPIRED' });
});

test('codes invalides rejetés proprement', async () => {
  const [, bob] = await twoVaults();
  await assert.rejects(parsePublicCode('n importe quoi'), { code: 'BAD_CODE' });
  await assert.rejects(bob.importShare('coffre-share:1:@@@'), { code: 'BAD_CODE' });
  await assert.rejects(parsePublicCode('coffre-pub:1:' + Buffer.from('{"x":"AAAA","y":"AAAA"}').toString('base64url')), { code: 'BAD_PUBLIC_KEY' });
});

test('empreinte stable et distincte', async () => {
  const [alice, bob] = await twoVaults();
  assert.equal(await fingerprint(alice.identity.publicKey), await fingerprint(alice.identity.publicKey));
  assert.notEqual(await alice.myFingerprint(), await bob.myFingerprint());
});

test('l\'identité survit à la sérialisation du coffre', async () => {
  const [alice] = await twoVaults();
  const before = await alice.myPublicCode();
  const reopened = await Vault.unlock(await alice.serialize(), 'mot de passe alice 1');
  assert.equal(await reopened.myPublicCode(), before);
});
