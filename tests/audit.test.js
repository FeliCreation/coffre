import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEntries, OLD_AFTER_MS } from '../src/core/audit.js';
import { checkPwned, sha1Hex } from '../src/core/breach.js';

const NOW = Date.UTC(2026, 10, 15);
const e = (id, password, extra = {}) => ({ id, title: `Site ${id}`, password, createdAt: NOW, updatedAt: NOW, ...extra });

test('audit : faibles, réutilisés, anciens, score — sans jamais exposer de mot de passe', () => {
  const r = auditEntries([
    e('a', '123456'),
    e('b', 'Tr0ub4dor&3-xylophone!'),
    e('c', 'Mdp-Partagé-9x!Kq2'),
    e('d', 'Mdp-Partagé-9x!Kq2'),
    e('e', 'Zq8$vN2!rT5#mLw9', { updatedAt: NOW - OLD_AFTER_MS - 1000 }),
    e('f', ''), // sans mot de passe : ignoré
  ], NOW);
  assert.equal(r.total, 5);
  assert.deepEqual(r.weak.map((x) => x.id), ['a']);
  assert.equal(r.reused.length, 1);
  assert.deepEqual(r.reused[0].entries.map((x) => x.id), ['c', 'd']);
  assert.deepEqual(r.old.map((x) => x.id), ['e']);
  assert.equal(r.score, 20); // seule « b » est saine : 1 sur 5
  const raw = JSON.stringify(r);
  for (const s of ['123456', 'Tr0ub4dor', 'Partagé-9x', 'Zq8$']) assert.ok(!raw.includes(s), s);
});

test('audit : coffre vide ou sans problème', () => {
  assert.equal(auditEntries([], NOW).score, 100);
  assert.equal(auditEntries([e('b', 'Tr0ub4dor&3-xylophone!')], NOW).score, 100);
});

test("SHA-1 : vecteur connu (« password »)", async () => {
  assert.equal(await sha1Hex('password'), '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
});

test('fuites : seul le préfixe de 5 caractères est envoyé, mots de passe retrouvés par suffixe', async () => {
  const urls = [];
  const leaked = await sha1Hex('password');
  const fake = async (url) => {
    urls.push(url);
    const prefix = url.split('/').pop();
    const body = prefix === leaked.slice(0, 5)
      ? `0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n${leaked.slice(5)}:9545824\r\n003D68EB55068C33ACE09247EE4C639306B:3`
      : '00000AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0';
    return { ok: true, status: 200, text: async () => body };
  };
  const res = await checkPwned(['password', 'Zq8$vN2!rT5#mLw9', 'password', ''], { fetchImpl: fake });
  assert.equal(res.get('password'), 9545824);
  assert.equal(res.has('Zq8$vN2!rT5#mLw9'), false);
  assert.equal(urls.length, 2); // doublons regroupés
  for (const u of urls) {
    assert.match(u, /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
    const path = new URL(u).pathname;
    assert.ok(!path.toLowerCase().includes('password') && !path.includes(leaked.slice(5)));
  }
});

test('fuites : erreurs réseau et HTTP signalées', async () => {
  await assert.rejects(checkPwned(['x'], { fetchImpl: async () => { throw new TypeError('hors ligne'); } }), { code: 'NETWORK' });
  await assert.rejects(checkPwned(['x'], { fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) }), { code: 'HTTP' });
});
