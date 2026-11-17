/**
 * Minimal, bound-checked protobuf reader/writer used to inspect Moments replies.
 *
 * The official Moments schema for WeChat 4.x is not public, so replies are
 * decoded structurally: field number, wire type and a best-effort interpretation
 * of each length-delimited value (UTF-8 text and/or a nested message). Nothing
 * here assumes a field meaning, and no value is trusted beyond its bounds.
 */

const MAX_FIELDS = 4096;
const MAX_DEPTH = 8;

export function bytesToHex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('Invalid hex');
  return Buffer.from(hex, 'hex');
}

export function varint(value) {
  let remaining = typeof value === 'bigint' ? value : BigInt(value);
  if (remaining < 0n) throw new Error('Varint must be non-negative');
  const out = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0n);
  return Buffer.from(out);
}

/** Encode fields in order: {number, varint} or {number, bytes: Buffer|string}. */
export function encodeFields(fields) {
  const parts = [];
  for (const field of fields) {
    if (!Number.isInteger(field.number) || field.number <= 0 || field.number >= 2 ** 29) throw new Error('Invalid field number');
    if ('varint' in field && field.varint !== undefined) {
      parts.push(varint(BigInt(field.number) << 3n), varint(field.varint));
    } else if ('bytes' in field && field.bytes !== undefined) {
      const value = Buffer.isBuffer(field.bytes) ? field.bytes : Buffer.from(String(field.bytes), 'utf8');
      parts.push(varint((BigInt(field.number) << 3n) | 2n), varint(BigInt(value.length)), value);
    } else {
      throw new Error('Field needs varint or bytes');
    }
  }
  return Buffer.concat(parts);
}

function readVarint(buffer, offset) {
  let result = 0n;
  for (let i = 0; i < 10; i += 1) {
    if (offset + i >= buffer.length) throw new Error('Truncated varint');
    const byte = buffer[offset + i];
    result |= BigInt(byte & 0x7f) << BigInt(i * 7);
    if ((byte & 0x80) === 0) return { value: result, offset: offset + i + 1 };
    if (i === 9 && byte > 1) throw new Error('Varint overflow');
  }
  throw new Error('Unterminated varint');
}

function printableText(buffer) {
  if (!buffer.length) return '';
  const text = buffer.toString('utf8');
  if (text.includes('�')) return null;
  let printable = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code !== 0x7f)) printable += 1;
  }
  return printable / [...text].length >= 0.9 ? text : null;
}

/** Decode one message level. Returns {fields, bytesConsumed}. Throws on malformed input. */
export function decodeMessage(buffer, { depth = 0 } = {}) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (fields.length >= MAX_FIELDS) throw new Error('Too many fields');
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const number = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (number <= 0 || number >= 2 ** 29) throw new Error('Invalid field tag');
    if (wire === 0) {
      const read = readVarint(buffer, offset);
      fields.push({ number, wire, varint: read.value.toString() });
      offset = read.offset;
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const size = Number(length.value);
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > buffer.length) throw new Error('Truncated bytes field');
      const value = buffer.subarray(offset, offset + size);
      offset += size;
      const field = { number, wire, size, bytes: bytesToHex(value), text: printableText(value) };
      if (depth + 1 < MAX_DEPTH && value.length > 0) {
        try {
          const nested = decodeMessage(value, { depth: depth + 1 });
          if (nested.fields.length > 0) field.message = nested.fields;
        } catch {
          // Not a message; the text/raw view stays authoritative.
        }
      }
      fields.push(field);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > buffer.length) throw new Error('Truncated fixed field');
      fields.push({ number, wire, bytes: bytesToHex(buffer.subarray(offset, offset + size)) });
      offset += size;
    } else {
      throw new Error(`Unsupported wire type ${wire}`);
    }
  }
  return { fields, bytesConsumed: offset };
}

/** Parse without throwing; keeps the raw reason for diagnostics. */
export function tryDecode(buffer) {
  try {
    return { ok: true, ...decodeMessage(Buffer.from(buffer)) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Compact, human-readable outline. Nested messages are expanded; long raw bytes
 * stay as length + short prefix so a timeline reply remains copy-pasteable.
 */
export function outline(fields, { depth = 0, maxDepth = 5, maxText = 80 } = {}) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const field of fields) {
    if (field.wire === 0) {
      lines.push(`${pad}#${field.number} varint ${field.varint}`);
      continue;
    }
    if (field.wire === 1 || field.wire === 5) {
      lines.push(`${pad}#${field.number} fixed${field.wire === 1 ? 64 : 32} ${field.bytes}`);
      continue;
    }
    const summary = field.text === null ? 'binary' : JSON.stringify(field.text.slice(0, maxText));
    lines.push(`${pad}#${field.number} bytes(${field.size}) ${summary}`);
    if (field.message && depth < maxDepth) lines.push(...outline(field.message, { depth: depth + 1, maxDepth, maxText }));
  }
  return lines;
}
