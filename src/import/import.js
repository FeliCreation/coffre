// Page d'import : le fichier est lu et analysé ici, dans le navigateur. Rien ne quitte l'ordinateur ;
// les identifiants vont directement au service worker, qui les chiffre dans le coffre.
import { h, toast, api } from '../popup/ui.js';
import { parseExport } from '../core/import.js';

const app = document.getElementById('app');
const FORMATS = { dashlane: 'Dashlane', bitwarden: 'Bitwarden', chrome: 'Chrome / Edge', generique: 'CSV générique' };
const mount = (...n) => app.replaceChildren(...n.filter(Boolean));

async function init() {
  const st = await api({ type: 'state' });
  if (!st.exists) {
    return mount(h('h1', {}, 'Importer des identifiants'), h('p', {}, "Créez d'abord votre coffre : cliquez l'icône Coffre dans la barre d'outils, puis revenez sur cette page."));
  }
  return st.unlocked ? viewChoose() : viewUnlock();
}

function viewUnlock() {
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe maître', autocomplete: 'current-password' });
  const err = h('p', { class: 'error' });
  const submit = async () => {
    err.textContent = '';
    try {
      await api({ type: 'unlock', password: pw.value });
      viewChoose();
    } catch (e) {
      err.textContent = e.message;
    }
  };
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  mount(h('h1', {}, 'Coffre verrouillé'), h('p', { class: 'sub' }, 'Déverrouillez le coffre pour importer.'), pw, err, h('button', { class: 'btn primary block', onclick: submit }, 'Déverrouiller'));
  pw.focus();
}

function viewChoose(error = '') {
  const input = h('input', { type: 'file', accept: '.zip,.csv' });
  const drop = h('label', { class: 'drop' }, h('div', {}, h('b', {}, 'Choisissez un fichier'), ' ou déposez-le ici'), h('div', { class: 'sub' }, 'Export Dashlane (.zip), Bitwarden, Chrome ou Edge (.csv)'), input);
  const handle = async (file) => {
    if (!file) return;
    try {
      viewPreview(await parseExport(await file.arrayBuffer(), file.name), file.name);
    } catch (e) {
      viewChoose(e.message);
    }
  };
  input.addEventListener('change', () => handle(input.files[0]));
  drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => (e.preventDefault(), drop.classList.remove('over'), handle(e.dataTransfer.files[0])));
  mount(
    h('h1', {}, 'Importer des identifiants'),
    h('p', { class: 'sub' }, "Le fichier est lu dans votre navigateur et n'est envoyé nulle part."),
    h('ol', { class: 'steps' },
      h('li', {}, 'Dashlane : Paramètres → Exporter les données → « Fichier CSV ». Vous obtenez un .zip : choisissez-le tel quel.'),
      h('li', {}, 'Chrome : Gestionnaire de mots de passe → Paramètres → Exporter les mots de passe.')),
    drop,
    h('p', { class: 'error' }, error));
}

function viewPreview(res, filename) {
  const shown = res.entries.slice(0, 8);
  const table = h('table', {},
    h('tr', {}, h('th', {}, 'Titre'), h('th', {}, 'Adresse'), h('th', {}, 'Identifiant')),
    shown.map((e) => h('tr', {}, h('td', {}, e.title || '—'), h('td', {}, e.url || '—'), h('td', {}, e.username || '—'))));
  const err = h('p', { class: 'error' });
  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true;
    go.textContent = 'Import…';
    try {
      viewDone(await api({ type: 'importEntries', entries: res.entries }), filename);
    } catch (e) {
      if (e.code === 'LOCKED') return viewUnlock();
      err.textContent = e.message;
      go.disabled = false;
      go.textContent = `Importer ${res.entries.length} identifiants`;
    }
  } }, `Importer ${res.entries.length} identifiant${res.entries.length > 1 ? 's' : ''}`);
  mount(
    h('h1', {}, 'Vérifier avant d’importer'),
    h('p', { class: 'sub' }, `${filename} · format ${FORMATS[res.format]}`),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, String(res.entries.length)), 'à importer'),
      h('div', { class: 'stat' }, h('b', {}, String(res.skipped)), 'lignes vides ignorées')),
    table,
    res.entries.length > shown.length ? h('p', { class: 'sub' }, `… et ${res.entries.length - shown.length} autres.`) : null,
    res.ignoredFiles.length ? h('div', { class: 'note' }, h('b', {}, 'Non importés : '), res.ignoredFiles.join(', '), h('div', { class: 'sub' }, 'Cartes bancaires, pièces d’identité et informations personnelles ne sont volontairement pas repris.')) : null,
    h('div', { class: 'note sub' }, 'Les doublons exacts (même site, identifiant et mot de passe) sont ignorés : vous pouvez réimporter sans risque.'),
    err,
    h('div', { class: 'actions' }, go, h('button', { class: 'btn', onclick: () => viewChoose() }, 'Choisir un autre fichier')));
}

function viewDone(r, filename) {
  toast('Import terminé');
  mount(
    h('h1', {}, 'Import terminé'),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, String(r.added)), 'ajoutés'),
      h('div', { class: 'stat' }, h('b', {}, String(r.duplicates)), 'doublons ignorés'),
      h('div', { class: 'stat' }, h('b', {}, String(r.invalid)), 'invalides')),
    h('div', { class: 'warn' },
      h('b', {}, 'Supprimez maintenant le fichier exporté.'),
      h('p', { class: 'sub', style: 'margin:6px 0 0' }, `« ${filename} » contient tous vos mots de passe en clair. Supprimez-le de votre dossier Téléchargements, puis videz la corbeille.`)),
    h('p', { class: 'sub', style: 'margin-top:14px' }, 'Vous pouvez fermer cet onglet. Vos identifiants sont dans l’extension Coffre.'));
}

init().catch((e) => mount(h('h1', {}, 'Coffre indisponible'), h('p', { class: 'error' }, e.message)));
