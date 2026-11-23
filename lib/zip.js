'use strict';
// Minimal ZIP read/write (store + deflate). No extra dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function encodeUtf8Name(name) {
  return Buffer.from(String(name).replace(/\\/g, '/'), 'utf8');
}

function writeU16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function writeU32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function createZip(dest, entries, { now = new Date() } = {}) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosDateTime(now);
  let files = 0;
  let bytes = 0;
  for (const ent of entries) {
    const name = String(ent.name || ent.rel || '');
    if (!name) continue;
    const data = Buffer.isBuffer(ent.data) ? ent.data : Buffer.from(ent.data == null ? '' : ent.data);
    const crc = crc32(data);
    const compressed = data.length ? zlib.deflateRawSync(data) : Buffer.alloc(0);
    const method = data.length ? 8 : 0;
    const payload = method ? compressed : data;
    const nameBuf = encodeUtf8Name(name);
    const flag = 0x800; // UTF-8
    const local = Buffer.concat([
      writeU32(0x04034b50),
      writeU16(20),
      writeU16(flag),
      writeU16(method),
      writeU16(time),
      writeU16(date),
      writeU32(crc),
      writeU32(payload.length),
      writeU32(data.length),
      writeU16(nameBuf.length),
      writeU16(0),
      nameBuf,
      payload,
    ]);
    const central = Buffer.concat([
      writeU32(0x02014b50),
      writeU16(20),
      writeU16(20),
      writeU16(flag),
      writeU16(method),
      writeU16(time),
      writeU16(date),
      writeU32(crc),
      writeU32(payload.length),
      writeU32(data.length),
      writeU16(nameBuf.length),
      writeU16(0),
      writeU16(0),
      writeU16(0),
      writeU16(0),
      writeU32(0),
      writeU32(offset),
      nameBuf,
    ]);
    parts.push(local);
    centrals.push(central);
    offset += local.length;
    files += 1;
    bytes += data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    writeU32(0x06054b50),
    writeU16(0),
    writeU16(0),
    writeU16(files),
    writeU16(files),
    writeU32(centralDir.length),
    writeU32(offset),
    writeU16(0),
  ]);
  const out = Buffer.concat([...parts, centralDir, eocd]);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out);
  return { path: dest, files, bytes, size: out.length };
}

function findEocd(buf) {
  // EOCD is 22 bytes + comment; scan from the end.
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZip(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 22) throw new Error('Not a ZIP file (too small).');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a ZIP file (missing central directory).');
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLen > buf.length) throw new Error('Not a ZIP file (truncated).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) throw new Error('Not a ZIP file (bad central directory).');
  const entries = [];
  let pos = cdOff;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('Not a ZIP file (corrupt central directory).');
    }
    const madeBy = buf.readUInt16LE(pos + 4);
    const flag = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen2 = buf.readUInt16LE(pos + 32);
    const extAttr = buf.readUInt32LE(pos + 38);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString((flag & 0x800) ? 'utf8' : 'binary');
    const unixMode = (madeBy >> 8) === 3 ? (extAttr >>> 16) : 0;
    const isSymlink = (unixMode & 0o170000) === 0o120000;
    const isDir = name.endsWith('/') || (unixMode & 0o170000) === 0o040000;
    entries.push({
      name: name.replace(/\\/g, '/'),
      method,
      crc,
      compressedSize: compSize,
      size: uncompSize,
      localOffset: localOff,
      unixMode,
      isSymlink,
      isDir,
      flag,
    });
    pos += 46 + nameLen + extraLen + commentLen2;
  }
  return { path: file, size: buf.length, entries, _buf: buf };
}

function extractEntry(zip, entry) {
  const buf = zip._buf;
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) {
    throw new Error('Corrupt ZIP entry: ' + entry.name);
  }
  const flag = buf.readUInt16LE(off + 6);
  const method = buf.readUInt16LE(off + 8);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  let dataStart = off + 30 + nameLen + extraLen;
  let compSize = entry.compressedSize;
  if (flag & 0x8) {
    // data descriptor after the data; size comes from central dir (already on entry)
  }
  const comp = buf.slice(dataStart, dataStart + compSize);
  let raw;
  if (method === 0) raw = Buffer.from(comp);
  else if (method === 8) raw = zlib.inflateRawSync(comp);
  else throw new Error('Unsupported ZIP compression method ' + method + ' for ' + entry.name);
  if (raw.length !== entry.size && entry.size) {
    // allow empty dir entries
    if (!(entry.isDir && raw.length === 0)) {
      /* still accept if CRC matches */
    }
  }
  if (entry.size && crc32(raw) !== entry.crc && raw.length) {
    throw new Error('CRC mismatch for ' + entry.name);
  }
  return raw;
}

module.exports = { createZip, readZip, extractEntry, crc32 };
