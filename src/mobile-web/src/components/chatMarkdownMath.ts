/**
 * Mobile chat math activation and delimiter normalization.
 *
 * Math is rendered from a lazily loaded module, so this detection decides
 * whether the browser downloads KaTeX at all. Keep the single-dollar boundary
 * checks aligned with desktop MarkdownRenderer.mayContainMarkdownMath: a
 * closing dollar directly followed by a digit is ordinary currency text
 * (`$5 and $10`), not math.
 */
export function mayContainMarkdownMath(content: string): boolean {
  if (!content) return false;
  if (content.includes('$$') || content.includes('\\(') || content.includes('\\[')) {
    return true;
  }
  return /(^|[^\\$])\$[^$\n]{1,240}\$(?!\d)/.test(content);
}

const CODE_FENCE =
  /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\2[^\n]*(?=\n|$)|$)/g;
const INLINE_CODE = /(`+)((?:[^\n`]|(?!\1)`)*?)\1/g;
const SINGLE_LINE_DISPLAY_MATH = /(^|[^\\])\$\$([^\n]+?)\$\$/g;
const BRACKET_DISPLAY_MATH = /(^|[^\\])\\\[([\s\S]*?)\\\]/g;
const BRACKET_INLINE_MATH = /(^|[^\\])\\\(([\s\S]*?)\\\)/g;

/**
 * Convert the LaTeX delimiter styles that common models emit into the
 * `$...$`/`$$...$$` forms remark-math parses. Code fences and inline code are
 * replaced with placeholders first, so literal `\[`/`$$` examples survive.
 */
export function normalizeMathDelimiters(content: string): string {
  if (!content) return content;
  const hasDisplayBracket = content.includes('\\[');
  const hasInlineBracket = content.includes('\\(');
  const hasRawBlockDollars = /(^|[^\\])\$\$[^\n]+?\$\$/.test(content);
  if (!hasDisplayBracket && !hasInlineBracket && !hasRawBlockDollars) {
    return content;
  }

  const codeBlocks: { key: string; content: string }[] = [];
  let placeholderIndex = 0;

  // Protect code fences.
  let transformed = content.replace(CODE_FENCE, (match) => {
    const key = `@@MATH_CODE_BLOCK_${placeholderIndex++}@@`;
    codeBlocks.push({ key, content: match });
    return key;
  });

  // Protect inline code spans.
  transformed = transformed.replace(INLINE_CODE, (match) => {
    const key = `@@MATH_CODE_INLINE_${placeholderIndex++}@@`;
    codeBlocks.push({ key, content: match });
    return key;
  });

  // remark-math only treats `$$` as a display fence when it owns its line.
  // Single-line display math is common in model output, so expand it.
  transformed = transformed.replace(
    SINGLE_LINE_DISPLAY_MATH,
    (_, prefix, math) => `${prefix}\n\n$$\n${math.trim()}\n$$\n\n`,
  );

  // \[ ... \] is display math.
  transformed = transformed.replace(
    BRACKET_DISPLAY_MATH,
    (_, prefix, math) => `${prefix}\n\n$$\n${math.trim()}\n$$\n\n`,
  );

  // \( ... \) is inline math.
  transformed = transformed.replace(
    BRACKET_INLINE_MATH,
    (_, prefix, math) => `${prefix}$${math.trim()}$`,
  );

  // Restore protected code blocks using a function replacer so `$` sequences
  // in the code (`$$`, `$&`, `$1`) are not treated as replacement patterns.
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    const { key, content: code } = codeBlocks[i];
    transformed = transformed.replace(key, () => code);
  }

  return transformed;
}
