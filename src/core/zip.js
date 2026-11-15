// Lecteur de zip minimal (stocké ou deflate), sans dépendance : DecompressionStream est natif.
// Refuse les archives chiffrées, zip64 et les décompressions démesurées.

const MAX_TOTAL = 50 * 1024 * 1024;

async function inflateRaw(bytes, limit) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length > limit) throw new Error('Archive trop volumineuse.');
  return out;
}

/** @returns {Promise<{name: string, data: Uint8Array}[]>} */
export async function readZip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Ce fichier n'est pas une archive zip valide.");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  let total = 0;

  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Archive zip corrompue.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;

    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Archive zip protégée par mot de passe : extrayez-la d’abord, puis choisissez le fichier .csv.');
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('Archive zip64 non prise en charge.');
    total += usize;
    if (total > MAX_TOTAL) throw new Error('Archive trop volumineuse.');

    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error('Archive zip corrompue.');
    const start = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
    const raw = u8.subarray(start, start + csize);
    if (method === 0) files.push({ name, data: raw });
    else if (method === 8) files.push({ name, data: await inflateRaw(raw, MAX_TOTAL) });
    else throw new Error(`Méthode de compression ${method} non prise en charge.`);
  }
  return files;
}
