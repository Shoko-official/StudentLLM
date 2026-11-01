const imageUriStart = 'data(?::|%3a|&#0*58;|&#x0*3a;|&colon;)image(?:/|%2f|&#0*47;|&#x0*2f;|&sol;)';
const omittedImage = '[image payload omitted]';

/** Recognizable image representations only; this does not detect arbitrary base64. */
export function hasEmbeddedImages(text: string): boolean {
  return new RegExp(`${imageUriStart}|<svg\\b`, 'i').test(text);
}

function svgMarker(opening: string, block: string) {
  const label = opening.match(/\baria-label\s*=\s*(["'])(.*?)\1/is)?.[2]
    ?? block.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  return label ? `[image: ${label.replace(/<[^>]*>/g, '')}]` : omittedImage;
}

function redactInlineSvg(text: string) {
  const tags = /<\/?svg\b[^>]*>/gi;
  let depth = 0, start = 0, opening = '', cursor = 0, output = '';
  for (const tag of text.matchAll(tags)) {
    const closing = /^<\//.test(tag[0]), selfClosing = /\/\s*>$/.test(tag[0]);
    if (!closing && !depth) { start = tag.index!; opening = tag[0]; }
    if (!closing && !selfClosing) depth++;
    else if (closing && depth) depth--;
    else if (closing) continue;
    if (!depth) {
      const block = text.slice(start, tag.index! + tag[0].length);
      output += text.slice(cursor, start) + svgMarker(opening, block);
      cursor = tag.index! + tag[0].length;
    }
  }
  if (depth) return output + text.slice(cursor, start) + svgMarker(opening, text.slice(start));
  const tail = text.slice(cursor), incomplete = tail.search(/<svg\b/i);
  return output + (incomplete < 0 ? tail : tail.slice(0, incomplete) + omittedImage);
}

/** Remove image payloads before source splitting. Never decodes, renders or fetches URLs. */
export function redactContextImages(text: string): string {
  if (!hasEmbeddedImages(text)) return text;
  let result = redactInlineSvg(text);
  // Quoted HTML/CSS values and angle-wrapped Markdown destinations can contain whitespace.
  result = result.replace(new RegExp(`(["'])(\\s*${imageUriStart}[\\s\\S]*?)\\1`, 'gi'), (_match, quote: string) => `${quote}${omittedImage}${quote}`);
  result = result.replace(new RegExp(`<\\s*${imageUriStart}[\\s\\S]*?>`, 'gi'), omittedImage);
  // Markdown image destinations retain their alt text, optional title and surrounding prose.
  result = result.replace(new RegExp(`(!\\[(?:\\\\.|[^\\]\\\\])*\\]\\(\\s*)${imageUriStart}[\\s\\S]*?(\\s+(?:"[^"]*"|'[^']*')\\s*\\)|\\))`, 'gi'), (_match, prefix: string, suffix: string) => `${prefix}${omittedImage}${suffix}`);
  return result.replace(new RegExp(`${imageUriStart}[^\\s"'<>)]*`, 'gi'), omittedImage);
}
