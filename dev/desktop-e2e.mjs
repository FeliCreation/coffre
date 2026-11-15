// Prépare un coffre de test (jamais le vrai), lance dev/desktop-e2e.ps1 : raccourci global + saisie réelle dans une fenêtre.
// Interactif : une fenêtre « Banque » apparaît ~12 s et reçoit des frappes ; ne touchez pas au clavier pendant ce temps.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from '../src/core/vault.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const build = spawnSync('dotnet', ['build', '-c', 'Release', '--nologo', '-v', 'q'], { cwd: join(ROOT, 'desktop', 'CoffreAutoType'), encoding: 'utf8', shell: true });
if (build.status !== 0) throw new Error(`compilation échouée :\n${build.stdout}${build.stderr}`);

const MASTER = 'motdepasse-de-test-42';
const USER = 'cyril.test';
const PASS = 'Mdp$Test&é!99';
const v = await Vault.create(MASTER, { iterations: 2000 });
v.addEntry({ title: 'Autre site', url: 'autre.fr', username: 'zzz', password: 'zzz' });
v.addEntry({ title: 'Banque', url: 'mabanque.fr', username: USER, password: PASS });
const dir = mkdtempSync(join(tmpdir(), 'coffre-autotype-e2e-'));
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vault.json'), JSON.stringify(await v.serialize()));
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'dev', 'desktop-e2e.ps1'), dir, MASTER, USER, PASS], { encoding: 'utf8' });
  console.log((r.stdout || '').trim() || r.stderr);
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
