export interface SnippetPart {
  text: string;
  match: boolean;
}

/** Longest slice of source text ever stripped; keeps worst-case regex work bounded. */
const MAX_SOURCE_CHARS = 20_000;
/** Hard cap on any single construct a regex may span (link text, emphasis, inline math). */
const SPAN = 300;

/**
 * Lowercases and removes accents, one character for one character, so "ete" finds "été", "ecole" finds "École" and a
 * straight apostrophe finds the typographic one. Same length as the lowercased text, so snippet offsets stay valid.
 */
export function foldForSearch(text: string): string {
  return text.toLocaleLowerCase().replace(/[\u00c0-\u024f\u1e00-\u1eff\u2018\u2019]/g, (character) => {
    if (character === '\u2018' || character === '\u2019') return "'";
    return character.normalize('NFD')[0] ?? character;
  });
}

const PIPE = '\u0001'; // restored to "|" after table-pipe stripping
const ESCAPE_BASE = 0xe100; // private-use range holding escaped literal characters

const LATEX_SYMBOLS: Record<string, string> = {
  mid: PIPE, cdot: '·', times: '×', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  infty: '∞', to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', leftrightarrow: '↔', iff: '⇔',
  implies: '⇒', in: '∈', notin: '∉', cup: '∪', cap: '∩', subset: '⊂', subseteq: '⊆', sum: 'Σ', prod: 'Π',
  int: '∫', partial: '∂', nabla: '∇', pm: '±', mp: '∓', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Omega: 'Ω',
  Delta: 'Δ', Gamma: 'Γ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ',
  emptyset: '∅', varnothing: '∅', ldots: '…', dots: '…', cdots: '…', forall: '∀', exists: '∃', neg: '¬',
  land: '∧', lor: '∨', wedge: '∧', vee: '∨', therefore: '∴', angle: '∠', circ: '∘', equiv: '≡', sim: '∼',
  propto: '∝', ell: 'ℓ', hbar: 'ħ', perp: '⊥', parallel: '∥', oplus: '⊕', otimes: '⊗', ll: '≪', gg: '≫',
};

function latexToReadable(source: string) {
  let value = source;
  // \frac{a}{b} -> (a)/(b), repeated so simple nesting resolves
  for (let i = 0; i < 4; i += 1) {
    value = value.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
  }
  return value
    .replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, ' ')
    .replace(/\\\\/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '')
    // Unknown \cmd{x} wrappers (\mathbb, \hat, \text, ...) unwrap to their argument.
    .replace(/\\([A-Za-z]+)\s*\{([^{}]*)\}/g, (match, name: string, arg: string) => (name in LATEX_SYMBOLS ? match : arg))
    .replace(/\\([A-Za-z]+)/g, (_match, name: string) => LATEX_SYMBOLS[name] ?? name)
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\([{}%$&#_])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeEscape(character: string) {
  return String.fromCharCode(ESCAPE_BASE + character.charCodeAt(0));
}

/**
 * Turn Markdown/LaTeX source into one line of readable plain text.
 * Math is converted to a readable form (not removed) so a match inside a formula still shows.
 */
export function toPlainText(source: string): string {
  let text = source.slice(0, MAX_SOURCE_CHARS).replace(/\r\n?/g, '\n');
  text = text.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, ' $1 ');
  text = text.replace(/\$\$([\s\S]{0,2000}?)\$\$/g, (_match, math: string) => ` ${latexToReadable(math)} `);
  text = text.replace(/\\\[([\s\S]{0,2000}?)\\\]/g, (_match, math: string) => ` ${latexToReadable(math)} `);
  text = text.replace(/\\\(([\s\S]{0,2000}?)\\\)/g, (_match, math: string) => latexToReadable(math));
  text = text.replace(new RegExp(`(?<![\\\\$\\w])\\$(?!\\s)([^$\\n]{1,${SPAN}}?)(?<!\\s)\\$(?!\\d)`, 'g'), (_match, math: string) => latexToReadable(math));
  // Protect backslash-escaped literals (\*, \#, \_, \$5, ...) from the Markdown rules below.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!$|~>])/g, (_match, character: string) => encodeEscape(character));
  text = text
    .replace(/^[ \t]*(?:\|[ \t]*)?:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, ' ')
    .replace(/^[ \t]*(?:=+|-{2,})[ \t]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(new RegExp(`!\\[([^\\]\\n]{0,${SPAN}})\\]\\((?:[^()\\s]|\\([^()\\s]*\\)){0,${SPAN}}\\)`, 'g'), '$1')
    .replace(new RegExp(`\\[([^\\]\\n]{1,${SPAN}})\\]\\((?:[^()\\s]|\\([^()\\s]*\\)){0,${SPAN}}\\)`, 'g'), '$1')
    .replace(/`([^`\n]{0,300})`/g, '$1')
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/(\*\*|__)(.{1,300}?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)([^*\n]{1,300}?)\*(?![\w*])/g, '$1')
    .replace(/(?<!\w)_(?!\s)([^_\n]{1,300}?)_(?!\w)/g, '$1')
    .replace(/~~(.{1,300}?)~~/g, '$1');
  return text
    .replace(/[-]/g, (character) => String.fromCharCode(character.charCodeAt(0) - ESCAPE_BASE))
    .replace(/\u0001/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Candidate needles for a query: as typed, with Markdown/LaTeX stripped, and with LaTeX names mapped to symbols. */
function queryVariants(query: string): string[] {
  // The same query is reused for every segment of a search: remember the last result (pure function of the query).
  if (lastVariants?.query === query) return lastVariants.variants;
  const variants = computeQueryVariants(query);
  lastVariants = { query, variants };
  return variants;
}

let lastVariants: { query: string; variants: string[] } | undefined;

function computeQueryVariants(query: string): string[] {
  const typed = foldForSearch(query.trim());
  if (!typed) return [];
  const stripped = foldForSearch(toPlainText(query));
  const symbolic = typed.replace(/[a-z]+/gi, (word) => {
    const symbol = LATEX_SYMBOLS[word] ?? LATEX_SYMBOLS[word.toLowerCase()];
    return symbol && symbol !== PIPE ? symbol : word;
  });
  const unmarked = typed.replace(/[*_`#~>\\$]/g, '').replace(/\s+/g, ' ').trim();
  return [...new Set([typed, stripped, foldForSearch(symbolic), unmarked])].filter(Boolean);
}

/** Window of the raw source worth stripping: the head, or the area around a raw match in a very long text. */
function boundedSource(source: string, query: string) {
  if (source.length <= MAX_SOURCE_CHARS) return source;
  const needle = foldForSearch(query.trim());
  const index = needle ? foldForSearch(source).indexOf(needle) : -1;
  if (index < 0) return source;
  const start = Math.max(0, index - MAX_SOURCE_CHARS / 2);
  return source.slice(start, start + MAX_SOURCE_CHARS);
}

const PLAIN_CACHE_MAX_ENTRIES = 20_000;
const PLAIN_CACHE_MAX_CHARS = 8_000_000;
// Keyed by the exact source text: an edited segment is a different key, so a stale entry can never be returned.
const plainCache = new Map<string, string>();
let plainCacheChars = 0;

/** Test-only: current size of the plain-text cache and the characters it accounts for. */
export function __plainCacheStatsForTests() {
  return { size: plainCache.size, chars: plainCacheChars };
}

/** Lowercased plain text of a source, cached (bounded, least recently used) so each keystroke does not re-strip every segment. */
function lowerPlainText(source: string, query: string): string {
  // Longer sources are windowed around the query, so their plain text depends on the query: do not cache.
  if (source.length > MAX_SOURCE_CHARS) return foldForSearch(toPlainText(boundedSource(source, query)));
  const cached = plainCache.get(source);
  if (cached !== undefined) {
    plainCache.delete(source);
    plainCache.set(source, cached);
    return cached;
  }
  const plain = foldForSearch(toPlainText(source));
  plainCache.set(source, plain);
  plainCacheChars += source.length + plain.length;
  for (const key of plainCache.keys()) {
    if (plainCache.size <= PLAIN_CACHE_MAX_ENTRIES && plainCacheChars <= PLAIN_CACHE_MAX_CHARS) break;
    plainCacheChars -= key.length + (plainCache.get(key)?.length ?? 0);
    plainCache.delete(key);
  }
  return plain;
}

/**
 * True when the query matches the source text itself or its readable plain-text form,
 * so search results agree with the highlighted snippet.
 */
export function textMatchesQuery(source: string, query: string): boolean {
  const needle = foldForSearch(query.trim());
  if (!needle) return false;
  if (foldForSearch(source).includes(needle)) return true;
  const plain = lowerPlainText(source, query);
  return queryVariants(query).some((variant) => plain.includes(variant));
}

/** Plain-text excerpt around the first match, split into highlightable parts. */
export function buildSnippet(source: string, query: string, maxLength = 160): SnippetPart[] {
  const plain = toPlainText(boundedSource(source, query));
  if (!plain) return [];
  const lower = foldForSearch(plain);
  // Lowercasing can change length for rare characters; skip highlighting then.
  let index = -1;
  let length = 0;
  if (lower.length === plain.length) {
    for (const variant of queryVariants(query)) {
      const found = lower.indexOf(variant);
      if (found >= 0) {
        index = found;
        length = variant.length;
        break;
      }
    }
  }
  let start = 0;
  if (index >= 0) {
    start = Math.max(0, index - Math.floor(Math.max(0, maxLength - length) / 3));
    if (start > 0) {
      const space = plain.indexOf(' ', start);
      if (space >= 0 && space < index) start = space + 1;
    }
  }
  const end = Math.min(plain.length, start + maxLength);
  const parts: SnippetPart[] = [];
  if (start > 0) parts.push({ text: '… ', match: false });
  if (index >= start && index + length <= end) {
    if (index > start) parts.push({ text: plain.slice(start, index), match: false });
    parts.push({ text: plain.slice(index, index + length), match: true });
    if (index + length < end) parts.push({ text: plain.slice(index + length, end), match: false });
  } else {
    parts.push({ text: plain.slice(start, end), match: false });
  }
  if (end < plain.length) {
    const last = parts[parts.length - 1];
    parts[parts.length - 1] = { ...last, text: last.text.trimEnd() };
    parts.push({ text: ' …', match: false });
  }
  return parts;
}
