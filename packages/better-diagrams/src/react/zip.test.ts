/**
 * The zip writer, verified against the format rather than a library: known
 * CRC vector, header signatures at the recorded offsets, and byte-identical
 * output across builds.
 */
import { describe, expect, it } from "vitest";
import { buildZip, crc32, type ZipEntry } from "./zip";

const bytes = (text: string) => new TextEncoder().encode(text);

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

const u32 = (data: Uint8Array, at: number) =>
  new DataView(data.buffer, data.byteOffset).getUint32(at, true);
const u16 = (data: Uint8Array, at: number) =>
  new DataView(data.buffer, data.byteOffset).getUint16(at, true);

describe("crc32", () => {
  it("matches the standard test vector", () => {
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
  });

  it("empty input is zero", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("buildZip", () => {
  const entries: ZipEntry[] = [
    { name: "a.txt", data: bytes("hello") },
    { name: "dir/b.svg", data: bytes("<svg/>") },
  ];

  it("emits a well-formed store-only archive", async () => {
    const out = await blobBytes(buildZip(entries));

    // Starts with a local file header for the first entry.
    expect(u32(out, 0)).toBe(0x04034b50);
    expect(u16(out, 6)).toBe(0x0800); // flags: UTF-8 names (EFS)
    expect(u16(out, 8)).toBe(0); // method: store

    // EOCD is the last 22 bytes (no comment).
    const eocd = out.length - 22;
    expect(u32(out, eocd)).toBe(0x06054b50);
    expect(u16(out, eocd + 8)).toBe(2); // entries on disk
    expect(u16(out, eocd + 10)).toBe(2); // entries total

    // The central directory sits where the EOCD says, and each record's
    // recorded local-header offset points at a real local header.
    const cdOffset = u32(out, eocd + 16);
    expect(u32(out, cdOffset)).toBe(0x02014b50);
    let record = cdOffset;
    for (let i = 0; i < 2; i++) {
      expect(u32(out, record)).toBe(0x02014b50);
      expect(u16(out, record + 8)).toBe(0x0800); // EFS flag mirrored centrally
      const nameLen = u16(out, record + 28);
      const localOffset = u32(out, record + 42);
      expect(u32(out, localOffset)).toBe(0x04034b50);
      record += 46 + nameLen;
    }
    // The directory ends exactly at the EOCD.
    expect(record).toBe(eocd);
  });

  it("stores names, sizes, and bytes verbatim", async () => {
    const out = await blobBytes(buildZip(entries));
    const text = new TextDecoder("latin1").decode(out);
    // Each name appears twice: local header + central directory.
    expect(text.split("a.txt")).toHaveLength(3);
    expect(text.split("dir/b.svg")).toHaveLength(3);

    // First entry: header is 30 + name bytes, data follows uncompressed.
    const dataStart = 30 + "a.txt".length;
    expect(u32(out, 18)).toBe(5); // compressed size === raw size (store)
    expect(new TextDecoder().decode(out.slice(dataStart, dataStart + 5))).toBe("hello");
    expect(u32(out, 14)).toBe(crc32(bytes("hello")));
  });

  it("round-trips a non-ASCII entry name as UTF-8", async () => {
    // The base filename is the host's file name — anything goes.
    const name = "Zürich—arch--2026-06-15.svg";
    const out = await blobBytes(buildZip([{ name, data: bytes("<svg/>") }]));
    const nameBytes = new TextEncoder().encode(name);
    expect(u16(out, 26)).toBe(nameBytes.length);
    expect(new TextDecoder().decode(out.slice(30, 30 + nameBytes.length))).toBe(name);
  });

  it("is deterministic", async () => {
    const one = await blobBytes(buildZip(entries));
    const two = await blobBytes(buildZip(entries));
    expect(one).toEqual(two);
  });
});
