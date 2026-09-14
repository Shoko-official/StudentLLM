const PDF_LIGATURES: Record<string, string> = {
  '\u0013': ' - ',
  '\u0014': ' - ',
  '\u0016': ' - ',
  '\u001b': 'ff',
  '\u001c': 'fi',
  '\u001d': 'fl',
  '\u001e': 'ffi',
  '\u001f': 'fi',
  '\u0088': ' • ',
};

function repairMojibakeUtf8(value: string) {
  if (!/[ÃÂ]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from([...value].map((character) => character.charCodeAt(0) & 0xff));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return value;
  }
}

/**
 * PyMuPDF can expose a PDF font's missing ligatures as control characters.
 * Keep this normalization at the document boundary so search, notes, and
 * transcript review all see the same readable source text.
 */
export function normalizeExtractedDocumentText(value: string) {
  let normalized = repairMojibakeUtf8(value.normalize('NFC'));
  Object.entries(PDF_LIGATURES).forEach(([character, replacement]) => {
    normalized = normalized.replaceAll(character, replacement);
  });
  normalized = normalized
    .replaceAll('\u0000', '(')
    .replaceAll('\u0001', ')')
    .replaceAll('\u0002', '')
    .replaceAll('\u0003', '')
    .replace(/[\u0004-\u0009\u000b-\u0012\u0015\u0017-\u001a\u007f-\u0087\u0089-\u009f]/g, ' ')
    .replace(/[\u00a0\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return normalized;
}

export function normalizeDocumentLine(value: string) {
  return normalizeExtractedDocumentText(value).replace(/\s+/g, ' ').trim();
}
