const CONTROL_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

/** Inside strings: escapes a raw control character, and doubles a backslash that does not begin a JSON escape. */
function escapeInsideStrings(json: string) {
  let out = '', inString = false;
  for (let index = 0; index < json.length; index++) {
    const char = json[index];
    if (!inString) { inString = char === '"'; out += char; continue; }
    if (char === '"') { inString = false; out += char; continue; }
    if (char === '\\') {
      const next = json[index + 1];
      if (next !== undefined && (/[\\"/bfnrt]/.test(next) || (next === 'u' && /^[0-9a-fA-F]{4}$/.test(json.slice(index + 2, index + 6))))) { out += char + next; index++; }
      else out += '\\\\';
      continue;
    }
    out += char < ' ' ? CONTROL_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char;
  }
  return out;
}

/**
 * LaTeX commands whose first letter is also a JSON escape, by whole name. A tab, a form feed and a backspace are not wanted
 * in course text, so those commands come back anywhere. A newline and a carriage return are, so the names that a line of
 * prose could start with (`\nu` is "u", `\ne` is "e") come back only between $ signs.
 */
const LATEX_AFTER_ESCAPE: Record<string, { letter: string; anywhere: readonly string[]; inMath: readonly string[] }> = {
  '\t': { letter: 't', anywhere: ['text', 'textbf', 'textit', 'textrm', 'textsf', 'texttt', 'times', 'theta', 'tau', 'tan', 'tanh', 'to', 'top', 'tilde', 'therefore', 'triangle', 'tfrac'], inMath: [] },
  '\f': { letter: 'f', anywhere: ['frac', 'forall', 'flat'], inMath: [] },
  '\b': { letter: 'b', anywhere: ['beta', 'binom', 'bar', 'begin', 'big', 'bigg', 'bigcup', 'bigcap', 'boldsymbol', 'bmod', 'bullet', 'bot', 'because', 'backslash'], inMath: [] },
  '\n': { letter: 'n', anywhere: ['neq', 'nabla', 'notin', 'nmid', 'nearrow', 'nleq', 'ngeq', 'ncong'], inMath: ['nu', 'neg', 'ne', 'ni', 'not'] },
  '\r': { letter: 'r', anywhere: ['rightarrow', 'rangle', 'rfloor', 'rceil', 'rbrace'], inMath: ['rho', 'right'] },
};

function inMath(text: string, position: number) {
  let open = false;
  for (let index = 0; index < position; index++) if (text[index] === '$' && text[index - 1] !== '\\') open = !open;
  return open;
}

function restoreCommands(text: string) {
  return text.replace(/([\t\f\b\n\r])(\p{L}*)/gu, (match, control: string, rest: string, offset: number) => {
    const { letter, anywhere, inMath: mathOnly } = LATEX_AFTER_ESCAPE[control];
    const command = letter + rest;
    return anywhere.includes(command) || (mathOnly.includes(command) && inMath(text, offset)) ? `\\${command}` : match;
  });
}

function restoreIn(value: unknown): unknown {
  if (typeof value === 'string') return restoreCommands(value);
  if (Array.isArray(value)) return value.map(restoreIn);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreIn(item)]));
  return value;
}

/**
 * The JSON text of a reply whose strings hold LaTeX written with single backslashes: `\alpha` and a raw tab stop JSON.parse,
 * and `\times` parses into a tab and "imes". A reply with nothing to repair comes back unchanged, and so does one that
 * still cannot be read, so the caller reports it as it would have.
 */
export function repairLatexJson(reply: string): string {
  try {
    const readable = escapeInsideStrings(reply);
    const parsed: unknown = JSON.parse(readable);
    const restored = JSON.stringify(restoreIn(parsed));
    return readable === reply && restored === JSON.stringify(parsed) ? reply : restored;
  } catch {
    return reply;
  }
}
