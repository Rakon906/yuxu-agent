import { existsSync, readFileSync } from 'node:fs';

const defaultUrl = new URL('../../configs/slang.json', import.meta.url);
const separators = /[\s，。！？、,.!?;；:：'"“”‘’（）()【】\[\]…—\-~～]/gu;

function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(separators, '');
}

function validate(entry, index) {
  const where = `slang entry ${index + 1}`;
  if (!entry || typeof entry !== 'object') throw new Error(`${where} is not an object`);
  if (typeof entry.surface !== 'string' || !entry.surface.trim() || entry.surface.length > 20) {
    throw new Error(`${where} has an invalid surface`);
  }
  if (entry.intended !== null && (typeof entry.intended !== 'string' || !entry.intended.trim() ||
      entry.intended.length > 40)) throw new Error(`${where} has an invalid intended meaning`);
  if (!['confirmed', 'candidate'].includes(entry.status)) throw new Error(`${where} has an invalid status`);
  const variants = entry.variants ?? [];
  if (!Array.isArray(variants) || variants.length > 20 ||
      variants.some(value => typeof value !== 'string' || !value.trim() || value.length > 20)) {
    throw new Error(`${where} has invalid variants`);
  }
  if (typeof entry.kind !== 'string' || !entry.kind) throw new Error(`${where} has an invalid kind`);
  return { surface: entry.surface.trim(), intended: entry.intended?.trim() ?? null,
    variants: variants.map(value => value.trim()), kind: entry.kind, tone: entry.tone ?? null,
    status: entry.status, ambiguous: entry.ambiguous === true, note: entry.note ?? null };
}

export function loadSlangEntries(url = defaultUrl) {
  if (!existsSync(url)) return [];
  const parsed = JSON.parse(readFileSync(url, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 200) {
    throw new Error('Invalid slang config');
  }
  return parsed.entries.map(validate);
}

export function createSlangAnnotator({ url = defaultUrl } = {}) {
  const entries = loadSlangEntries(url).filter(entry => entry.status === 'confirmed' && entry.intended);
  return text => {
    if (typeof text !== 'string' || !text) return [];
    const body = normalize(text);
    if (!body) return [];
    const found = [];
    for (const entry of entries) {
      const surface = [entry.surface, ...entry.variants]
        .sort((a, b) => b.length - a.length)
        .find(variant => normalize(variant).length >= 2 && body.includes(normalize(variant)));
      if (!surface) continue;
      found.push({ surface, intended: entry.intended, kind: entry.kind, tone: entry.tone,
        ambiguous: entry.ambiguous, confidence: 'lexicon',
        ...(entry.note ? { note: entry.note } : {}) });
    }
    return found.sort((a, b) => b.surface.length - a.surface.length)
      .filter((item, index, all) => all.findIndex(other =>
        other.surface === item.surface && other.intended === item.intended) === index);
  };
}
