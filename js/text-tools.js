/* Lightweight writing tools for any textarea: markdown-style formatting
   shortcuts (bold, italic, lists) and a free grammar/spelling check via
   LanguageTool's public API (no signup, no key — same "free, best-effort
   community service" nature as the geocoding and routing already used
   elsewhere in LifeOS; see languagetool.org). */

export function wrapSelection(textarea, before, after) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  const val = textarea.value;
  const selected = val.slice(start, end) || "text";
  textarea.value = val.slice(0, start) + before + selected + after + val.slice(end);
  const cursor = start + before.length;
  textarea.focus();
  textarea.setSelectionRange(cursor, cursor + selected.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export function prefixLines(textarea, makePrefix) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  const val = textarea.value;
  let lineStart = val.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = val.indexOf("\n", end); if (lineEnd === -1) lineEnd = val.length;
  const block = val.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const prefixed = lines.map((line, i) => makePrefix(i) + line).join("\n");
  textarea.value = val.slice(0, lineStart) + prefixed + val.slice(lineEnd);
  textarea.focus();
  textarea.setSelectionRange(lineStart, lineStart + prefixed.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/* Returns [{message, offset, length, replacements: [string,...], original}]
   or null if the check couldn't be completed (offline, service unavailable). */
export async function checkGrammar(text) {
  if (!text || !text.trim()) return [];
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const res = await fetch("https://api.languagetool.org/v2/check", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "text=" + encodeURIComponent(text) + "&language=en-US",
      signal: controller.signal
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.matches || []).map(m => ({
      message: m.message,
      offset: m.offset,
      length: m.length,
      replacements: (m.replacements || []).slice(0, 3).map(r => r.value),
      original: text.substr(m.offset, m.length)
    }));
  } catch (e) { return null; }
}
