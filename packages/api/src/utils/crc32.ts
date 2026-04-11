/**
 * CRC32 (IEEE 802.3, poly 0xEDB88320). Used by the installation sentinel
 * header to detect byte-level corruption before attempting GCM decryption,
 * so a corrupt file can be distinguished from an ENCRYPTION_KEY mismatch.
 *
 * Standalone implementation — avoids pulling in `zlib` just for a checksum
 * and keeps the helper usable from the pre-env bootstrap entrypoint.
 */

let table: Uint32Array | null = null;

function buildTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
}

export function crc32(buf: Uint8Array): number {
  if (!table) table = buildTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
