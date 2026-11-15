// Test de compatibilité JavaScript ↔ logiciel Windows : un coffre créé par le code de l'extension doit être
// lu à l'identique par CoffreAutoType (PBKDF2, AES-GCM, AAD, normalisation du mot de passe, GitHub).
// Usage : npm run test:desktop   (nécessite le SDK .NET 8 ; ignoré proprement sinon)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PROJECT = join(ROOT, 'desktop', 'CoffreAutoType');

const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8', shell: true });
if (dotnet.status !== 0) {
  console.log('SKIP : SDK .NET introuvable.');
  process.exit(0);
}

const build = spawnSync('dotnet', ['build', '-c', 'Release', '--nologo', '-v', 'q'], { cwd: PROJECT, encoding: 'utf8', shell: true });
assert.equal(build.status, 0, `compilation échouée :\n${build.stdout}${build.stderr}`);

// Mot de passe maître avec caractères de compatibilité Unicode : « ﬁ » (ligature), « ① », accents, symbole astral.
const PW = 'Mot de passe ÉÀ ﬁ ① 𝄞 !';
const v = await Vault.create(PW, { iterations: 2000 });
const entries = [
  { title: 'Banque', url: 'https://www.mabanque.fr/login', username: 'cyril', password: 'p@ss"w,rd\\é😀' },
  { title: 'Sans site', url: '', username: '', password: 'seul-mdp' },
  { title: 'Zèbre', url: 'exemple.fr:8443/x?y=1', username: 'z', password: 'Ünï©ôdé' },
];
for (const e of entries) v.addEntry(e);
v.addEntry({ title: 'Avec 2FA', url: 'github.com', username: 'moi', password: 'x', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
await v.createRecoveryKit({ iterations: 2000 }); // le kit ne doit pas gêner la lecture

const dir = mkdtempSync(join(tmpdir(), 'coffre-compat-'));
try {
  const vaultPath = join(dir, 'vault.json');
  const outPath = join(dir, 'result.json');
  writeFileSync(vaultPath, JSON.stringify(await v.serialize()));
  const run = spawnSync(join(PROJECT, 'bin', 'Release', 'net8.0-windows', 'CoffreAutoType.exe'), ['--selftest', outPath, vaultPath, PW], { encoding: 'utf8' });
  const r = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(r.ok, true, `selftest : ${r.error}`);
  assert.equal(run.status, 0);

  assert.equal(r.count, 4);
  const by = Object.fromEntries(r.entries.map((e) => [e.Title, e]));
  assert.equal(by['Banque'].Password, 'p@ss"w,rd\\é😀');
  assert.equal(by['Banque'].Username, 'cyril');
  assert.equal(by['Banque'].Host, 'mabanque.fr');
  assert.equal(by['Sans site'].Host, '');
  assert.equal(by['Zèbre'].Password, 'Ünï©ôdé');
  assert.equal(by['Zèbre'].Host, 'exemple.fr');
  assert.deepEqual(r.entries.map((e) => e.Title), ['Avec 2FA', 'Banque', 'Sans site', 'Zèbre']); // tri alphabétique

  assert.equal(r.wrongPassword, 'WRONG_PASSWORD');
  assert.equal(r.badFormat, 'BAD_FORMAT');
  assert.equal(r.notJson, 'BAD_FORMAT');
  assert.equal(r.corrupted, 'CORRUPTED');
  assert.equal(r.githubSame, true);
  assert.equal(r.githubAuth, true);
  assert.equal(r.githubBlob, true);
  assert.equal(r.github404repo, 'NO_REPO');
  assert.equal(r.github404file, 'NO_VAULT');
  assert.equal(r.github401, 'AUTH');
  assert.equal(r.badRepo, 'BAD_REPO');
  assert.equal(r.badToken, 'BAD_TOKEN');
  assert.equal(r.tokenNotPlain, true);
  assert.equal(r.tokenRoundTrip, true);
  console.log('OK : le logiciel Windows lit le coffre JavaScript à l\'identique (4 identifiants, caractères Unicode, erreurs, GitHub, jeton protégé).');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
