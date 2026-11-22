import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateReviews, parseReviews, shapeReviews, splitFindings, reviewCount, riskLevel, findingsTally, age, approveAsk, label, key } from "../lib/reviews.js";
import { keyAction } from "../lib/keys.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/acme-api/reviews.json", import.meta.url), "utf8"));
const copy = () => structuredClone(fixture);

test("the fixture's reviews.json passes the contract", () => {
  assert.deepEqual(validateReviews(fixture), []);
});

test("bad data is refused, one line per problem", () => {
  assert.match(validateReviews({})[0], /version/);
  const d = copy();
  d.prs[0].findings = [{ kind: "nit", text: "x" }];
  d.prs[1].evidence = "maybe";
  d.prs.push(copy().prs[0]);
  const errors = validateReviews(d);
  assert.ok(errors.some((e) => /prs\[0\].findings\[0\]/.test(e)));
  assert.ok(errors.some((e) => /prs\[1\].evidence/.test(e)));
  assert.ok(errors.some((e) => /acme\/api#88 appears twice/.test(e)));
});

test("the fast lane is the low-risk PRs, ahead of the rest, which run highest risk first", () => {
  const { fastLane, queue, all } = shapeReviews(fixture);
  assert.deepEqual(fastLane.map(key), ["acme/api#91", "acme/api#88"]);
  assert.deepEqual(queue.map(key), ["acme/api#95", "acme/web#93", "acme/api#90"]);
  assert.deepEqual(all.map(key), [...fastLane, ...queue].map(key));
});

test("equal risk goes to the PR that has waited longer; a low-risk flag beats a high score", () => {
  const d = copy();
  d.prs[3].risk.score = d.prs[4].risk.score = 50;
  assert.deepEqual(shapeReviews(d).queue.slice(1).map(key), ["acme/api#90", "acme/web#93"]);
  d.prs[2].low_risk = true; // the daemon decides low risk from config, not the score
  assert.equal(shapeReviews(d).fastLane.map(key).includes("acme/api#95"), true);
  assert.equal(riskLevel(d.prs[2]), "low");
});

test("findings split into must-fix, suggestion and noise; noise is kept", () => {
  const p = fixture.prs.find((x) => x.number === 95);
  const f = splitFindings(p);
  assert.deepEqual([f.mustFix.length, f.suggestions.length, f.noise.length], [3, 1, 4]);
  assert.equal(f.mustFix.length + f.suggestions.length + f.noise.length, p.findings.length);
  assert.equal(findingsTally(p), "3 must-fix");
  assert.equal(findingsTally(fixture.prs.find((x) => x.number === 90)), "4 suggestions");
  assert.equal(findingsTally(fixture.prs.find((x) => x.number === 88)), "no findings");
});

test("risk levels", () => {
  assert.deepEqual(fixture.prs.map(riskLevel), ["low", "low", "high", "med", "med"]);
});

test("an empty queue shapes to nothing and is valid", () => {
  const d = { ...copy(), prs: [] };
  assert.deepEqual(validateReviews(d), []);
  const s = shapeReviews(d);
  assert.deepEqual([s.fastLane, s.queue, s.all], [[], [], []]);
  assert.equal(reviewCount(d, 9), 0);
});

test("a missing reviews.json is not an error; a broken one says why", () => {
  assert.deepEqual(parseReviews(null), { doc: null, error: null, missing: true });
  assert.equal(shapeReviews(null).all.length, 0);
  assert.equal(reviewCount(null, 3), 3, "the sidebar falls back to status.json's count");
  assert.match(parseReviews("{").error, /^reviews\.json: /);
  assert.match(parseReviews("{}").error, /version/);
  assert.equal(parseReviews(JSON.stringify(fixture)).doc.prs.length, 5);
  assert.equal(reviewCount(fixture, 0), 5);
});

test("approve is for a low-risk PR with passing checks", () => {
  const [low, , high] = fixture.prs;
  assert.deepEqual(approveAsk(low).args, ["review", "approve", "acme/api#88"]);
  assert.match(approveAsk(high).error, /isn't low risk/);
  const failing = structuredClone(low);
  failing.checks[0].status = "fail";
  assert.match(approveAsk(failing).error, /failing checks/);
  assert.match(approveAsk(undefined).error, /No PR/);
});

test("labels and ages", () => {
  assert.equal(label(fixture.prs[3]), "web#93");
  const now = Date.parse("2026-11-21T10:00:00Z");
  assert.equal(age("2026-11-21T09:30:00Z", now), "30m");
  assert.equal(age("2026-11-21T07:00:00Z", now), "3h");
  assert.equal(age("2026-11-19T12:00:00Z", now), "2d");
});

test("the Reviews keys: a approves, o and s open on GitHub, h shows noise", () => {
  const k = (key) => keyAction({ key, modifiers: {} });
  assert.equal(k("a").kind, "approve");
  assert.equal(k("o").kind, "github");
  assert.equal(k("s").kind, "github");
  assert.equal(k("h").kind, "noise");
  assert.equal(k("j").delta, 1);
});
