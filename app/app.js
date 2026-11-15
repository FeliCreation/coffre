// Application web (téléphone ou ordinateur) : même popup et même service worker que l'extension, avec un faux `chrome`.
import { installAppChrome } from './shim.js';

window.COFFRE_APP = true;
installAppChrome();
await import('../src/background/service-worker.js');
await import('../src/popup/popup.js');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {}); // hors ligne : sans incidence si l'enregistrement échoue
}
