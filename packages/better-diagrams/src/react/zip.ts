/**
 * zip.ts — a store-only ZIP writer.
 *
 * Multi-state exports produce a handful of files at once; a browser firing N
 * separate downloads trips popup blockers and scatters files, so they ship as
 * one archive. Hand-rolled for the same reason the PDF writer is: the images
 * inside are already compressed, so DEFLATE would buy nothing, and "store" is
 * the whole format minus the parts we don't need.
 *
 * Output is deterministic — fixed timestamp, entry order preserved — so the
 * same document exports byte-identical archives.
 */

export interface ZipEntry {
  /**
   * Path inside the archive. Encoded as UTF-8 with the EFS flag set — the
   * combo suffixes are slugged ASCII, but the base is the host's filename,
   * which can be anything.
   */
  name: string;
  data: Uint8Array;
}

// ── CRC-32 (poly 0xEDB88320), table built on first use ───────────────────────

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── The archive ──────────────────────────────────────────────────────────────

// A fixed DOS timestamp (2026-01-01 00:00:00). Zip has no "no timestamp";
// stamping the build's wall clock would make identical exports differ.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

// General-purpose flag bit 11 (EFS): entry names are UTF-8. Without it,
// strict unzippers (Windows Explorer) decode names as CP437 and any
// non-ASCII base filename comes out as mojibake.
const FLAG_UTF8 = 0x0800;

/** Build a store-only zip. Entry names must be unique; order is preserved. */
export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.length;
  };

  const central: Uint8Array[] = [];
  let centralSize = 0;

  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const localOffset = offset;

    // Local file header.
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, FLAG_UTF8, true); // flags
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed = uncompressed (store)
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    push(local);
    push(data);

    // Matching central-directory record, emitted after all the data.
    const record = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, FLAG_UTF8, true); // flags
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    // Extra, comment, disk, internal attrs, external attrs: all zero.
    cv.setUint32(42, localOffset, true);
    record.set(nameBytes, 46);
    central.push(record);
    centralSize += record.length;
  }

  const centralOffset = offset;
  for (const record of central) push(record);

  // End of central directory.
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  push(eocd);

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return new Blob([out], { type: "application/zip" });
}
