import { h, icon, iconButton, toast, copyText, api, initials, download } from './ui.js';
import { hostOf, hostMatches, siteUrl } from '../core/vault.js';
import { generatePassword, estimateStrength, DEFAULTS } from '../core/generator.js';

const app = document.getElementById('app');
const S = {
  tab: 'coffre', // coffre | generateur | partage
  view: null, // null | {name:'detail', id, entry, showPw} | {name:'form', id?, prefill?} | {name:'settings'}
  entries: [],
  query: '',
  host: '',
  tabId: null,
  secureTab: false,
  pending: null,
  share: null,
  shareEntryId: '',
  shareResult: '',
  genOpts: { ...DEFAULTS },
  genPw: '',
};

try {
  Object.assign(S.genOpts, JSON.parse(localStorage.getItem('genOpts') || '{}'));
} catch {}

const mount = (...nodes) => app.replaceChildren(...nodes.filter(Boolean));

/** Enveloppe d'action : verrouillage détecté → écran de déverrouillage, sinon message d'erreur. */
const guard = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    if (e.code === 'LOCKED') return viewUnlock();
    toast(e.message, true);
  }
};

// ---------- Démarrage ----------

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    S.tabId = tab?.id ?? null;
    const u = new URL(tab?.url || '');
    if (/^https?:$/.test(u.protocol)) S.host = hostOf(u.hostname);
    S.secureTab = u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {}
  const st = await api({ type: 'state' });
  if (!st.exists) return viewCreate();
  if (!st.unlocked) return viewUnlock();
  return enter();
}

async function enter() {
  S.view = null;
  S.entries = (await api({ type: 'list', query: '' })).entries;
  S.pending = null;
  if (S.tabId != null) {
    try {
      S.pending = (await api({ type: 'pendingForTab', tabId: S.tabId })).pending;
    } catch {}
  }
  renderMain();
}

// ---------- Création et déverrouillage ----------

function strengthMeter() {
  const fill = h('div', { class: 'meter-fill' });
  const label = h('span', { class: 'sub' });
  const el = h('div', { class: 'meter' }, h('div', { class: 'meter-track' }, fill), label);
  el.update = (pw) => {
    const s = estimateStrength(pw);
    fill.style.width = `${s.score * 25}%`;
    fill.dataset.score = s.score;
    label.textContent = pw ? `${s.label} · ${s.bits} bits` : '';
  };
  return el;
}

function viewCreate() {
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe maître (10 caractères minimum)', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'input', type: 'password', placeholder: 'Confirmer le mot de passe maître', autocomplete: 'new-password' });
  const meter = strengthMeter();
  const err = h('p', { class: 'error' });
  pw.addEventListener('input', () => meter.update(pw.value));
  const submit = async () => {
    err.textContent = '';
    if (pw.value !== pw2.value) return void (err.textContent = 'Les deux mots de passe sont différents.');
    btn.disabled = true;
    btn.textContent = 'Création…';
    try {
      await api({ type: 'create', password: pw.value });
      await enter();
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Créer le coffre';
    }
  };
  const btn = h('button', { class: 'btn primary block', onclick: submit }, 'Créer le coffre');
  pw2.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  mount(h('div', { class: 'center' },
    icon('lock', 28),
    h('h1', {}, 'Créer votre coffre'),
    h('p', { class: 'sub' }, "Ce mot de passe protège tout le reste. Il n'existe aucun moyen de le récupérer : si vous l'oubliez, le contenu du coffre est perdu."),
    pw, meter, pw2, err, btn,
    h('button', { class: 'btn block', onclick: viewJoin }, "J'ai déjà un coffre sur un autre appareil"),
    restoreButton(err)));
  pw.focus();
}

function viewUnlock() {
  Object.assign(S, { view: null, entries: [], pending: null, share: null, shareResult: '', genPw: '' }); // rien ne reste en mémoire une fois verrouillé
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe maître', autocomplete: 'current-password' });
  const err = h('p', { class: 'error' });
  const submit = async () => {
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Déverrouillage…';
    try {
      await api({ type: 'unlock', password: pw.value });
      await enter();
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Déverrouiller';
      pw.select();
    }
  };
  const btn = h('button', { class: 'btn primary block', onclick: submit }, 'Déverrouiller');
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  mount(h('div', { class: 'center' }, icon('lock', 28), h('h1', {}, 'Coffre verrouillé'), pw, err, btn,
    h('button', { class: 'btn block', onclick: viewRecover }, 'Mot de passe oublié ?')));
  pw.focus();
}

/** Mot de passe maître oublié : le kit de récupération rouvre le coffre, puis on choisit un nouveau mot de passe. */
function viewRecover() {
  const code = h('input', { class: 'input mono', placeholder: 'Code de récupération (XXXX-XXXX-…)', autocomplete: 'off', spellcheck: false });
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Nouveau mot de passe maître', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'input', type: 'password', placeholder: 'Confirmer le nouveau mot de passe', autocomplete: 'new-password' });
  const err = h('p', { class: 'error' });
  const submit = async () => {
    err.textContent = '';
    if (pw.value !== pw2.value) return void (err.textContent = 'Les deux mots de passe sont différents.');
    btn.disabled = true;
    btn.textContent = 'Récupération…';
    try {
      await api({ type: 'recover', code: code.value, newPassword: pw.value });
      toast('Mot de passe maître remplacé');
      await enter();
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Récupérer mon coffre';
    }
  };
  const btn = h('button', { class: 'btn primary block', onclick: submit }, 'Récupérer mon coffre');
  pw2.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  mount(h('div', { class: 'center' }, icon('key', 28), h('h1', {}, 'Kit de récupération'),
    h('p', { class: 'sub' }, "Saisissez le code de 32 caractères noté lors de la création du kit, puis choisissez un nouveau mot de passe maître. Sans kit, le coffre ne peut pas être rouvert."),
    code, pw, pw2, err, btn, h('button', { class: 'btn block', onclick: viewUnlock }, 'Retour')));
  code.focus();
}

/** Appareil neuf : restaure un fichier de sauvegarde chiffré, qu'on déverrouille ensuite avec son mot de passe maître. */
function restoreButton(err) {
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      await api({ type: 'restoreBackup', json: await f.text() });
      toast('Sauvegarde restaurée : saisissez votre mot de passe maître');
      viewUnlock();
    } catch (e) {
      err.textContent = e.message;
    }
  });
  return h('div', {}, file, h('button', { class: 'btn block', onclick: () => file.click() }, 'Restaurer une sauvegarde'));
}

// ---------- Cadre principal ----------

function renderMain() {
  const head = h('header', {},
    S.view ? iconButton('back', 'Retour', () => { S.view = null; renderMain(); }) : null,
    h('span', { class: 'title' }, S.view ? viewTitle() : 'Coffre'),
    S.view ? null : iconButton('gear', 'Réglages', () => { S.view = { name: 'settings' }; renderMain(); }),
    iconButton('lock', 'Verrouiller', guard(async () => { await api({ type: 'lock' }); viewUnlock(); })));
  const parts = [head];
  if (!S.view) {
    const tabs = [['coffre', 'Coffre'], ['generateur', 'Générateur'], ['partage', 'Partage']];
    parts.push(h('nav', { class: 'tabs' }, tabs.map(([id, label]) =>
      h('button', { class: `tab${S.tab === id ? ' on' : ''}`, onclick: () => { S.tab = id; renderMain(); } }, label))));
  }
  const body = h('div', { class: 'body' });
  parts.push(body);
  mount(...parts);
  if (S.view?.name === 'detail') viewDetail(body);
  else if (S.view?.name === 'form') viewForm(body);
  else if (S.view?.name === 'settings') viewSettings(body);
  else if (S.tab === 'coffre') tabCoffre(body);
  else if (S.tab === 'generateur') tabGenerateur(body);
  else tabPartage(body);
}

const viewTitle = () => ({ detail: S.view.entry?.title || 'Identifiant', form: S.view.id ? 'Modifier' : 'Nouvel identifiant', settings: 'Réglages' })[S.view.name];

// ---------- Onglet Coffre ----------

const forSite = () => (S.host ? S.entries.filter((e) => hostMatches(hostOf(e.url), S.host)) : []);

function tabCoffre(body) {
  if (S.pending) body.append(pendingBanner());
  const list = h('div');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher un identifiant', value: S.query });
  search.addEventListener('input', () => { S.query = search.value; renderList(list); });
  body.append(search, list,
    h('button', { class: 'btn block', onclick: () => { S.view = { name: 'form', prefill: { url: S.host, title: S.host } }; renderMain(); } },
      icon('plus'), ' Ajouter un identifiant'));
  renderList(list);
}

function pendingBanner() {
  const p = S.pending;
  const done = () => { S.pending = null; renderMain(); };
  return h('div', { class: 'banner' },
    h('p', {}, p.existingId ? `Mettre à jour le mot de passe de ${p.username || 'ce compte'} sur ${p.host} ?` : `Enregistrer ${p.username ? `${p.username} sur ` : 'le mot de passe de '}${p.host} ?`),
    h('div', { class: 'inline' },
      h('button', { class: 'btn primary small', onclick: guard(async () => {
        await api({ type: 'savePending', tabId: S.tabId });
        S.entries = (await api({ type: 'list', query: '' })).entries;
        toast(p.existingId ? 'Mot de passe mis à jour' : 'Identifiant enregistré');
        done();
      }) }, p.existingId ? 'Mettre à jour' : 'Enregistrer'),
      h('button', { class: 'btn small', onclick: guard(async () => { await api({ type: 'dismissPending', tabId: S.tabId }); done(); }) }, 'Ignorer')));
}

function entryRow(e, { fillBtn = false, first = false } = {}) {
  return h('div', { class: `row${first ? ' first' : ''}` },
    h('div', { class: 'av' }, initials(e.title)),
    h('div', { class: 'info', onclick: guard(() => openDetail(e.id)) },
      h('div', { class: 't' }, e.title),
      h('div', { class: 'sub' }, e.username || '(sans identifiant)'),
      e.source ? h('div', { class: 'sub' }, `Partagé par ${e.source.sharedBy.slice(0, 8).toUpperCase().match(/.{4}/g).join(' ')}`) : null),
    fillBtn
      ? h('button', { class: 'btn small', onclick: guard(() => fillEntry(e.id)) }, 'Remplir')
      : [siteUrl(e.url) ? iconButton('external', 'Ouvrir le site', () => openSite(e.url)) : null,
         iconButton('user', "Copier l'identifiant", () => copyText(e.username, 'Identifiant copié')),
         iconButton('key', 'Copier le mot de passe', guard(async () => copyText((await api({ type: 'reveal', id: e.id })).entry.password, 'Mot de passe copié')))]);
}

function renderList(list) {
  const q = S.query.trim().toLowerCase();
  const nodes = [];
  if (!S.entries.length) {
    nodes.push(h('div', { class: 'empty' }, h('p', {}, 'Votre coffre est vide.'), h('p', { class: 'sub' }, 'Ajoutez un premier identifiant, ou connectez-vous à un site : Coffre proposera de l’enregistrer.')));
  } else if (q) {
    const found = S.entries.filter((e) => [e.title, e.url, e.username].some((f) => f.toLowerCase().includes(q)));
    nodes.push(h('h2', {}, `Résultats (${found.length})`), ...found.map((e, i) => entryRow(e, { first: i === 0 })));
  } else {
    const here = forSite();
    const ids = new Set(here.map((e) => e.id));
    const others = S.entries.filter((e) => !ids.has(e.id));
    if (here.length) nodes.push(h('h2', {}, 'Pour ce site'), ...here.map((e, i) => entryRow(e, { fillBtn: true, first: i === 0 })));
    if (others.length) nodes.push(h('h2', {}, 'Tous les identifiants'), ...others.map((e, i) => entryRow(e, { first: i === 0 })));
  }
  list.replaceChildren(...nodes);
}

function openSite(url) {
  const target = siteUrl(url);
  if (!target) return toast('Adresse du site invalide.', true);
  chrome.tabs.create({ url: target });
  window.close();
}

async function fillEntry(id) {
  if (!S.secureTab) return toast('Remplissage refusé : la page n’est pas en HTTPS.', true);
  const { entry } = await api({ type: 'reveal', id });
  try {
    const res = await chrome.tabs.sendMessage(S.tabId, { type: 'coffre:fill', username: entry.username, password: entry.password });
    if (res?.filled) return window.close();
    toast('Aucun champ de connexion trouvé sur cette page.', true);
  } catch {
    toast('Rechargez la page, puis réessayez.', true);
  }
}

// ---------- Fiche et formulaire ----------

async function openDetail(id) {
  const { entry } = await api({ type: 'reveal', id });
  S.view = { name: 'detail', id, entry, showPw: false };
  renderMain();
}

function viewDetail(body) {
  const { entry: e, showPw } = S.view;
  const kv = (k, v, ...extra) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), extra);
  const confirmBtn = h('button', { class: 'btn danger', onclick: guard(async () => {
    if (confirmBtn.dataset.sure !== '1') {
      confirmBtn.dataset.sure = '1';
      confirmBtn.textContent = 'Confirmer la suppression';
      return;
    }
    await api({ type: 'remove', id: e.id });
    S.entries = (await api({ type: 'list', query: '' })).entries;
    S.view = null;
    toast('Identifiant supprimé');
    renderMain();
  }) }, icon('trash'), ' Supprimer');
  body.append(...[
    kv('Identifiant', e.username || '—', e.username ? iconButton('copy', 'Copier', () => copyText(e.username, 'Identifiant copié')) : null),
    kv('Mot de passe', h('span', { class: 'mono' }, showPw ? e.password : '••••••••••••'),
      iconButton(showPw ? 'eyeOff' : 'eye', showPw ? 'Masquer' : 'Afficher', () => { S.view.showPw = !showPw; renderMain(); }),
      iconButton('copy', 'Copier', () => copyText(e.password, 'Mot de passe copié'))),
    kv('Adresse', e.url || '—', siteUrl(e.url) ? iconButton('external', 'Ouvrir le site', () => openSite(e.url)) : null),
    e.notes ? kv('Notes', e.notes) : null,
    e.history?.length ? kv('Historique', `${e.history.length} ancien${e.history.length > 1 ? 's' : ''} mot${e.history.length > 1 ? 's' : ''} de passe`) : null,
    e.source ? kv('Partagé par', h('span', { class: 'mono' }, e.source.sharedBy.slice(0, 32).toUpperCase().match(/.{4}/g).join(' '))) : null,
    h('div', { class: 'actions' },
      siteUrl(e.url) ? h('button', { class: 'btn primary', onclick: () => openSite(e.url) }, icon('external'), ' Ouvrir le site') : null,
      h('button', { class: 'btn', onclick: () => { S.view = { name: 'form', id: e.id, prefill: e }; renderMain(); } }, icon('edit'), ' Modifier'),
      h('button', { class: 'btn', onclick: () => { S.shareEntryId = e.id; S.shareResult = ''; S.view = null; S.tab = 'partage'; renderMain(); } }, icon('share'), ' Partager'),
      confirmBtn),
  ].filter(Boolean));
}

function viewForm(body) {
  const { id, prefill = {} } = S.view;
  const f = {
    title: h('input', { class: 'input', value: prefill.title || '' }),
    url: h('input', { class: 'input', value: prefill.url || '', placeholder: 'exemple.fr', autocapitalize: 'off' }),
    username: h('input', { class: 'input', value: prefill.username || '', autocomplete: 'off', autocapitalize: 'off' }),
    password: h('input', { class: 'input', type: 'password', value: prefill.password || '', autocomplete: 'off' }),
    notes: h('textarea', { value: prefill.notes || '' }),
  };
  const meter = strengthMeter();
  meter.update(f.password.value);
  f.password.addEventListener('input', () => meter.update(f.password.value));
  const err = h('p', { class: 'error' });
  const field = (label, ...nodes) => h('div', { class: 'field' }, h('label', {}, label), ...nodes);
  body.append(
    field('Titre', f.title),
    field('Adresse du site', f.url),
    field('Identifiant', f.username),
    field('Mot de passe',
      h('div', { class: 'inline' }, f.password,
        iconButton('eye', 'Afficher ou masquer', () => { f.password.type = f.password.type === 'password' ? 'text' : 'password'; }),
        iconButton('refresh', 'Générer', () => { f.password.value = generatePassword(S.genOpts); f.password.type = 'text'; meter.update(f.password.value); })),
      meter),
    field('Notes', f.notes),
    err,
    h('button', { class: 'btn primary block', onclick: guard(async () => {
      err.textContent = '';
      const data = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      try {
        await api(id ? { type: 'update', id, patch: data } : { type: 'add', entry: data });
      } catch (e) {
        if (e.code === 'LOCKED') throw e;
        return void (err.textContent = e.message);
      }
      S.entries = (await api({ type: 'list', query: '' })).entries;
      S.view = null;
      toast(id ? 'Modifications enregistrées' : 'Identifiant ajouté');
      renderMain();
    }) }, 'Enregistrer'));
  (prefill.title ? f.username : f.title).focus();
}

// ---------- Onglet Générateur ----------

function tabGenerateur(body) {
  const o = S.genOpts;
  const out = h('span', { class: 'mono' });
  const meter = strengthMeter();
  const lenOut = h('span', {}, String(o.length));
  const regen = () => {
    try {
      S.genPw = generatePassword(o);
      out.textContent = S.genPw;
      meter.update(S.genPw);
    } catch (e) {
      toast(e.message, true);
    }
    try { localStorage.setItem('genOpts', JSON.stringify(o)); } catch {}
  };
  const check = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!o[key], onchange: (e) => {
    o[key] = e.target.checked;
    if (!['lower', 'upper', 'digits', 'symbols'].some((k) => o[k])) { o[key] = true; e.target.checked = true; toast('Gardez au moins un type de caractères.', true); }
    regen();
  } }), label);
  body.append(
    h('div', { class: 'pw' }, out, iconButton('refresh', 'Regénérer', regen), iconButton('copy', 'Copier', () => copyText(S.genPw, 'Mot de passe copié'))),
    meter,
    h('div', { class: 'range' }, h('span', { class: 'sub' }, 'Longueur'),
      h('input', { type: 'range', min: 8, max: 64, step: 1, value: o.length, oninput: (e) => { o.length = Number(e.target.value); lenOut.textContent = o.length; regen(); } }), lenOut),
    check('lower', 'Minuscules (a-z)'), check('upper', 'Majuscules (A-Z)'), check('digits', 'Chiffres (0-9)'), check('symbols', 'Symboles (!@#…)'),
    check('excludeAmbiguous', 'Éviter les caractères ambigus (l, 1, O, 0)'),
    h('button', { class: 'btn primary block', onclick: () => { S.view = { name: 'form', prefill: { url: S.host, title: S.host, password: S.genPw } }; S.tab = 'coffre'; renderMain(); } }, 'Utiliser ce mot de passe'));
  regen();
}

// ---------- Onglet Partage ----------

function tabPartage(body) {
  if (!S.share) {
    body.append(h('p', { class: 'sub' }, 'Chargement…'));
    api({ type: 'myShareInfo' }).then((r) => { S.share = r; renderMain(); }).catch(guard(async (e) => { throw e; }));
    return;
  }
  const recipient = h('textarea', { class: 'code', placeholder: 'Collez le code de votre contact (coffre-pub:1:…)', rows: 2 });
  const pick = h('select', {}, S.entries.map((e) => h('option', { value: e.id, selected: e.id === S.shareEntryId }, e.title)));
  const ttl = h('select', {}, [[1, '1 heure'], [24, '24 heures'], [72, '72 heures'], [168, '7 jours']].map(([v, l]) => h('option', { value: v, selected: v === 72 }, `Valable ${l}`)));
  const result = h('textarea', { class: 'code', readOnly: true, rows: 3, value: S.shareResult, hidden: !S.shareResult });
  const copyResult = h('button', { class: 'btn small', hidden: !S.shareResult, onclick: () => copyText(result.value, 'Code de partage copié') }, 'Copier le code');
  const incoming = h('textarea', { class: 'code', placeholder: 'Collez le code reçu (coffre-share:1:…)', rows: 2 });
  const info = h('p', { class: 'sub' });
  body.append(
    h('h2', { style: 'margin-top:0' }, 'Votre code de partage'),
    h('div', { class: 'pw' }, h('span', { class: 'mono', style: 'font-size:11px' }, S.share.code), iconButton('copy', 'Copier', () => copyText(S.share.code, 'Code copié'))),
    h('p', { class: 'sub', style: 'margin-top:6px' }, 'Empreinte : ', h('span', { class: 'mono' }, S.share.fingerprint), h('br'), 'Lisez-la à voix haute à votre contact pour vérifier que le code est bien le vôtre.'),
    h('h2', {}, 'Envoyer un identifiant'),
    S.entries.length ? h('div', {}, h('div', { class: 'field' }, pick), h('div', { class: 'field' }, recipient),
      h('div', { class: 'inline' }, ttl, h('button', { class: 'btn', onclick: guard(async () => {
        const { code } = await api({ type: 'shareEntry', id: pick.value, recipientCode: recipient.value.trim(), ttlHours: Number(ttl.value) });
        S.shareEntryId = pick.value;
        S.shareResult = code;
        result.value = code;
        result.hidden = false;
        copyResult.hidden = false;
        toast('Code de partage créé');
      }) }, 'Créer le code')),
      h('div', { class: 'field', style: 'margin-top:8px' }, result), copyResult,
      h('p', { class: 'sub', style: 'margin-top:6px' }, 'Seul le destinataire peut ouvrir ce code. Envoyez-le par le canal de votre choix.'))
      : h('p', { class: 'sub' }, 'Ajoutez d’abord un identifiant dans le coffre.'),
    h('h2', {}, 'Recevoir un identifiant'),
    h('div', { class: 'field' }, incoming),
    h('button', { class: 'btn', onclick: guard(async () => {
      const res = await api({ type: 'importShare', code: incoming.value.trim() });
      S.entries = (await api({ type: 'list', query: '' })).entries;
      incoming.value = '';
      info.textContent = `« ${res.entry.title} » ajouté. Expéditeur : ${res.senderFingerprint}. Vérifiez cette empreinte avec lui.`;
      toast('Identifiant importé');
    }) }, 'Importer'),
    info);
}

// ---------- Synchronisation ----------

const TOKEN_HELP = 'Sur github.com : créez un dépôt PRIVÉ vide, puis Settings → Developer settings → Fine-grained tokens → Generate. Limitez-le à ce seul dépôt, permission « Contents : Read and write ». Le coffre y est stocké chiffré ; sans votre mot de passe maître, le fichier est illisible.';

function syncFields() {
  const repo = h('input', { class: 'input', placeholder: 'compte/nom-du-dépôt', autocomplete: 'off', spellcheck: false });
  const token = h('input', { class: 'input', type: 'password', placeholder: 'Jeton GitHub (github_pat_…)', autocomplete: 'off' });
  return { repo, token, nodes: [h('div', { class: 'field' }, repo), h('div', { class: 'field' }, token), h('p', { class: 'sub' }, TOKEN_HELP)] };
}

const when = (t) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

async function syncSection() {
  let st;
  try {
    st = await api({ type: 'syncStatus' });
  } catch (e) {
    return h('p', { class: 'error' }, e.message);
  }
  const err = h('p', { class: 'error' });
  if (st.configured) {
    const info = h('p', { class: 'sub' },
      `Synchronisé avec ${st.repo}. `,
      st.last ? (st.last.ok ? `Dernière synchro : ${when(st.last.at)}.` : `Dernier essai (${when(st.last.at)}) en échec : ${st.last.error}`) : 'Pas encore synchronisé.');
    const now = h('button', { class: 'btn', onclick: async () => {
      err.textContent = '';
      now.disabled = true;
      try {
        await api({ type: 'syncNow' });
        S.entries = (await api({ type: 'list', query: '' })).entries;
        toast('Synchronisé');
      } catch (e) {
        err.textContent = e.message;
      }
      renderMain();
    } }, icon('refresh'), ' Synchroniser maintenant');
    const off = h('button', { class: 'btn', onclick: guard(async () => {
      await api({ type: 'syncDisable' });
      toast('Synchronisation désactivée');
      renderMain();
    }) }, 'Désactiver');
    return h('div', {}, info, err, h('div', { class: 'actions' }, now, off));
  }
  const f = syncFields();
  const go = h('button', { class: 'btn', onclick: async () => {
    err.textContent = '';
    go.disabled = true;
    go.textContent = 'Connexion…';
    try {
      await api({ type: 'syncSetup', repo: f.repo.value.trim(), token: f.token.value });
      S.entries = (await api({ type: 'list', query: '' })).entries;
      toast('Synchronisation activée');
    } catch (e) {
      err.textContent = e.message;
    }
    renderMain();
  } }, 'Activer la synchronisation');
  return h('div', {}, h('p', { class: 'sub' }, 'Retrouvez votre coffre sur le téléphone et sur un autre ordinateur.'), ...f.nodes, err, go);
}

function viewJoin() {
  const f = syncFields();
  const err = h('p', { class: 'error' });
  const go = h('button', { class: 'btn primary block', onclick: async () => {
    err.textContent = '';
    go.disabled = true;
    go.textContent = 'Téléchargement…';
    try {
      await api({ type: 'syncJoin', repo: f.repo.value.trim(), token: f.token.value });
      viewUnlock();
    } catch (e) {
      err.textContent = e.message;
      go.disabled = false;
      go.textContent = 'Récupérer mon coffre';
    }
  } }, 'Récupérer mon coffre');
  mount(h('div', { class: 'center' },
    icon('refresh', 28),
    h('h1', {}, 'Récupérer un coffre'),
    h('p', { class: 'sub' }, "Saisissez le dépôt et le jeton déjà utilisés sur votre autre appareil. Vous déverrouillerez ensuite le coffre avec votre mot de passe maître habituel."),
    ...f.nodes, err, go,
    h('button', { class: 'btn block', onclick: viewCreate }, 'Retour')));
  f.repo.focus();
}

// ---------- Sauvegarde et récupération ----------

async function backupSection() {
  let has;
  try {
    has = (await api({ type: 'recoveryStatus' })).has;
  } catch (e) {
    return h('p', { class: 'error' }, e.message);
  }

  // Sauvegarde chiffrée : le fichier est inutilisable sans le mot de passe maître.
  const backup = h('button', { class: 'btn', onclick: guard(async () => {
    const r = await api({ type: 'exportBackup' });
    download(r.filename, r.json, 'application/json');
    toast('Sauvegarde téléchargée');
  }) }, 'Télécharger une sauvegarde chiffrée');

  // Export CSV : en clair, donc protégé par le mot de passe maître.
  const csvPw = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe maître', autocomplete: 'current-password' });
  const csvErr = h('p', { class: 'error' });
  const csv = h('button', { class: 'btn', onclick: async () => {
    csvErr.textContent = '';
    try {
      const r = await api({ type: 'exportCsv', password: csvPw.value });
      download(r.filename, r.csv, 'text/csv');
      csvPw.value = '';
      toast(`${r.count} identifiants exportés : supprimez le fichier après usage`);
    } catch (e) {
      csvErr.textContent = e.code === 'WRONG_PASSWORD' ? 'Mot de passe maître incorrect.' : e.message;
    }
  } }, 'Exporter en CSV (non chiffré)');

  // Kit de récupération : le code n'est affiché qu'une fois, ici.
  const kitPw = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe maître', autocomplete: 'current-password' });
  const kitErr = h('p', { class: 'error' });
  const kitBox = h('div', {});
  const showKit = (code) => {
    const text = `Kit de récupération Coffre\r\nCréé le ${new Date().toLocaleDateString('fr-FR')}\r\n\r\nCode : ${code}\r\n\r\nCe code rouvre votre coffre si vous oubliez le mot de passe maître.\r\nConservez-le HORS de cet ordinateur (papier, coffre physique). Ne le partagez avec personne.\r\nUn nouveau kit remplace celui-ci.\r\n`;
    kitBox.replaceChildren(
      h('p', { class: 'sub' }, 'Notez ce code maintenant : il ne sera plus jamais affiché.'),
      h('p', { class: 'mono kitcode' }, code),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => copyText(code, 'Code copié') }, icon('copy'), ' Copier'),
        h('button', { class: 'btn', onclick: () => download('coffre-kit-recuperation.txt', text) }, 'Télécharger (.txt)')));
  };
  const kit = h('button', { class: 'btn', onclick: async () => {
    kitErr.textContent = '';
    try {
      const r = await api({ type: 'createRecovery', password: kitPw.value });
      kitPw.value = '';
      kit.textContent = 'Remplacer le kit';
      showKit(r.code);
    } catch (e) {
      kitErr.textContent = e.code === 'WRONG_PASSWORD' ? 'Mot de passe maître incorrect.' : e.message;
    }
  } }, has ? 'Remplacer le kit' : 'Créer un kit de récupération');

  return h('div', {},
    h('p', { class: 'sub' }, 'Une sauvegarde est le coffre chiffré : sans votre mot de passe maître, elle est inutilisable.'),
    backup,
    h('h2', {}, 'Exporter en CSV'),
    h('p', { class: 'sub' }, 'Le fichier contient vos mots de passe EN CLAIR. Supprimez-le dès que vous avez fini.'),
    h('div', { class: 'field' }, csvPw), csvErr, csv,
    h('h2', {}, 'Kit de récupération'),
    h('p', { class: 'sub' }, has
      ? 'Un kit existe : son code rouvre le coffre si le mot de passe maître est oublié.'
      : "Aucun kit : si vous oubliez le mot de passe maître, le contenu du coffre est perdu. Créez un kit et notez le code hors de l'ordinateur."),
    h('div', { class: 'field' }, kitPw), kitErr, kit, kitBox);
}

// ---------- Réglages ----------

async function viewSettings(body) {
  const { settings } = await api({ type: 'getSettings' });
  const lockSel = h('select', {}, [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure'], [0, 'Jamais']].map(([v, l]) =>
    h('option', { value: v, selected: v === settings.autoLockMinutes }, l)));
  lockSel.addEventListener('change', guard(async () => { await api({ type: 'setSettings', settings: { autoLockMinutes: Number(lockSel.value) } }); toast('Réglage enregistré'); }));
  const cur = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe maître actuel', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', placeholder: 'Nouveau mot de passe maître', autocomplete: 'new-password' });
  const next2 = h('input', { class: 'input', type: 'password', placeholder: 'Confirmer le nouveau mot de passe', autocomplete: 'new-password' });
  const err = h('p', { class: 'error' });
  body.append(...[
    h('div', { class: 'field' }, h('label', {}, 'Verrouillage automatique après'), lockSel),
    h('h2', {}, 'Synchronisation'),
    await syncSection(),
    h('h2', {}, 'Sauvegarde et récupération'),
    await backupSection(),
    window.COFFRE_APP ? null : h('h2', {}, 'Importer'),
    window.COFFRE_APP ? null : h('button', { class: 'btn', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('src/import/import.html') }) }, 'Importer depuis Dashlane, Bitwarden, Chrome…'),
    h('h2', {}, 'Changer le mot de passe maître'),
    h('div', { class: 'field' }, cur), h('div', { class: 'field' }, next), h('div', { class: 'field' }, next2), err,
    h('button', { class: 'btn', onclick: async () => {
      err.textContent = '';
      if (next.value !== next2.value) return void (err.textContent = 'Les deux nouveaux mots de passe sont différents.');
      try {
        await api({ type: 'changeMasterPassword', current: cur.value, next: next.value });
        cur.value = next.value = next2.value = '';
        toast('Mot de passe maître modifié');
      } catch (e) {
        err.textContent = e.code === 'WRONG_PASSWORD' ? 'Le mot de passe actuel est incorrect.' : e.message;
      }
    } }, 'Modifier')].filter(Boolean));
}

init().catch((e) => mount(h('div', { class: 'center' }, h('h1', {}, 'Coffre indisponible'), h('p', { class: 'error' }, e.message))));
