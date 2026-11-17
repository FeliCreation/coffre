// Script de contenu : détecte les champs de connexion, propose le remplissage et repère les
// identifiants saisis pour proposer de les enregistrer. Jamais de remplissage silencieux :
// il faut un clic réel (event.isTrusted) de l'utilisateur. Aucun secret n'est gardé ici.
(() => {
  'use strict';
  if (window.top !== window) return;

  // ---------- Détection des champs ----------

  const visible = (el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password';
  const isTextish = (el) => el instanceof HTMLInputElement && /^(text|email|tel)$/.test(el.type) && !el.readOnly;
  const ac = (el) => (el.getAttribute('autocomplete') || '').toLowerCase();

  /** Champs identifiant + mot de passe qui vont ensemble, à partir d'un champ de départ (ou de la page). */
  function loginFields(from) {
    const scope = from?.form || document;
    const inputs = [...scope.querySelectorAll('input')].filter(visible);
    let pass;
    let user;
    if (from && isPassword(from)) {
      pass = from;
    } else if (from && isTextish(from)) {
      user = from;
      const after = inputs.slice(inputs.indexOf(from) + 1);
      pass = after.find(isPassword);
    } else {
      pass = inputs.find((i) => isPassword(i) && ac(i) !== 'new-password') || inputs.find(isPassword);
    }
    if (pass && !user) {
      const before = inputs.slice(0, inputs.indexOf(pass)).filter(isTextish);
      user = before[before.length - 1];
    }
    // Connexion en deux étapes : seul l'identifiant est visible. On prend le premier champ qui y ressemble.
    if (!pass && !user) user = inputs.find((i) => isTextish(i) && (/username|email/.test(ac(i)) || (looksLikeIdentifier(i) && !isSignupScope(i))));
    return { user, pass };
  }

  const IDENT_WORDS = /e-?mail|courriel|user(name)?|login|identifiant|account|compte|phone|mobile|t[ée]l([ée]phone)?|pseudo|member|membre/i;
  // Mots qui écartent un champ (recherche, adresse postale, carte…). « adresse e-mail » doit rester accepté : pas de « adresse » seul.
  const OTHER_WORDS = /search|recherche|query|captcha|coupon|promo|postal|zip|city|ville|street|rue|first.?name|last.?name|pr[ée]nom|card|iban|otp|code/i;

  /** Le champ ressemble-t-il à un identifiant de connexion (e-mail, nom d'utilisateur, téléphone) ? Sert aux connexions en deux étapes. */
  function looksLikeIdentifier(el) {
    if (el.type === 'search' || /^(searchbox|combobox)$/.test(el.getAttribute('role') || '')) return false;
    const a = ac(el);
    if (/username|email|tel/.test(a)) return true;
    if (/new-password|one-time-code|cc-|address|postal|given-name|family-name/.test(a)) return false;
    const hay = [el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ');
    if (OTHER_WORDS.test(hay)) return false;
    return el.type === 'email' || IDENT_WORDS.test(hay);
  }

  /** Page de création de compte ? (mot de passe « nouveau » ou confirmation de mot de passe) */
  function isSignupScope(el) {
    const pw = [...(el.form || document).querySelectorAll('input[type="password"]')].filter(visible);
    return pw.length > 1 || pw.some((p) => ac(p) === 'new-password');
  }

  /** Le champ doit-il recevoir le badge ? (connexion existante, pas création de compte) */
  function isCandidate(el) {
    if (!(el instanceof HTMLInputElement) || !visible(el)) return false;
    if (isPassword(el)) return ac(el) !== 'new-password';
    if (!isTextish(el)) return false;
    const f = loginFields(el);
    if (f.pass) return ac(f.pass) !== 'new-password';
    // Connexion en deux étapes (identifiant d'abord, mot de passe ensuite) : pas de champ mot de passe visible ici.
    return looksLikeIdentifier(el) && !isSignupScope(el);
  }

  // ---------- Remplissage ----------

  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); // contourne le suivi de valeur de React
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fill(fields, { username, password }) {
    let n = 0;
    if (fields.user && username) (setValue(fields.user, username), n++);
    if (fields.pass && password) (setValue(fields.pass, password), n++);
    return n;
  }

  const send = async (msg) => {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return { ok: false, error: "L'extension a été rechargée. Rechargez la page." };
    }
  };

  // ---------- Interface dans la page (shadow DOM fermé, style hors CSP de la page) ----------

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    .badge{position:fixed;width:22px;height:22px;border:0;border-radius:6px;background:#dbe7ff;color:#1d4ed8;
      display:none;align-items:center;justify-content:center;cursor:pointer;padding:0}
    .badge:hover{background:#c3d6ff}
    .menu{position:fixed;display:none;background:#fff;color:#1a1a1a;border:1px solid #d4d4d8;border-radius:8px;
      padding:4px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
    .item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer}
    .item:hover,.item.hl{background:#eef3ff}
    .av{width:24px;height:24px;border-radius:6px;background:#dbe7ff;color:#1d4ed8;font-size:11px;font-weight:600;
      display:flex;align-items:center;justify-content:center;flex:none}
    .t{font-weight:600}.s{font-size:12px;color:#5f5f66}
    .msg{padding:8px;color:#5f5f66;line-height:1.4}
    @media (prefers-color-scheme:dark){
      .menu{background:#26262b;color:#f2f2f3;border-color:#44444c}.item:hover,.item.hl{background:#34343c}
      .badge,.av{background:#2f3f66;color:#bcd0ff}.badge:hover{background:#3a4d7d}.s,.msg{color:#a8a8b0}}
  `;

  let host;
  let badge;
  let menu;
  let target = null; // champ actuellement accompagné du badge

  function svgKey() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    const c = document.createElementNS(ns, 'circle');
    for (const [k, v] of Object.entries({ cx: 8, cy: 15, r: 4 })) c.setAttribute(k, v);
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M11 12l9-9M16 7l3 3');
    svg.append(c, p);
    return svg;
  }

  function ensureUi() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];

    badge = document.createElement('button');
    badge.className = 'badge';
    badge.type = 'button';
    badge.setAttribute('aria-label', 'Remplir avec Coffre');
    badge.append(svgKey());
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    root.append(badge, menu);

    // Garde le focus dans le champ de la page pendant les clics sur nos éléments.
    for (const el of [badge, menu]) el.addEventListener('mousedown', (e) => e.preventDefault());
    badge.addEventListener('click', (e) => {
      if (e.isTrusted) toggleMenu();
    });
    document.documentElement.append(host);
  }

  function place() {
    if (!target || !host) return;
    const r = target.getBoundingClientRect();
    badge.style.left = `${Math.max(0, r.right - 28)}px`;
    badge.style.top = `${r.top + (r.height - 22) / 2}px`;
    menu.style.left = `${Math.max(4, r.left)}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.width = `${Math.max(r.width, 260)}px`;
  }

  function show(el) {
    ensureUi();
    target = el;
    badge.style.display = 'flex';
    closeMenu();
    place();
  }

  function hide() {
    target = null;
    if (host) {
      badge.style.display = 'none';
      closeMenu();
    }
  }

  const closeMenu = () => {
    if (menu) menu.style.display = 'none';
  };

  const text = (cls, s) => Object.assign(document.createElement('div'), { className: cls, textContent: s });
  const initials = (s) => (s || '?').trim().slice(0, 2).toUpperCase();

  async function toggleMenu() {
    if (menu.style.display === 'block') return closeMenu();
    menu.replaceChildren(text('msg', 'Chargement…'));
    menu.style.display = 'block';
    place();
    const res = await send({ type: 'entries' });
    if (!target) return;
    if (!res?.ok) menu.replaceChildren(text('msg', res?.error || 'Coffre indisponible.'));
    else if (res.locked) menu.replaceChildren(text('msg', res.exists ? "Coffre verrouillé. Ouvrez l'extension Coffre pour le déverrouiller." : "Aucun coffre. Ouvrez l'extension Coffre pour en créer un."));
    else if (!res.entries.length) menu.replaceChildren(text('msg', "Aucun identifiant pour ce site. Ajoutez-en un depuis l'extension."));
    else menu.replaceChildren(...res.entries.map(renderItem));
    place();
  }

  function renderItem(entry) {
    const row = document.createElement('div');
    row.className = 'item';
    row.setAttribute('role', 'menuitem');
    const info = document.createElement('div');
    info.append(text('t', `Remplir avec ${entry.title}`), text('s', entry.username || '(sans identifiant)'));
    row.append(text('av', initials(entry.title)), info);
    row.choose = async () => {
      const res = await send({ type: 'fill', id: entry.id });
      if (!res?.ok) return menu.replaceChildren(text('msg', res?.error || 'Remplissage impossible.'));
      const from = target;
      fill(loginFields(from), res);
      from?.focus();
      hide();
    };
    row.addEventListener('click', (e) => {
      if (e.isTrusted) row.choose(); // jamais déclenché par le script d'une page
    });
    return row;
  }

  // Propositions à l'arrivée dans un champ de connexion : la liste s'ouvre d'elle-même quand le coffre a un identifiant
  // pour ce site. Rien n'est rempli sans un clic (ou Entrée) de l'utilisateur.
  let autoRun = 0;
  async function autoOpen() {
    const run = ++autoRun;
    const el = target;
    if (!el || el.value) return; // déjà rempli ou saisie en cours : on ne dérange pas
    const res = await send({ type: 'entries' });
    if (run !== autoRun || target !== el || el.value || !res?.ok || res.locked || !res.entries.length) return;
    menu.replaceChildren(...res.entries.map(renderItem));
    menu.style.display = 'block';
    highlight(0);
    place();
  }

  const items = () => (menu ? [...menu.querySelectorAll('.item')] : []);
  let hl = -1;
  function highlight(i) {
    const list = items();
    hl = list.length ? (i + list.length) % list.length : -1;
    list.forEach((r, k) => r.classList.toggle('hl', k === hl));
  }

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (isCandidate(el)) {
      show(el);
      autoOpen();
    } else {
      autoRun++;
      hide();
    }
  }, true);
  // Clavier : flèches pour choisir, Entrée pour remplir (seulement quand une proposition est surlignée), Échap pour fermer.
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !menu || menu.style.display !== 'block' || !target || hl < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(hl + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && items()[hl]?.choose) {
      e.preventDefault();
      e.stopPropagation();
      items()[hl].choose();
    }
  }, true);
  // Dès que l'utilisateur tape lui-même, la liste se retire.
  document.addEventListener('input', (e) => {
    if (e.isTrusted && e.target === target) {
      autoRun++;
      closeMenu();
    }
  }, true);
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (target && document.activeElement !== target) hide();
    }, 150);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  }, true);
  let raf = 0;
  const reposition = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(place);
  };
  addEventListener('scroll', reposition, { capture: true, passive: true });
  addEventListener('resize', reposition, { passive: true });
  if (isCandidate(document.activeElement)) {
    show(document.activeElement);
    autoOpen();
  }

  // ---------- Remplissage demandé depuis la popup ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'coffre:fill') return false;
    const active = document.activeElement;
    const fields = isCandidate(active) ? loginFields(active) : loginFields(null);
    sendResponse({ filled: fill(fields, msg) > 0 });
    return false;
  });

  // ---------- Capture à la soumission (« Enregistrer ce mot de passe ? ») ----------

  let lastKey = '';
  function capture(scope) {
    const pass = [...(scope || document).querySelectorAll('input[type="password"]')].find((i) => i.value && visible(i));
    if (!pass) return;
    const user = loginFields(pass).user;
    const payload = { username: user?.value || '', password: pass.value };
    const key = `${payload.username}\u0000${payload.password}`;
    if (key === lastKey) return;
    lastKey = key;
    setTimeout(() => (lastKey = ''), 2000);
    send({ type: 'captured', ...payload });
  }

  const SUBMIT_WORDS = /connexion|connecter|login|log in|sign in|valider|continuer|inscri|sign up|register|créer|create account/i;
  document.addEventListener('submit', (e) => capture(e.target), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.isTrusted && e.target instanceof HTMLInputElement) capture(e.target.form);
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const b = e.target.closest?.('button, input[type="submit"], [role="button"]');
    if (!b || b.closest?.('[role="menu"]')) return;
    const label = b.value || b.textContent || b.getAttribute('aria-label') || '';
    if (b.type === 'submit' || SUBMIT_WORDS.test(label)) capture(b.form);
  }, true);
})();
