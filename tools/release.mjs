#!/usr/bin/env node
/* Stamps every ?v= cache-buster with a fingerprint of the code itself.

   Why it exists: vercel.json now lets browsers keep /js/* and /css/*
   requests that carry ?v= for a year without asking again ("immutable").
   That removes ~64 requests from every page load — but it is only safe if
   ?v= changes whenever ANY of those files change. A hand-typed timestamp
   can be forgotten; a fingerprint of the contents cannot be wrong.

     node tools/release.mjs          rewrite every ?v= to the current fingerprint
     node tools/release.mjs --check  exit 1 if any ?v= is stale or missing

   Run it after every change, before uploading. tools/check-versions.mjs
   (the --check mode) is what the test suite runs. */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const V_RE = /\?v=[0-9A-Za-z]+/g;
const PLACEHOLDER = "?v=@";

export function versionedFiles(root = ROOT) {
  const list = d => readdirSync(join(root, d)).filter(f => /\.(js|css)$/.test(f)).sort().map(f => join(d, f));
  return ["index.html", ...list("js"), ...list("css")];
}

export function fingerprint(root = ROOT) {
  const h = createHash("sha256");
  for (const f of versionedFiles(root)) {
    h.update(f + "\0");
    h.update(readFileSync(join(root, f), "utf8").replace(V_RE, PLACEHOLDER));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 10);
}

/* Every place a version must appear: relative module imports (static and
   dynamic) in js/, and the stylesheet / entry-script tags in index.html. */
export function findProblems(root = ROOT) {
  const want = fingerprint(root);
  const problems = [];
  const seen = new Set();
  for (const f of versionedFiles(root)) {
    const text = readFileSync(join(root, f), "utf8");
    const refs = [];
    if (f.endsWith(".js")) {
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])(\.\.?\/[^'"]+)\1/gm)) refs.push(m[2]);
    } else if (f === "index.html") {
      for (const m of text.matchAll(/(?:href|src)="((?:js|css)\/[^"]+)"/g)) refs.push(m[1]);
    }
    for (const r of refs) {
      const v = r.match(/\?v=([0-9A-Za-z]+)/);
      if (!/\.(js|css)(\?|$)/.test(r)) continue;
      if (!v) problems.push(`${f}: '${r}' has no ?v= — it will load a second copy of the module and skip the cache rules`);
      else { seen.add(v[1]); if (v[1] !== want) problems.push(`${f}: '${r}' is ?v=${v[1]}, expected ?v=${want}`); }
    }
  }
  return { want, problems, seen: [...seen] };
}

function release(root = ROOT) {
  const want = fingerprint(root);
  let changed = 0;
  for (const f of versionedFiles(root)) {
    const p = join(root, f);
    const text = readFileSync(p, "utf8");
    const next = text.replace(V_RE, "?v=" + want);
    if (next !== text) { writeFileSync(p, next); changed++; }
  }
  // Rewriting the stamps doesn't move the fingerprint (stamps are masked
  // out of it), so one pass always converges.
  const after = findProblems(root);
  if (after.problems.length) { console.error(after.problems.join("\n")); process.exit(1); }
  console.log(`release: ?v=${want} (${changed} file${changed === 1 ? "" : "s"} updated)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const { want, problems } = findProblems();
    if (problems.length) {
      console.error("Cache-buster check FAILED (run: node tools/release.mjs)\n  " + problems.slice(0, 30).join("\n  ") +
                    (problems.length > 30 ? `\n  …and ${problems.length - 30} more` : ""));
      process.exit(1);
    }
    console.log("cache-busters OK: ?v=" + want);
  } else release();
}
