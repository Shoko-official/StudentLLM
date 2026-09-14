const MATH_GLYPH = /[∂∇∆√∫∑∏≤≥≠≈±×÷]/u;
const OPERATOR_WITH_EXPRESSION = /(?:\b(?:div|rot|grad|laplacien)\b|[A-Za-z]\s*(?:=|<|>|\+|-|\/|\^))/iu;

export function isExtractedMathSourceLine(value: string) {
  const line = value.trim();
  if (!line || line.length > 240) return false;
  return MATH_GLYPH.test(line) && OPERATOR_WITH_EXPRESSION.test(line);
}
