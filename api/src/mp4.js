// Размеры и длительность видео из заголовка MP4/MOV (ISO BMFF): moov → mvhd, trak → tkhd.
// Без ffmpeg: читаем только служебные блоки. null — файл не MP4 или заголовок не найден.

function boxes(buf, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (buf, box, type) => boxes(buf, box.start, box.end).find(b => b.type === type);

function trackSize(buf, trak) {
  const mdia = child(buf, trak, 'mdia');
  const hdlr = mdia && child(buf, mdia, 'hdlr');
  if (!hdlr || buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') return null;
  const tkhd = child(buf, trak, 'tkhd');
  if (!tkhd) return null;
  const version = buf[tkhd.start];
  const matrix = tkhd.start + 4 + (version === 1 ? 32 : 20) + 16;
  let width = Math.round(buf.readUInt32BE(matrix + 36) / 65536);
  let height = Math.round(buf.readUInt32BE(matrix + 40) / 65536);
  // Видео с телефона часто записано боком и повёрнуто матрицей: a = d = 0 — поворот на 90°.
  if (buf.readInt32BE(matrix) === 0 && buf.readInt32BE(matrix + 16) === 0) [width, height] = [height, width];
  return width && height ? { width, height } : null;
}

export function videoInfo(buf) {
  try {
    const moov = boxes(buf, 0, buf.length).find(b => b.type === 'moov');
    if (!moov) return null;
    const mvhd = child(buf, moov, 'mvhd');
    let duration = null;
    if (mvhd) {
      const v1 = buf[mvhd.start] === 1;
      const timescale = buf.readUInt32BE(mvhd.start + (v1 ? 20 : 12));
      const units = v1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
      if (timescale) duration = Math.round(units / timescale);
    }
    const size = boxes(buf, moov.start, moov.end).filter(b => b.type === 'trak').map(t => trackSize(buf, t)).find(Boolean);
    return { width: size?.width ?? null, height: size?.height ?? null, duration };
  } catch {
    return null;
  }
}
