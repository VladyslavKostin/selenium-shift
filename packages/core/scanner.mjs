/**
 * Extracts types and their members (methods, properties, constructors) from C#
 * and Java source.
 *
 * SCOPE: this is a structural scanner, not a compiler. It resolves shapes, not
 * types. That is enough for the audit and for predicting async impact, and it
 * is deliberately not enough to safely rewrite a large C# codebase — see
 * README "Limits of the prototype". Roslyn is the right tool for that job.
 */

import { mask, matchBracket, lineOf } from "./masker.mjs";

const CS_MODIFIERS = new Set([
  "public", "private", "protected", "internal", "static", "async", "virtual",
  "override", "abstract", "sealed", "partial", "extern", "new", "unsafe",
  "readonly", "const", "volatile", "required", "file",
]);

const JAVA_MODIFIERS = new Set([
  "public", "private", "protected", "static", "final", "abstract",
  "synchronized", "native", "transient", "volatile", "strictfp", "default",
]);

const TYPE_KEYWORDS = {
  csharp: ["class", "interface", "struct", "record"],
  java: ["class", "interface", "enum", "record"],
};

/** Strip leading attributes/annotations, returning them plus the remainder. */
function splitDecorators(header, lang) {
  const decorators = [];
  let rest = header.trim();
  for (;;) {
    if (lang === "csharp" && rest.startsWith("[")) {
      const end = findClose(rest, 0, "[", "]");
      if (end < 0) break;
      decorators.push(rest.slice(0, end + 1));
      rest = rest.slice(end + 1).trim();
      continue;
    }
    if (lang === "java" && rest.startsWith("@")) {
      const m = /^@[\w.]+(\s*\([^)]*\))?/.exec(rest);
      if (!m) break;
      decorators.push(m[0]);
      rest = rest.slice(m[0].length).trim();
      continue;
    }
    break;
  }
  return { decorators, rest };
}

function findClose(s, open, o, c) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === o) d++;
    else if (s[i] === c) { d--; if (d === 0) return i; }
  }
  return -1;
}

/** Split a declaration header into modifiers and the remaining text. */
function takeModifiers(text, lang) {
  const set = lang === "csharp" ? CS_MODIFIERS : JAVA_MODIFIERS;
  const mods = [];
  let rest = text.trim();
  for (;;) {
    const m = /^([A-Za-z_]\w*)\s+/.exec(rest);
    if (!m || !set.has(m[1])) break;
    mods.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { mods, rest: rest.trim() };
}

/**
 * Parse a member header such as
 *   "public async Task<bool> IsVisible(string name)"
 *   "public IWebElement SubmitButton"
 *   "public LoginPage(IWebDriver driver)"
 */
function parseMemberHeader(header, lang, typeName) {
  const { decorators, rest: afterDecorators } = splitDecorators(header, lang);
  const { mods, rest } = takeModifiers(afterDecorators, lang);
  if (!rest) return null;

  const parenIdx = rest.indexOf("(");
  if (parenIdx >= 0) {
    const close = findClose(rest, parenIdx, "(", ")");
    if (close < 0) return null;
    const before = rest.slice(0, parenIdx).trim();
    const params = rest.slice(parenIdx + 1, close).trim();
    const nameMatch = /([A-Za-z_]\w*)\s*(<[^<>]*>)?$/.exec(before);
    if (!nameMatch) return null;
    const name = nameMatch[1];
    const returnType = before.slice(0, nameMatch.index).trim();

    if (!returnType && name === typeName) {
      return { kind: "ctor", name, returnType: null, params, mods, decorators };
    }
    if (!returnType) return null;
    return { kind: "method", name, returnType, params, mods, decorators };
  }

  // No parens: a property (C#) or a field.
  const m = /^(.*?[\w>\]?])\s+([A-Za-z_]\w*)$/.exec(rest);
  if (!m) return null;
  return {
    kind: lang === "csharp" ? "property" : "field",
    name: m[2],
    returnType: m[1].trim(),
    params: null,
    mods,
    decorators,
  };
}

function parseBaseList(headerText) {
  const idx = headerText.indexOf(":");
  if (idx < 0) return [];
  return headerText
    .slice(idx + 1)
    .split(",")
    .map((s) => s.trim().replace(/<.*/, ""))
    .filter(Boolean);
}

function parseJavaBases(headerText) {
  const bases = [];
  const ext = /\bextends\s+([\w.<>,\s]+?)(?=\bimplements\b|$)/.exec(headerText);
  const impl = /\bimplements\s+([\w.<>,\s]+)$/.exec(headerText);
  for (const chunk of [ext?.[1], impl?.[1]]) {
    if (!chunk) continue;
    for (const b of chunk.split(",")) {
      const t = b.trim().replace(/<.*/, "");
      if (t) bases.push(t);
    }
  }
  return bases;
}

/**
 * Walk a type body at depth 0 and pull out each member.
 * Segments run from the end of the previous member to the next `{`, `=>` or `;`
 * at brace depth 0, which is exactly where a member declaration ends.
 */
function scanTypeBody(src, masked, bodyStart, bodyEnd, lang, typeName, file) {
  const members = [];
  let i = bodyStart + 1;
  let segStart = i;
  let depth = 0;

  while (i < bodyEnd) {
    const c = masked[i];

    if (c === "(" || c === "[") {
      const close = matchBracket(masked, i);
      i = close < 0 ? i + 1 : close + 1;
      continue;
    }

    if (c === "{") {
      if (depth === 0) {
        const close = matchBracket(masked, i);
        if (close < 0) break;
        const header = stripComments(src.slice(segStart, i), masked.slice(segStart, i));
        const parsed = parseMemberHeader(header, lang, typeName);
        if (parsed && parsed.kind !== "field") {
          members.push(buildMember(parsed, src, segStart, i, i, close, file, lang, typeName));
        }
        i = close + 1;
        segStart = i;
        continue;
      }
      depth++;
      i++;
      continue;
    }

    if (c === "}") { depth--; i++; continue; }

    if (c === ";" && depth === 0) {
      const header = stripComments(src.slice(segStart, i), masked.slice(segStart, i));
      // Expression-bodied member, or an abstract/interface declaration.
      const arrow = header.indexOf("=>");
      const declPart = arrow >= 0 ? header.slice(0, arrow) : header;
      const parsed = parseMemberHeader(declPart, lang, typeName);
      if (parsed && parsed.kind !== "field") {
        members.push(
          buildMember(
            parsed, src, segStart, arrow >= 0 ? segStart + arrow : i,
            arrow >= 0 ? segStart + arrow + 2 : null,
            arrow >= 0 ? i : null, file, lang, typeName,
            arrow >= 0
          )
        );
      }
      i++;
      segStart = i;
      continue;
    }

    i++;
  }

  return members;
}

/**
 * Blank out anything the masker treated as a comment, so a doc comment sitting
 * above a method never leaks into its parsed return type.
 */
function stripComments(srcSlice, maskedSlice) {
  let out = "";
  for (let i = 0; i < srcSlice.length; i++) {
    out += (maskedSlice[i] === " " && !/\s/.test(srcSlice[i])) ? " " : srcSlice[i];
  }
  return out;
}

function buildMember(parsed, src, headerStart, headerEnd, bodyStart, bodyEnd, file, lang, typeName, expressionBodied = false) {
  const body = bodyStart != null && bodyEnd != null ? src.slice(bodyStart, bodyEnd) : "";
  return {
    id: `${typeName}.${parsed.name}`,
    file,
    type: typeName,
    kind: parsed.kind,
    name: parsed.name,
    returnType: parsed.returnType,
    params: parsed.params,
    paramCount: countParams(parsed.params),
    mods: parsed.mods,
    decorators: parsed.decorators,
    isAsync: parsed.mods.includes("async"),
    isAbstract: parsed.mods.includes("abstract") || bodyStart == null,
    expressionBodied,
    isTestMethod: /^\s*[\[@]\s*(Test|TestCase|TestCaseSource|SetUp|TearDown|OneTimeSetUp|OneTimeTearDown|Fact|Theory|Before|After|BeforeEach|AfterEach)\b/.test(
      parsed.decorators.join(" ")
    ),
    headerStart,
    headerEnd,
    bodyStart,
    bodyEnd,
    body,
    line: lineOf(src, headerStart),
  };
}

function countParams(params) {
  if (!params || !params.trim()) return 0;
  let depth = 0, count = 1;
  for (const ch of params) {
    if ("(<[".includes(ch)) depth++;
    else if (")>]".includes(ch)) depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

export function scanFile(src, file, lang = "csharp") {
  const { masked } = mask(src, lang);
  const types = [];
  const kw = TYPE_KEYWORDS[lang].join("|");
  const typeRe = new RegExp(`\\b(${kw})\\s+([A-Za-z_]\\w*)`, "g");

  let m;
  while ((m = typeRe.exec(masked)) !== null) {
    const declStart = m.index;
    const braceIdx = masked.indexOf("{", typeRe.lastIndex);
    if (braceIdx < 0) continue;
    const close = matchBracket(masked, braceIdx);
    if (close < 0) continue;

    const headerText = src.slice(declStart, braceIdx);
    const bases = lang === "csharp" ? parseBaseList(headerText) : parseJavaBases(headerText);

    types.push({
      file,
      kind: m[1],
      name: m[2],
      bases,
      isInterface: m[1] === "interface",
      line: lineOf(src, declStart),
      members: scanTypeBody(src, masked, braceIdx, close, lang, m[2], file),
    });

    typeRe.lastIndex = braceIdx + 1; // allow nested types to be picked up too
  }

  return { file, lang, src, masked, types };
}
