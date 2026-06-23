export const BRAND_NAME = 'Polity';
export const EMBED_LIMITS = Object.freeze({ description: 4096, field: 1024, fields: 25, embeds: 10 });

export function normalizeFooter(value) {
  const text = String(value ?? '').trim();
  if (!text || /^\d{16,20}$/.test(text)) return BRAND_NAME;
  return text.slice(0, 2048);
}

export function truncateText(value, maximum, suffix = '…') {
  const text = String(value ?? '');
  if (text.length <= maximum) return text;
  return text.slice(0, Math.max(0, maximum - suffix.length)) + suffix;
}

export function chunkLines(lines, maximum = 3900, pageLimit = EMBED_LIMITS.embeds) {
  const pages = [];
  let page = '';
  for (const rawLine of lines) {
    const line = truncateText(rawLine, maximum);
    const candidate = page ? `${page}\n${line}` : line;
    if (candidate.length > maximum && page) {
      pages.push(page);
      page = line;
      if (pages.length === pageLimit) break;
    } else {
      page = candidate;
    }
  }
  if (page && pages.length < pageLimit) pages.push(page);
  return pages.length ? pages : ['*Nothing to show.*'];
}

export function safeField(name, value, inline = false) {
  return {
    name: truncateText(name || '\u200b', 256),
    value: truncateText(value || '\u200b', EMBED_LIMITS.field),
    inline,
  };
}
