import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from '../dev/chrome-mock.js';

const mock = installChrome();
const { chrome } = mock;
await import('../src/background/service-worker.js');
const call = (msg) => chrome.runtime.sendMessage(msg);

test('copie d\'un secret : effacement programmé à 30 s par défaut', async () => {
  assert.equal((await call({ type: 'getSettings' })).settings.clipboardClearSeconds, 30);
  mock.alarms.delete('clipclear');
  assert.equal((await call({ type: 'clipboardCopied' })).ok, true);
  assert.equal(mock.alarms.get('clipclear').delayInMinutes, 0.5);
});

test('réglages : délai personnalisé, désactivation, valeurs refusées, autre réglage préservé', async () => {
  assert.equal((await call({ type: 'setSettings', settings: { autoLockMinutes: 5 } })).ok, true);
  assert.equal((await call({ type: 'setSettings', settings: { clipboardClearSeconds: 60 } })).ok, true);
  const s = (await call({ type: 'getSettings' })).settings;
  assert.deepEqual([s.autoLockMinutes, s.clipboardClearSeconds], [5, 60]);

  for (const bad of [10, 601, -1, 'abc']) {
    assert.equal((await call({ type: 'setSettings', settings: { clipboardClearSeconds: bad } })).code, 'BAD_SETTING', String(bad));
  }
  mock.alarms.delete('clipclear');
  await call({ type: 'setSettings', settings: { clipboardClearSeconds: 0 } });
  await call({ type: 'clipboardCopied' });
  assert.equal(mock.alarms.has('clipclear'), false);
});

test('une page web ne peut pas programmer d\'effacement', async () => {
  assert.equal(await mock.fromContent({ type: 'clipboardCopied' }, { url: 'https://exemple.fr/' }), undefined);
});
