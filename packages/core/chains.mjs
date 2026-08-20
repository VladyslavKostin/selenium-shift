/**
 * Call-chain extraction and fingerprinting.
 *
 * A "chain" is a receiver-rooted expression such as
 *     driver.FindElement(By.Id("submit")).Click()
 *
 * Its "fingerprint" is that chain with everything incidental erased:
 *     $R.FindElement(By.Id($STR)).Click()
 *
 * Fingerprinting is the whole trick. A 60k-line Selenium suite holds tens of
 * thousands of call sites but only a few dozen distinct fingerprints, because
 * the same handful of idioms repeat with different values in them. Decide once
 * per fingerprint, replay everywhere — that is what keeps token cost flat as
 * the suite grows.
 *
 * Normalisation is recursive rather than regex-driven, because arguments nest:
 * `Until(d => d.FindElement(locator).Displayed)` has to collapse as a unit, and
 * a regex that stops at the first `)` mangles it.
 *
 * Argument classes, in decreasing specificity:
 *   $STR    string literal             "submit"
 *   $NUM    numeric literal            5000
 *   $LAMBDA anything containing =>     d => d.Displayed
 *   $ARG    plain identifier path      user, this.timeout
 *   $EXPR   any other compound         "//tr[" + i + "]"
 *
 * Arguments rooted at a meaningful type (By, ExpectedConditions, Keys...) are
 * recursed into rather than collapsed, because that structure is what the
 * mapping rules key on.
 */

import { mask, matchBracket } from "./masker.mjs";

/** Roots that carry meaning and must survive normalisation. */
const SIGNIFICANT_ROOTS = new Set([
  "By", "ExpectedConditions", "Assert", "Assertions", "Thread", "TimeSpan",
  "Duration", "Keys", "Actions", "Select", "SelectElement", "WebDriverWait",
  "FluentWait", "JavascriptExecutor", "PageFactory", "Cookie", "OutputType",
]);

/** Language keywords that must never be treated as a chain receiver. */
const KEYWORDS = new Set([
  "if", "else", "for", "foreach", "while", "do", "switch", "case", "return",
  "using", "catch", "try", "finally", "lock", "throw", "yield", "in", "is",
  "as", "out", "ref", "var", "await", "async", "public", "private", "protected",
  "internal", "static", "readonly", "const", "class", "interface", "struct",
  "namespace", "get", "set", "this", "base", "typeof", "sizeof", "default",
  "null", "true", "false", "void", "int", "string", "bool", "double", "float",
  "long", "short", "byte", "char", "decimal", "object", "final", "import",
  "package", "extends", "implements", "throws", "super", "instanceof",
]);

/** Members that mean "this chain touches Selenium". Both casings included. */
export const SELENIUM_SURFACE = new Set([
  "FindElement", "findElement", "FindElements", "findElements",
  "By", "PageFactory", "FindsBy", "FindBy", "CacheLookup",
  "SendKeys", "sendKeys", "Click", "click", "Clear", "clear", "Submit", "submit",
  "MoveToElement", "moveToElement", "DragAndDrop", "dragAndDrop",
  "ContextClick", "contextClick", "DoubleClick", "doubleClick", "Perform", "perform",
  "Displayed", "isDisplayed", "Enabled", "isEnabled", "Selected", "isSelected",
  "GetAttribute", "getAttribute", "GetCssValue", "getCssValue",
  "Text", "getText", "TagName", "getTagName",
  "WebDriverWait", "FluentWait", "Until", "until", "ExpectedConditions",
  "ImplicitlyWait", "implicitlyWait", "ImplicitWait", "PageLoadTimeout",
  "pageLoadTimeout", "Sleep", "sleep", "Timeouts", "SetScriptTimeout",
  "Navigate", "navigate", "GoToUrl", "Url", "getCurrentUrl",
  "Title", "getTitle", "Back", "Forward", "Refresh", "refresh",
  "Quit", "quit", "Close", "Dispose",
  "SwitchTo", "switchTo", "Frame", "frame", "DefaultContent", "defaultContent",
  "Alert", "alert", "Accept", "Dismiss", "dismiss",
  "Maximize", "maximize", "WindowHandles", "getWindowHandles",
  "ExecuteScript", "executeScript", "ExecuteAsyncScript", "executeAsyncScript",
  "GetScreenshot", "getScreenshotAs", "SaveAsFile",
  "SelectByValue", "selectByValue", "SelectByText", "selectByVisibleText",
  "SelectByIndex", "selectByIndex", "DeselectAll", "deselectAll",
  "Manage", "manage", "Cookies", "AddCookie", "addCookie", "DeleteAllCookies",
  "get",
]);

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const isIdentStart = (ch) => ch !== undefined && IDENT_START.test(ch);
const isIdentChar = (ch) => ch !== undefined && IDENT_CHAR.test(ch);

/**
 * Find receiver-rooted chains inside [from, to) of a masked buffer.
 * Offsets returned are absolute into the source.
 */
export function extractChains(src, masked, from, to) {
  const chains = [];
  let i = from;

  while (i < to) {
    if (!isIdentStart(masked[i])) { i++; continue; }

    const prev = masked[i - 1];
    if (prev === "." || isIdentChar(prev)) {
      while (i < to && isIdentChar(masked[i])) i++;
      continue;
    }

    const start = i;
    while (i < to && isIdentChar(masked[i])) i++;
    const word = masked.slice(start, i);

    // `new Foo(...)` — keep `new` attached, continue from the type name.
    if (word === "new") {
      let j = i;
      while (j < to && /\s/.test(masked[j])) j++;
      if (!isIdentStart(masked[j])) continue;
      let k = j;
      while (k < to && isIdentChar(masked[k])) k++;
      i = k;
    } else if (KEYWORDS.has(word)) {
      continue;
    }

    let end = i;
    let sawCall = false;
    let sawDot = false;

    for (;;) {
      let j = end;
      while (j < to && /\s/.test(masked[j])) j++;
      const ch = masked[j];

      if (ch === "(" || ch === "[") {
        const close = matchBracket(masked, j);
        if (close < 0 || close >= to) break;
        if (ch === "(") sawCall = true;
        end = close + 1;
        continue;
      }
      if (ch === ".") {
        let k = j + 1;
        while (k < to && /\s/.test(masked[k])) k++;
        if (!isIdentStart(masked[k])) break;
        while (k < to && isIdentChar(masked[k])) k++;
        sawDot = true;
        end = k;
        continue;
      }
      break;
    }

    if (sawCall || sawDot) chains.push({ start, end, text: src.slice(start, end) });
    i = end;
  }

  return chains;
}

/** True if the chain mentions anything from the Selenium surface. */
export function touchesSelenium(chainText) {
  const parts = chainText.match(/[A-Za-z_]\w*/g) || [];
  return parts.some((p) => SELENIUM_SURFACE.has(p));
}

/** Split an argument list on top-level commas. */
function splitArgs(text, masked) {
  const args = [];
  let depth = 0, start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      args.push({ text: text.slice(start, i), masked: masked.slice(start, i) });
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) {
    args.push({ text: text.slice(start), masked: masked.slice(start) });
  }
  return args;
}

// Tested against the MASKED text, where a literal's contents are \u0001.
// Testing the raw text would let `"a" + x + "b"` pass as one literal.
const LITERAL_STR = /^\s*@?"\u0001*"\s*$|^\s*'\u0001*'\s*$/;
const LITERAL_NUM = /^\s*-?\d[\d._]*[dfmLulDFML]?\s*$/;
const IDENT_PATH = /^\s*[A-Za-z_]\w*(\s*\.\s*[A-Za-z_]\w*)*\s*$/;

function classifyArg(text, masked, literals) {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // A top-level lambda collapses the whole argument.
  let depth = 0;
  for (let i = 0; i < masked.length - 1; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "=" && masked[i + 1] === ">") return "$LAMBDA";
  }

  if (LITERAL_STR.test(masked)) { literals.push(trimmed); return "$STR"; }
  if (LITERAL_NUM.test(trimmed)) { literals.push(trimmed); return "$NUM"; }

  // Rooted at a meaningful type? Keep the structure — rules key on it.
  const root = /^\s*(?:new\s+)?([A-Za-z_]\w*)/.exec(trimmed);
  if (root && SIGNIFICANT_ROOTS.has(root[1])) {
    return normalise(trimmed, mask(trimmed, "csharp").masked, literals, true);
  }

  if (IDENT_PATH.test(trimmed)) return "$ARG";
  return "$EXPR";
}

/** Recursively normalise a chain expression. */
function normalise(text, masked, literals, keepRoot = false) {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const c = masked[i];

    if (c === "(" || c === "[") {
      const close = matchBracket(masked, i);
      if (close < 0) { out += text[i]; i++; continue; }
      const inner = text.slice(i + 1, close);
      const innerMasked = masked.slice(i + 1, close);
      const args = splitArgs(inner, innerMasked)
        .map((a) => classifyArg(a.text, a.masked, literals))
        .filter((s) => s !== "");
      out += c === "(" ? `(${args.join(", ")})` : `[${args.join(", ")}]`;
      i = close + 1;
      continue;
    }

    if (/\s/.test(c)) {
      if (out.length && !/\s$/.test(out)) out += " ";
      i++;
      continue;
    }

    out += text[i];
    i++;
  }

  out = out.replace(/\s*\.\s*/g, ".").replace(/\s+/g, " ").trim();

  if (!keepRoot) {
    const rootMatch = /^(new\s+)?([A-Za-z_]\w*)/.exec(out);
    if (rootMatch && !SIGNIFICANT_ROOTS.has(rootMatch[2])) {
      out = (rootMatch[1] || "") + "$R" + out.slice(rootMatch[0].length);
    }
  }

  return out;
}

export function fingerprint(chainText) {
  const literals = [];
  const { masked } = mask(chainText, "csharp");
  return { fingerprint: normalise(chainText, masked, literals), literals };
}
