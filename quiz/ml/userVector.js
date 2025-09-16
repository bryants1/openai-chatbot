// src/ml/userVector.js
// 10D vector helpers (0..10 scores -> 10-length vector 0..1 each)

// --- Canonical 10D order (keep in sync across the app) ---
export const DIMS10 = [
  "overall_difficulty",
  "strategic_variety",
  "penal_vs_playable",
  "physical_demands",
  "weather_adaptability",
  "conditions_quality",
  "facilities_amenities",
  "service_operations",
  "value_proposition",
  "aesthetic_appeal",
];

// --- utils ---
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Normalize a single 0..10 score into 0..1 (clamped). Returns null if missing.
 */
export function score10To01(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return clamp01(n / 10);
}

/**
 * Ensure all 10D keys exist. Fills missing with `fillValue` (0..10, default 5).
 * Mutates & returns the same object for convenience.
 */
export function validateScores10D(scores, fillValue = 5) {
  const fv = Number.isFinite(fillValue) ? fillValue : 5;
  for (const k of DIMS10) if (!(k in (scores || {}))) scores[k] = fv;
  return scores;
}

/**
 * Convert a flat {dim: 0..10} map to a 10-length Array of 0..1 (null if missing).
 * Options:
 *  - allowNull (default true): keep nulls for missing dims; if false, use 0.5
 */
export function scoresTo10D(scores = {}, { allowNull = true } = {}) {
  return DIMS10.map((k) => {
    const v01 = score10To01(scores[k]);
    return v01 == null ? (allowNull ? null : 0.5) : v01;
  });
}

/**
 * Same as scoresTo10D but returns Float32Array (nulls become 0 by default).
 * Pass { keepNull = false } to force nulls -> 0; (most vector DBs want numbers)
 */
export function scoresTo10DFloat32(scores = {}, { keepNull = false } = {}) {
  const arr = scoresTo10D(scores, { allowNull: keepNull });
  // If keepNull=false, replace nulls with 0; else convert nulls to NaN? We'll use 0.
  return Float32Array.from(arr.map((x) => (x == null ? 0 : x)));
}

/**
 * Build a 10D vector from `progress` JSON (each dim has {score, confidence,...}).
 * Uses .score (0..10) and normalizes to 0..1.
 * Options:
 *  - fallbackMid (default 0.5): value to use when a dim is missing
 *  - useConfidence (default false): if true, multiply value by confidence (0..1)
 */
export function progressTo10D(progress = {}, { fallbackMid = 0.5, useConfidence = false } = {}) {
  return DIMS10.map((k) => {
    const p = progress[k];
    if (!p || p.score == null) return fallbackMid;
    let v = score10To01(p.score);
    if (v == null) return fallbackMid;
    if (useConfidence && Number.isFinite(p.confidence)) v = v * clamp01(p.confidence);
    return v;
  });
}

/**
 * Convenience: convert a {dim:0..10} map in snake_case OR a "progress" map
 * to a normalized, **dense** Float32Array 10D (no nulls).
 *  - if `sourceType === 'progress'`, expects the progress shape
 */
export function toDense10DFloat32(input = {}, { sourceType = "scores" } = {}) {
  if (sourceType === "progress") {
    return Float32Array.from(progressTo10D(input, { fallbackMid: 0.5, useConfidence: false }));
  }
  return scoresTo10DFloat32(input, { keepNull: false });
}

// ---------------------------------------------------------------------------
// Optional: a tiny descriptor you can use for observability / logging
export const VECTOR_MAPPING_10D = [
  "overall_difficulty (OD)",
  "strategic_variety (SV)",
  "penal_vs_playable (PV)",
  "physical_demands (PD)",
  "weather_adaptability (WA)",
  "conditions_quality (CQ)",
  "facilities_amenities (FA)",
  "service_operations (SO)",
  "value_proposition (VP)",
  "aesthetic_appeal (AA)",
];

// ---------------------------------------------------------------------------
// Back-compat shims (if something still imports the old name):
export const userScoresTo10D = scoresTo10D;
