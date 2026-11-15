import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from '../dev/chrome-mock.js';
import { sha1Hex } from '../src/core/breach.js';

const mock = installChrome();
const { chrome } = mock;
await import('../src/background/service-worker.js');
const call = (msg) => chrome.runtime.sendMessage(msg);
const PW = 'correct horse battery staple';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
let totpId;

test('préparation : coffre avec mot de passe faible, doublon et clé 2FA', async () => {
  await call({ type: 'create', password: PW });
  totpId = (await call({ type: 'add', entry: { title: 'GitHub', url: 'github.com', username: 'moi', password: 'Zq8$vN2!rT5#mLw9', totp: SECRET } })).entry.id;
  await call({ type: 'add', entry: { title: 'Vieux', url: 'vieux.fr', password: '123456' } });
  await call({ type: 'add', entry: { title: 'A', password: 'Mdp-Partagé-9x!Kq2' } });
  await call({ type: 'add', entry: { title: 'B', password: 'Mdp-Partagé-9x!Kq2' } });
  assert.equal((await call({ type: 'add', entry: { title: 'Mauvaise 2FA', totp: 'ABCD' } })).code, 'BAD_TOTP');
});

test('2FA : code calculé dans le service worker, secret jamais renvoyé, refusé aux pages', async () => {
  const r = await call({ type: 'totp', id: totpId });
  assert.equal(r.ok, true);
  assert.match(r.code, /^\d{6}$/);
  assert.ok(r.remaining >= 1 && r.remaining <= 30);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  const list = await call({ type: 'list', query: '' });
  assert.ok(!JSON.stringify(list).includes(SECRET));
  assert.equal(list.entries.find((e) => e.id === totpId).hasTotp, true);
  const noTotp = list.entries.find((e) => e.title === 'Vieux');
  assert.equal((await call({ type: 'totp', id: noTotp.id })).code, 'NO_TOTP');
  assert.equal(await mock.fromContent({ type: 'totp', id: totpId }, { url: 'https://github.com/' }), undefined);
});

test('audit local : faible, réutilisés, sans mot de passe dans la réponse', async () => {
  const r = await call({ type: 'audit' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.audit.weak.map((x) => x.title), ['Vieux']);
  assert.equal(r.audit.reused.length, 1);
  assert.deepEqual(r.audit.reused[0].entries.map((x) => x.title).sort(), ['A', 'B']);
  const raw = JSON.stringify(r);
  for (const s of ['123456', 'Zq8$', 'Partagé-9x']) assert.ok(!raw.includes(s), s);
  assert.equal(await mock.fromContent({ type: 'audit' }, { url: 'https://github.com/' }), undefined);
});

test('fuites : seuls les préfixes partent, résultat sans mot de passe', async () => {
  const leaked = await sha1Hex('123456');
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    const body = url.endsWith(leaked.slice(0, 5)) ? `${leaked.slice(5)}:37000000` : '00000AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0';
    return { ok: true, status: 200, text: async () => body };
  };
  const r = await call({ type: 'auditBreaches' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.exposed.map((x) => [x.title, x.count]), [['Vieux', 37000000]]);
  assert.equal(r.checked, 3);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((u) => /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/.test(u)));
  assert.ok(!JSON.stringify(r).includes('123456'));

  globalThis.fetch = async () => { throw new TypeError('hors ligne'); };
  assert.equal((await call({ type: 'auditBreaches' })).code, 'NETWORK');
});

test('modifier / effacer la clé 2FA par le service worker', async () => {
  assert.equal((await call({ type: 'update', id: totpId, patch: { totp: 'pas valide' } })).code, 'BAD_TOTP');
  assert.equal((await call({ type: 'update', id: totpId, patch: { totp: '' } })).ok, true);
  assert.equal((await call({ type: 'totp', id: totpId })).code, 'NO_TOTP');
});
