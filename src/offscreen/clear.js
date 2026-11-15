// Document « offscreen » : le service worker n'a pas accès au presse-papiers, cette page éphémère le vide.
// Elle remplace son contenu par une espace (le presse-papiers ne peut pas être vraiment vide via execCommand).
const t = document.createElement('textarea');
t.value = ' ';
document.body.append(t);
t.select();
document.execCommand('copy');
