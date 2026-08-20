/**
 * Produces a "masked" copy of source code, character-for-character the same
 * length as the original, in which comments and string-literal *contents* are
 * blanked out.
 *
 * Why: every structural pass below (brace matching, member extraction, call
 * chain scanning) needs to walk the code without a `{` inside a string or a
 * `;` inside a comment throwing it off. Keeping the masked copy the same
 * length as the original means every offset found in the masked text points at
 * the right character in the real source, so edits stay exact.
 *
 * Masking scheme:
 *   comment characters      -> ' '
 *   string literal contents -> '\u0001' (quotes themselves are preserved)
 */

const STR = "\u0001";

export function mask(src, lang = "csharp") {
  const out = new Array(src.length);
  const literals = [];
  let i = 0;

  const put = (from, to, ch) => {
    for (let k = from; k < to; k++) out[k] = ch;
  };

  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];

    // Line comment
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      put(i, j, " ");
      i = j;
      continue;
    }

    // Block comment
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, src.length);
      put(i, j, " ");
      i = j;
      continue;
    }

    // C# verbatim string @"..."  ("" is an escaped quote)
    if (lang === "csharp" && c === "@" && c2 === '"') {
      let j = i + 2;
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue; }
        if (src[j] === '"') break;
        j++;
      }
      out[i] = "@";
      out[i + 1] = '"';
      put(i + 2, j, STR);
      literals.push({ start: i, end: j + 1, text: src.slice(i, j + 1) });
      if (j < src.length) out[j] = '"';
      i = j + 1;
      continue;
    }

    // Regular string / char literal, with backslash escapes
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === quote) break;
        if (src[j] === "\n") break; // unterminated; bail rather than eat the file
        j++;
      }
      out[i] = quote;
      put(i + 1, j, STR);
      if (j < src.length && src[j] === quote) {
        out[j] = quote;
        literals.push({ start: i, end: j + 1, text: src.slice(i, j + 1) });
        i = j + 1;
      } else {
        i = j;
      }
      continue;
    }

    out[i] = c;
    i++;
  }

  for (let k = 0; k < src.length; k++) if (out[k] === undefined) out[k] = src[k];
  return { masked: out.join(""), literals };
}

/** Index of the `}` (or `)`, `]`) closing the opener at `open`. -1 if unbalanced. */
export function matchBracket(masked, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const closer = pairs[masked[open]];
  if (!closer) return -1;
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === masked[open]) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}
