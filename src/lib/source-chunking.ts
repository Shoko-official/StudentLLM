export interface SourceTextChunk {
  index: number;
  startLine: number;
  text: string;
}

export function chunkSourceText(text: string, maxCharacters = 1200): SourceTextChunk[] {
  if (maxCharacters < 1) throw new Error('Chunk size must be positive.');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks: SourceTextChunk[] = [];
  let currentLines: string[] = [];
  let currentCharacters = 0;
  let startLine = 1;

  const flush = () => {
    const value = currentLines.join('\n').trim();
    if (value) chunks.push({ index: chunks.length, startLine, text: value });
    currentLines = [];
    currentCharacters = 0;
  };

  lines.forEach((line, lineIndex) => {
    if (line.length > maxCharacters) {
      flush();
      for (let offset = 0; offset < line.length; offset += maxCharacters) {
        chunks.push({ index: chunks.length, startLine: lineIndex + 1, text: line.slice(offset, offset + maxCharacters) });
      }
      startLine = lineIndex + 2;
      return;
    }
    const nextCharacters = currentCharacters + line.length + (currentLines.length ? 1 : 0);
    if (currentLines.length && nextCharacters > maxCharacters) {
      flush();
      startLine = lineIndex + 1;
    }
    currentLines.push(line);
    currentCharacters += line.length + (currentLines.length > 1 ? 1 : 0);
  });
  flush();
  return chunks;
}
