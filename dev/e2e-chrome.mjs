// Test de bout en bout dans un VRAI Chrome (profil temporaire jetable, jamais le profil de l'utilisateur) :
// charge l'extension, crée un coffre par la vraie popup, remplit une page de connexion avec un vrai clic,
// capte un changement de mot de passe, verrouille. Aucune dépendance : protocole DevTools via WebSocket (Node 22).
// Usage : node dev/e2e-chrome.mjs [chemin de chrome.exe]

import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CHROME = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT_CDP = 9333;
const PW = 'mot de passe maître de test 42';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// ---------- Page de connexion de test (http://localhost) ----------
const html = `<!doctype html><meta charset="utf-8"><title>Connexion</title>
<form id="f"><input id="u" name="username" autocomplete="username"><br>
<input id="p" type="password" name="password" autocomplete="current-password"><br><button id="go" type="submit">Connexion</button></form>
<script>window.__ev=[];for(const id of ['u','p'])for(const t of ['input','change'])document.getElementById(id).addEventListener(t,()=>__ev.push(id+':'+t));
document.getElementById('f').addEventListener('submit',e=>e.preventDefault());</script>`;
// Connexion en deux étapes, attributs relevés sur la vraie page amazon.fr (type=text, autocomplete=webauthn, mot de passe de largeur 0) + un champ de recherche.
const html2 = `<!doctype html><meta charset="utf-8"><title>Étape 1</title>
<input type="search" id="q" name="q" placeholder="Rechercher"><br>
<form id="f"><input type="text" id="e" name="email" autocomplete="webauthn" aria-label="Saisissez un numéro de téléphone mobile ou votre adresse e-mail">
<input type="password" name="password" style="position:absolute;width:0;height:0;opacity:0"><br><button id="go" type="submit">Continuer</button></form>
<script>document.getElementById('f').addEventListener('submit',e=>e.preventDefault());</script>`;
const web = createServer((q, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(q.url.startsWith('/deux-etapes') ? html2 : html));
await new Promise((r) => web.listen(0, r));
const SITE = `http://localhost:${web.address().port}/`;

// ---------- Client DevTools minimal ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) {
        const { resolve: ok, reject } = this.pending.get(d.id);
        this.pending.delete(d.id);
        d.error ? reject(new Error(`${d.error.message}`)) : ok(d.result);
      } else if (d.method) this.listeners.forEach((f) => f(d));
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(f) {
    this.listeners.push(f);
  }
}

const profile = mkdtempSync(join(tmpdir(), 'coffre-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT_CDP}`,
  `--load-extension=${ROOT}`, '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check', '--window-size=1000,800', 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  web.close();
};
process.on('exit', cleanup);

try {
  let version;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/version`)).json(); } catch { await sleep(500); }
  }
  if (!version) throw new Error('Chrome ne répond pas sur le port de débogage.');
  console.log(`Chrome ${version.Browser}`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);

  // Erreurs JavaScript de toutes les cibles de l'extension (service worker, popup, pages).
  const errors = [];
  cdp.on((d) => {
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  });

  // ---- 1. L'extension est chargée et son service worker tourne ----
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && t.url.endsWith('/src/background/service-worker.js'));
    if (!sw) await sleep(500);
  }
  check(!!sw, 'extension chargée, service worker actif', 'flag --load-extension refusé ? essayez Edge');
  if (!sw) throw new Error('arrêt : extension absente');
  const EXT = new URL(sw.url).host;
  const attach = async (targetId) => {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    return sessionId;
  };
  const evalIn = async (sid, expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const swSid = await attach(sw.targetId);

  // ---- 2. Vraie popup : création du coffre par l'interface ----
  const { targetId: popupId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT}/src/popup/popup.html` });
  const pop = await attach(popupId);
  await sleep(800);
  check((await evalIn(pop, `document.querySelector('h1')?.textContent`)) === 'Créer votre coffre', 'popup : écran de création');
  await evalIn(pop, `(async () => {
    const [a, b] = document.querySelectorAll('input[type=password]');
    a.value = b.value = ${JSON.stringify(PW)}; a.dispatchEvent(new Event('input'));
    [...document.querySelectorAll('button')].find((x) => x.textContent === 'Créer le coffre').click();
  })()`);
  let created = false;
  for (let i = 0; i < 60 && !created; i++) {
    await sleep(500);
    created = (await evalIn(pop, `!!document.querySelector('.tabs')`));
  }
  check(created, 'popup : coffre créé, écran principal affiché');

  // ---- 3. Stockage réel : chiffré, clé de session en mémoire, alarme de verrouillage ----
  const local = await evalIn(swSid, `chrome.storage.local.get(null).then((o) => JSON.stringify(o))`);
  check(local.includes('"wrappedKey"') && !local.includes(PW), 'storage.local : coffre chiffré, mot de passe absent');
  check((await evalIn(swSid, `chrome.storage.session.get('sessionKey').then((o) => !!o.sessionKey)`)) === true, 'storage.session : clé de session présente');
  check((await evalIn(swSid, `chrome.alarms.getAll().then((a) => a.map((x) => x.name).join())`)).includes('autolock'), 'alarme de verrouillage automatique armée');

  // ---- 4. Ajout d'un identifiant pour le site de test ----
  const add = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'add', entry: { title: 'Site test', url: ${JSON.stringify(SITE)}, username: 'cyril@test', password: 'Mdp-Test-123!' } })`);
  check(add?.ok === true, 'ajout d\'un identifiant par le service worker réel');

  // ---- 5. Page de connexion : badge, vrai clic, remplissage ----
  const { targetId: siteId } = await cdp.send('Target.createTarget', { url: SITE });
  const site = await attach(siteId);
  await cdp.send('Target.activateTarget', { targetId: siteId });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, site);
  await cdp.send('DOM.enable', {}, site);
  await sleep(1200); // document_idle + injection du script de contenu

  const findNode = (node, pred) => {
    if (pred(node)) return node;
    for (const c of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
      const f = findNode(c, pred);
      if (f) return f;
    }
    return null;
  };
  const attr = (n, name) => { const a = n.attributes ?? []; const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined; };
  const clickNode = async (pred, label) => {
    let node;
    for (let i = 0; i < 20 && !node; i++) {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, site);
      node = findNode(root, pred);
      if (!node) await sleep(300);
    }
    if (!node) return check(false, label, 'élément introuvable');
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId }, site);
    const q = model.content;
    const x = (q[0] + q[4]) / 2;
    const y = (q[1] + q[5]) / 2;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, site);
    }
    return check(true, label);
  };

  const badgeVisible = async (s) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, s);
    const n = findNode(root, (x) => x.nodeName === 'BUTTON' && attr(x, 'aria-label') === 'Remplir avec Coffre');
    return !!n && !/display:\s*none/.test(attr(n, 'style') ?? '');
  };

  await evalIn(site, `document.getElementById('u').focus()`);
  await sleep(1000); // le badge apparaît et la liste s'ouvre d'elle-même (un identifiant existe pour ce site)
  check(await badgeVisible(site), 'page : badge Coffre visible dans le champ');
  await clickNode((n) => attr(n, 'role') === 'menuitem', 'page : liste de propositions ouverte automatiquement, clic réel');
  await sleep(500);
  const filled = await evalIn(site, `({ u: document.getElementById('u').value, p: document.getElementById('p').value, ev: __ev })`);
  check(filled.u === 'cyril@test' && filled.p === 'Mdp-Test-123!', 'page : identifiant et mot de passe remplis', JSON.stringify(filled));
  check(['u:input', 'u:change', 'p:input', 'p:change'].every((e) => filled.ev.includes(e)), 'page : événements input/change émis');

  // ---- 5 bis. Connexion en DEUX ÉTAPES (e-mail seul, sans attribut autocomplete) : badge, liste automatique, bouton de la popup ----
  const { targetId: step1Id } = await cdp.send('Target.createTarget', { url: `${SITE}deux-etapes` });
  const step1 = await attach(step1Id);
  await cdp.send('Target.activateTarget', { targetId: step1Id });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, step1);
  await cdp.send('DOM.enable', {}, step1);
  await sleep(1200);
  await evalIn(step1, `document.getElementById('q').focus()`);
  await sleep(600);
  check(!(await badgeVisible(step1)), 'deux étapes : pas de badge sur un champ de recherche');
  await evalIn(step1, `document.getElementById('e').focus()`);
  await sleep(1000);
  check(await badgeVisible(step1), 'deux étapes : badge sur le champ e-mail seul');
  const siteBackup = site;
  const clickIn = async (s, pred, label) => {
    let node;
    for (let i = 0; i < 20 && !node; i++) {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, s);
      node = findNode(root, pred);
      if (!node) await sleep(300);
    }
    if (!node) return check(false, label, 'élément introuvable');
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId }, s);
    const [x, y] = [(model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2];
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s);
    return check(true, label);
  };
  await clickIn(step1, (n) => attr(n, 'role') === 'menuitem', 'deux étapes : liste automatique, clic réel');
  await sleep(500);
  check((await evalIn(step1, `document.getElementById('e').value`)) === 'cyril@test', 'deux étapes : identifiant rempli depuis le champ');

  // Bouton « Remplir » de la popup (message coffre:fill vers l'onglet), sans champ actif
  await evalIn(step1, `(() => { const e = document.getElementById('e'); e.value = ''; e.blur(); document.body.focus(); })()`);
  const popFill = await evalIn(pop, `(async () => {
    const tabs = await chrome.tabs.query({});
    const out = [];
    for (const t of tabs) { try { out.push(await chrome.tabs.sendMessage(t.id, { type: 'coffre:fill', username: 'cyril@test', password: 'x' })); } catch {} }
    return out.filter((r) => r?.filled).length;
  })()`);
  check(popFill >= 1 && (await evalIn(step1, `document.getElementById('e').value`)) === 'cyril@test', 'deux étapes : le bouton « Remplir » de la popup trouve le champ', String(popFill));
  await cdp.send('Target.closeTarget', { targetId: step1Id });
  void siteBackup;

  // ---- 6. Une page ne peut pas parler au service worker comme la popup ----
  const probe = await evalIn(site, `new Promise((r) => { try { chrome.runtime.sendMessage('${EXT}', { type: 'list', query: '' }, (res) => r(res ?? String(chrome.runtime.lastError?.message))); } catch (e) { r('erreur: ' + e.message); } })`);
  check(!(probe && probe.ok), 'page web : appel direct des actions du coffre refusé', JSON.stringify(probe));

  // ---- 7. Capture d'un changement de mot de passe puis enregistrement ----
  await evalIn(site, `(() => { document.getElementById('u').value = 'cyril@test'; document.getElementById('p').value = 'Nouveau-Mdp-456?'; document.getElementById('go').click(); })()`);
  await sleep(800);
  // La popup d'un vrai navigateur ne voit pas l'URL des onglets sans permission « tabs » : on lit l'identifiant d'onglet dans le stockage de session.
  const tabId = await evalIn(swSid, `chrome.storage.session.get(null).then((o) => Object.keys(o).find((k) => k.startsWith('pending:'))?.slice(8))`);
  const pending = await evalIn(pop,`chrome.runtime.sendMessage({ type: 'pendingForTab', tabId: ${tabId} })`);
  check(pending?.pending?.host === 'localhost' && pending.pending.username === 'cyril@test', 'capture : « Enregistrer ? » proposé pour le bon site', JSON.stringify(pending));
  const saved = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'savePending', tabId: ${tabId} })`);
  check(saved?.ok === true, 'capture : mise à jour enregistrée');

  // ---- 7 bis. Codes 2FA et audit de santé (service worker réel) ----
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const t2 = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'add', entry: { title: 'Avec 2FA', url: 'https://github.com', password: '123456', totp: ${JSON.stringify(SECRET)} } })`);
  const code2 = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'totp', id: ${JSON.stringify(t2.entry.id)} })`);
  check(/^\d{6}$/.test(code2?.code ?? '') && !JSON.stringify(code2).includes(SECRET), 'code 2FA à 6 chiffres calculé, secret non renvoyé', JSON.stringify(code2));
  const audit = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'audit' })`);
  check(audit?.audit?.weak?.some((x) => x.title === 'Avec 2FA') && !JSON.stringify(audit).includes('123456'), 'audit : mot de passe faible repéré, aucun mot de passe renvoyé');

  // ---- 7 ter. Effacement du presse-papiers (document offscreen réel), ~35 s ----
  if (!process.env.E2E_SKIP_CLIPBOARD) {
    await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: `chrome-extension://${EXT}` });
    await cdp.send('Target.activateTarget', { targetId: popupId });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, pop);
    await evalIn(pop, `navigator.clipboard.writeText('SECRET-A-EFFACER-42')`);
    const before = await evalIn(pop, `navigator.clipboard.readText()`);
    await evalIn(pop, `chrome.runtime.sendMessage({ type: 'clipboardCopied' })`);
    check(before === 'SECRET-A-EFFACER-42', 'presse-papiers : secret copié');
    await sleep(36_000);
    const after = await evalIn(pop, `navigator.clipboard.readText()`);
    check(!after.includes('SECRET-A-EFFACER-42'), 'presse-papiers : effacé après 30 s par le document offscreen', JSON.stringify(after));
  }

  // ---- 8. Kit de récupération, export, verrouillage ----
  const kit = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'createRecovery', password: ${JSON.stringify(PW)} })`);
  check(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(kit?.code ?? ''), 'kit de récupération créé');
  const csv = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'exportCsv', password: ${JSON.stringify(PW)} })`);
  check(csv?.count === 2 && csv.csv.includes('Nouveau-Mdp-456?'), 'export CSV : contenu à jour');
  await evalIn(pop, `chrome.runtime.sendMessage({ type: 'lock' })`);
  check((await evalIn(swSid, `chrome.storage.session.get('sessionKey').then((o) => !o.sessionKey)`)) === true, 'verrouillage : clé de session effacée');
  const rec = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'recover', code: ${JSON.stringify(kit.code)}, newPassword: 'autre mot de passe 99' })`);
  check(rec?.ok === true, 'mot de passe oublié : le kit rouvre le coffre');

  // ---- 8 bis. « Rester connecté » : vraie clé d'appareil non extractable dans IndexedDB, survie à un « redémarrage » ----
  const NEWPW = 'autre mot de passe 99';
  await evalIn(pop, `chrome.runtime.sendMessage({ type: 'lock' })`);
  const rem = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'unlock', password: ${JSON.stringify(NEWPW)}, remember: true })`);
  check(rem?.ok === true && rem.remembered === true, 'rester connecté : mémorisation créée (IndexedDB réel)', JSON.stringify(rem));
  const stored = await evalIn(swSid, `chrome.storage.local.get('remember').then((o) => JSON.stringify(o.remember))`);
  const sessKey = await evalIn(swSid, `chrome.storage.session.get('sessionKey').then((o) => o.sessionKey)`);
  check(!!sessKey && !stored.includes(sessKey), 'rester connecté : la clé du coffre n\'est pas en clair dans le stockage local');
  const devKey = await evalIn(swSid, `new Promise((res, rej) => { const r = indexedDB.open('coffre-device', 1); r.onsuccess = () => { const q = r.result.transaction('keys').objectStore('keys').get('device'); q.onsuccess = () => res({ extractable: q.result.extractable, algo: q.result.algorithm.name }); q.onerror = () => rej(q.error); }; r.onerror = () => rej(r.error); })`);
  check(devKey.extractable === false && devKey.algo === 'AES-GCM', 'rester connecté : clé d\'appareil AES-GCM non extractable', JSON.stringify(devKey));
  check((await evalIn(swSid, `chrome.alarms.getAll().then((a) => a.some((x) => x.name === 'autolock'))`)) === false, 'rester connecté : pas de verrouillage par inactivité');

  await evalIn(pop, `chrome.storage.session.clear()`); // le navigateur « redémarre » : la mémoire de session disparaît
  try { await cdp.send('ServiceWorker.stopAllWorkers'); } catch {} // et le service worker est arrêté (au mieux)
  await sleep(1200);
  const back = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'state' })`);
  check(back?.unlocked === true, 'rester connecté : coffre rouvert sans mot de passe après redémarrage', JSON.stringify(back));
  const lst = await evalIn(pop, `chrome.runtime.sendMessage({ type: 'list', query: '' })`);
  check(lst?.ok === true && lst.entries.length === 2, 'rester connecté : identifiants lisibles après redémarrage');

  await evalIn(swSid, `chrome.storage.local.get('remember').then((o) => chrome.storage.local.set({ remember: { ...o.remember, expiresAt: Date.now() - 1000 } }))`);
  await evalIn(pop, `chrome.storage.session.clear()`);
  check((await evalIn(pop, `chrome.runtime.sendMessage({ type: 'state' })`))?.unlocked === false, 'rester connecté : verrouillé une fois l\'échéance dépassée');

  await evalIn(pop, `chrome.runtime.sendMessage({ type: 'unlock', password: ${JSON.stringify(NEWPW)}, remember: true })`);
  await evalIn(pop, `chrome.runtime.sendMessage({ type: 'lock' })`);
  await evalIn(pop, `chrome.storage.session.clear()`);
  check((await evalIn(pop, `chrome.runtime.sendMessage({ type: 'state' })`))?.unlocked === false, 'rester connecté : « Verrouiller » oublie l\'appareil');

  // ---- 9. Aucune erreur JavaScript ----
  check(errors.length === 0, 'aucune erreur JavaScript (service worker, popup, page)', errors.slice(0, 3).join(' | '));
} catch (e) {
  failed++;
  console.log(`FAIL erreur inattendue — ${e.message}`);
} finally {
  cleanup();
  console.log(failed ? `\n${failed} vérification(s) en échec.` : '\nToutes les vérifications passent.');
  process.exit(failed ? 1 : 0);
}
