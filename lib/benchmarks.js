// benchmarks.json (daemon/bench.ts writes it, beside status.json): the latest report per
// suite, for Metrics → Benchmarks, and the same words as BENCHMARK.md.
import { compact } from "./model.js";

const NUMS = ["runs", "passed", "errors", "skipped", "pass_rate", "tokens_in", "tokens_out", "usd", "minutes", "diff_lines", "pr_lines"];

export function validateBenchmarks(doc) {
  if (!doc || !Array.isArray(doc.suites)) return ["needs {suites: []}"];
  const errors = [];
  doc.suites.forEach((s, i) => {
    const bad = (m) => errors.push(`suites[${i}]: ${m}`);
    for (const k of ["name", "target", "size", "repo", "started_at"]) if (typeof s?.[k] !== "string" || !s[k]) bad(`needs ${k}`);
    for (const k of ["tasks", "spent_usd"]) if (typeof s?.[k] !== "number") bad(`needs a number for ${k}`);
    if (!Array.isArray(s?.variants) || !s.variants.length) return bad("needs variants");
    s.variants.forEach((v, j) => {
      if (typeof v?.name !== "string") errors.push(`suites[${i}].variants[${j}]: needs name`);
      for (const k of NUMS) if (typeof v?.[k] !== "number") errors.push(`suites[${i}].variants[${j}]: needs a number for ${k}`);
    });
    if (s.winner != null && !s.variants.some((v) => v.name === s.winner)) bad(`winner "${s.winner}" is not a variant`);
  });
  return errors;
}

const usd = (n) => `$${n.toFixed(2)}`;
export const percent = (n) => `${Math.round(n * 100)}%`;
const mins = (m) => (m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m.toFixed(1)}m`);

export const COLUMNS = ["Variant", "Pass rate", "Tokens in / out", "Cost", "Minutes", "Diff lines"];

// One table row per variant, as text; `best` marks the winner's.
export function variantRows(suite) {
  return suite.variants.map((v) => ({
    best: v.name === suite.winner,
    cells: [
      v.name, v.runs ? `${percent(v.pass_rate)} (${v.passed}/${v.runs})` : "–",
      v.runs ? `${compact(v.tokens_in)} / ${compact(v.tokens_out)}` : "–", v.runs ? usd(v.usd) : "–",
      v.runs ? mins(v.minutes) : "–", v.runs ? `${Math.round(v.diff_lines)} vs ${Math.round(v.pr_lines)}` : "–",
    ],
  }));
}

export const suiteNote = (s) => [
  `${s.tasks} tasks from ${s.repo}, ${s.size}, spent ${usd(s.spent_usd)}`,
  s.stopped === "cap" ? "stopped at its spending cap; the remaining runs were skipped" : "",
].filter(Boolean).join("; ");

// "Whole-ticket averages per task": the numbers in a row are means over its scored runs.
export function benchmarkMarkdown(doc) {
  if (!doc.suites.length) return "# Benchmarks\n\nNo benchmark has run yet. `factory bench <name>` runs one from `.factory/benchmarks/`.\n";
  const out = ["# Benchmarks", "", `Each row is the mean per task. A winner is a recommendation: if you agree, change \`.factory/\` yourself.`];
  for (const s of doc.suites) {
    out.push("", `## ${s.name}`, "", `Target: ${s.target}. ${suiteNote(s)}.`, "",
      `| ${COLUMNS.join(" | ")} |`, `|${COLUMNS.map(() => " --- ").join("|")}|`);
    for (const r of variantRows(s)) out.push(`| ${r.cells.map((c, i) => (i === 0 && r.best ? `**${c}** (recommended)` : c)).join(" | ")} |`);
    out.push("", s.recommendation ?? "No recommendation: a comparison needs two variants with scored runs.");
    const noisy = s.variants.filter((v) => v.errors || v.skipped);
    if (noisy.length) out.push("", noisy.map((v) => `${v.name}: ${[v.errors && `${v.errors} could not run`, v.skipped && `${v.skipped} skipped`].filter(Boolean).join(", ")}`).join("; ") + ".");
  }
  return out.join("\n") + "\n";
}
