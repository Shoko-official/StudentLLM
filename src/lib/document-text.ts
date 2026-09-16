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
 * Decode common UTF-8-as-Windows-1252 sequences emitted by PDF extractors.
 */
export function decodeMojibakeUtf8(value: string) {
  const typographyRepaired = value
    .replaceAll('\u00e2\u02c6\u2021', '∇')
    .replaceAll('\u00e2\u2020\u2019', '→')
    .replaceAll('\u00e2\u02c6\u201a', '∂');
  if (typographyRepaired !== value) return typographyRepaired;
  const legacyDecoded = repairMojibakeUtf8(value);
  if (legacyDecoded !== value) return legacyDecoded;
  if (!/[\u00c3\u00c2]|\u00e2[\u0080-\u00bf]/u.test(value)) return value;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from([...value].map((character) => character.charCodeAt(0) & 0xff)));
    return decoded.includes('\ufffd') ? value : decoded;
  } catch {
    return value;
  }
}

/** Extractors can join a known LaTeX command to its following symbol. */
export function repairBareLatexCommandPrefixes(value: string) {
  return value.replace(/\\(alpha|beta|cdot|Delta|gamma|lambda|mu|nabla|omega|partial|rho|sigma|sum|theta|times|vec)(?=[A-Za-z])/gu, '\\$1 ');
}

/**
 * Some imported LaTeX has passed through a JavaScript-style escape decoder.
 * Sequences such as `\\frac` can therefore arrive as form-feed + `rac`.
 * Repair only known command prefixes so ordinary document whitespace remains whitespace.
 */
export function repairCorruptedLatexCommands(value: string) {
  return value
    .replace(/\u0007(?=(?:lpha|rccos|rctan|rcsin)\b)/g, '\\a')
    .replace(/\u0008(?=(?:egin|oldsymbol|mathbf|mathrm)\b)/g, '\\b')
    .replace(/\u0009(?=(?:ext|imes|heta|au)\b)/g, '\\t')
    .replace(/\u000b(?=(?:ec|ertical)\b)/g, '\\v')
    .replace(/\u000c(?=(?:rac|orall)\b)/g, '\\f')
    .replace(/\u000d(?=(?:ight|ot|elta)\b)/g, '\\r');
}

/**
 * PyMuPDF can expose a PDF font's missing ligatures as control characters.
 * Keep this normalization at the document boundary so search, notes, and
 * transcript review all see the same readable source text.
 */
export function normalizeExtractedDocumentText(value: string) {
  let normalized = repairCorruptedLatexCommands(decodeMojibakeUtf8(value.normalize('NFC')));
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
