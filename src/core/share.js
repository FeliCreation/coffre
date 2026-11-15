// Partage sécurisé sans serveur : ECDH P-256 + HKDF-SHA256 + AES-256-GCM.
// Chaque coffre possède une identité (paire de clés). On échange des « codes » texte
// (clé publique, puis partage chiffré) par n'importe quel canal ; seul le destinataire peut ouvrir.
// L'authenticité repose sur la comparaison des empreintes par un second canal (voix, SMS...).

import { CryptoError, fromB64Url, toB64Url, randomBytes, seal, open, sha256Hex } from './crypto.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const PUB_PREFIX = 'coffre-pub:1:';
const SHARE_PREFIX = 'coffre-share:1:';

const cleanPub = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });

export async function generateIdentity() {
  const kp = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  return {
    publicKey: cleanPub(await crypto.subtle.exportKey('jwk', kp.publicKey)),
    privateKey: await crypto.subtle.exportKey('jwk', kp.privateKey),
  };
}

async function importPublic(jwk) {
  try {
    return await crypto.subtle.importKey('jwk', cleanPub(jwk), CURVE, false, []);
  } catch {
    throw new CryptoError('BAD_PUBLIC_KEY', 'Clé publique invalide.');
  }
}

/** Empreinte complète (hex) d'une clé publique. */
export function fingerprint(publicKey) {
  const p = cleanPub(publicKey);
  return sha256Hex(JSON.stringify({ crv: p.crv, kty: p.kty, x: p.x, y: p.y }));
}

/** Format lisible pour comparaison orale : 8 groupes de 4 caractères. */
export const formatFingerprint = (hex) => hex.slice(0, 32).toUpperCase().match(/.{4}/g).join(' ');

export const publicCode = (publicKey) => PUB_PREFIX + toB64Url(enc.encode(JSON.stringify(cleanPub(publicKey))));

export async function parsePublicCode(code) {
  const c = String(code).trim();
  if (!c.startsWith(PUB_PREFIX)) throw new CryptoError('BAD_CODE', 'Code de clé publique non reconnu.');
  let jwk;
  try {
    jwk = JSON.parse(dec.decode(fromB64Url(c.slice(PUB_PREFIX.length))));
  } catch {
    throw new CryptoError('BAD_CODE', 'Code de clé publique illisible.');
  }
  await importPublic(jwk); // valide que le point est bien sur la courbe
  return cleanPub(jwk);
}

async function sharedKey(privateJwk, peerPublicJwk, salt, senderFp, recipientFp) {
  const priv = await crypto.subtle.importKey('jwk', privateJwk, CURVE, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(peerPublicJwk) }, priv, 256);
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`coffre-share:1|${senderFp}|${recipientFp}`) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Chiffre `entry` (title/url/username/password/notes) pour le destinataire.
 * @param {{publicKey, privateKey}} identity  identité de l'expéditeur
 * @param {string} recipientCode  code « coffre-pub:... » du destinataire
 * @param {{ttlHours?: number}} opts  durée de validité (défaut 72 h)
 */
export async function createShare(identity, recipientCode, entry, { ttlHours = 72 } = {}) {
  const recipientPub = await parsePublicCode(recipientCode);
  const senderFp = await fingerprint(identity.publicKey);
  const recipientFp = await fingerprint(recipientPub);
  const salt = randomBytes(16);
  const key = await sharedKey(identity.privateKey, recipientPub, salt, senderFp, recipientFp);

  const now = Date.now();
  const payload = {
    createdAt: now,
    expiresAt: now + ttlHours * 3600_000,
    entry: {
      title: entry.title ?? '',
      url: entry.url ?? '',
      username: entry.username ?? '',
      password: entry.password ?? '',
      notes: entry.notes ?? '',
    },
  };
  const sealed = await seal(key, enc.encode(JSON.stringify(payload)), `${senderFp}|${recipientFp}`);
  const blob = { v: 1, from: cleanPub(identity.publicKey), to: recipientFp, salt: toB64Url(salt), ...sealed };
  return SHARE_PREFIX + toB64Url(enc.encode(JSON.stringify(blob)));
}

/** Ouvre un partage reçu. Lève NOT_FOR_YOU, EXPIRED, DECRYPT_FAILED ou BAD_CODE. */
export async function openShare(identity, code, { now = Date.now() } = {}) {
  const c = String(code).trim();
  if (!c.startsWith(SHARE_PREFIX)) throw new CryptoError('BAD_CODE', 'Code de partage non reconnu.');
  let blob;
  try {
    blob = JSON.parse(dec.decode(fromB64Url(c.slice(SHARE_PREFIX.length))));
  } catch {
    throw new CryptoError('BAD_CODE', 'Code de partage illisible.');
  }
  if (blob?.v !== 1 || !blob.from || !blob.iv || !blob.ct || !blob.salt) throw new CryptoError('BAD_CODE', 'Code de partage incomplet.');

  const myFp = await fingerprint(identity.publicKey);
  if (blob.to !== myFp) throw new CryptoError('NOT_FOR_YOU', 'Ce partage est destiné à un autre coffre.');

  const senderPub = cleanPub(blob.from);
  const senderFp = await fingerprint(senderPub);
  const key = await sharedKey(identity.privateKey, senderPub, fromB64Url(blob.salt), senderFp, myFp);
  const pt = await open(key, { iv: blob.iv, ct: blob.ct }, `${senderFp}|${myFp}`);
  const payload = JSON.parse(dec.decode(pt));

  if (now > payload.expiresAt) throw new CryptoError('EXPIRED', 'Ce partage a expiré.');
  return { entry: payload.entry, createdAt: payload.createdAt, sender: { publicKey: senderPub, fingerprint: senderFp } };
}
