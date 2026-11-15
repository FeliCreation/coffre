// Génère icons/icon-{16,32,48,128,192,512}.png sans dépendance : carré arrondi bleu + serrure blanche.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(out, { recursive: true });

// Formes en coordonnées 0..1
const inRound = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const body = (x, y) => x >= 0.28 && x <= 0.72 && y >= 0.48 && y <= 0.78 && inRound((x - 0.28) / 0.44, (y - 0.48) / 0.3, 0.15);
const shackle = (x, y) => {
  const d = Math.hypot(x - 0.5, y - 0.4);
  return (d >= 0.12 && d <= 0.2 && y <= 0.48) || ((Math.abs(x - 0.32) <= 0.04 || Math.abs(x - 0.68) <= 0.04) && y > 0.4 && y <= 0.5 && false);
};
const keyhole = (x, y) => Math.hypot(x - 0.5, y - 0.6) <= 0.045 || (Math.abs(x - 0.5) <= 0.022 && y >= 0.6 && y <= 0.7);

function pixel(x, y) {
  if (!inRound(x, y, 0.22)) return [0, 0, 0, 0];
  if (keyhole(x, y)) return [47, 95, 208, 255];
  if (body(x, y) || shackle(x, y)) return [255, 255, 255, 255];
  return [47, 95, 208, 255];
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(size) {
  const SS = 4; // sur-échantillonnage 4x4 pour des bords lisses
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb, pa] = pixel((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
        r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round(a / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128, 192, 512]) writeFileSync(join(out, `icon-${s}.png`), png(s));
console.log('icônes générées dans', out);
