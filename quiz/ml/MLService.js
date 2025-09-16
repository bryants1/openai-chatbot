// src/ml/MLService.js — ultra-slim: question engine + scores + course matching only

import { createClient } from "@supabase/supabase-js";

// Optional Supabase (unused by core logic; safe to keep for future)
function makeSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.REACT_APP_SUPABASE_URL ||
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.REACT_APP_SUPABASE_ANON_KEY ||
    "";
  if (!url || !key) return null;
  try { return createClient(url, key); } catch { return null; }
}
const supabase = makeSupabase();

// Canonical 10D keys
export const DIMS10 = [
  "overall_difficulty","strategic_variety","penal_vs_playable","physical_demands",
  "weather_adaptability","conditions_quality","facilities_amenities",
  "service_operations","value_proposition","aesthetic_appeal"
];

// Normalize any dict → 0..10 on the known 10D
function norm10(scores = {}) {
  const out = {};
  for (const k of DIMS10) {
    const n = Number(scores[k]);
    out[k] = Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0;
  }
  return out;
}

// 0..10 → 0..1/null vector in order
export function scoresTo10DVector(scores = {}) {
  return DIMS10.map((k) => {
    const n = Number(scores[k]);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 10)) : null;
  });
}

export default class MLService {
  constructor(opts = {}) {
    this.opts = opts;
    this.isInitialized = false;
    this.modelVersion = "slim-qa-1";
  }

  async initialize() {
    // Nothing to load in slim mode
    this.isInitialized = true;
    return true;
  }

  /**
   * Aggregate answer rawScores (0..1 per dim) → canonical 10D scores (0..10).
   * answers: { QID: { rawScores: { overall_difficulty: 0..1, ... } } }
   */
  async calculateScores(answers = {}) {
    const votes = {};
    const counts = {};
    for (const a of Object.values(answers || {})) {
      const raw = a?.rawScores || {};
      for (const [dim, v01] of Object.entries(raw)) {
        if (!DIMS10.includes(dim)) continue;
        const v = Number(v01);
        if (!Number.isFinite(v)) continue;
        votes[dim]  = (votes[dim]  ?? 0) + v;
        counts[dim] = (counts[dim] ?? 0) + 1;
      }
    }
    const out = {};
    for (const k of DIMS10) {
      out[k] = counts[k] ? (votes[k] / counts[k]) * 10 : 0; // 0..10
    }
    return out;
  }

  /**
   * Pick next MC question:
   *  - exclude already-answered
   *  - prefer higher priority
   *  - boost questions that touch under-covered dims
   */
  async selectNextQuestion(currentAnswers = {}, currentScores = {}, questionBank = [], _n = 0, _ctx = {}) {
    const answered = new Set(Object.keys(currentAnswers || {}));
    const cands = (questionBank || []).filter(
      (q) => !answered.has(q.id) && Array.isArray(q.options) && q.options.length > 0
    );
    if (!cands.length) return null;

    const coverage = {};
    for (const k of DIMS10) {
      const v = Number(currentScores[k] || 0);
      // buckets: 0 (uncovered) .. 3 (well covered)
      coverage[k] = v >= 7 ? 3 : v >= 5 ? 2 : v > 0 ? 1 : 0;
    }

    const scored = cands
      .map((q) => {
        let s = Number(q.priority || 0);
        const dims = new Set();
        for (const o of q.options || []) {
          const raw = o?.scores || {};
          for (const d of Object.keys(raw)) if (DIMS10.includes(d)) dims.add(d);
        }
        // boost under-covered dims
        for (const d of dims) {
          if (coverage[d] === 0) s += 10;
          else if (coverage[d] === 1) s += 5;
        }
        return { q, s };
      })
      .sort((a, b) => b.s - a.s);

    return scored[0].q;
  }

  /**
   * Minimal "profile": just 10D scores + optional location metadata.
   * (No archetype / no recommendations.)
   */
  async generateProfile(finalAnswers, finalScores, _sessionId, _ml, location) {
    const scores10d = norm10(finalScores);
    return {
      scores10d,
      searchLocation: location
        ? {
            zipCode: location.zipCode ?? null,
            city:    location.city    ?? null,
            state:   location.state   ?? null,
            radius:  location.radius  ?? null,
          }
        : null,
    };
  }

  /**
   * Course matching via your qdrant-search endpoint.
   * Accepts 10D dict; sends normalized 10D vector to service.
   */
  async getCourseMatchesBy5D(scores = {}, options = {}) {
    try {
      const vec10 = scoresTo10DVector(norm10(scores));
      const body = {
        vector: vec10,
        limit: options.topK || 8,
      };
      if (options?.location?.coords) {
        body.lat = options.location.coords.lat;
        body.lon = options.location.coords.lon;
        if (options.location.radius) body.radius = options.location.radius * 1609.34;
      }
      const r = await fetch("https://golf-profiler-ml.vercel.app/api/qdrant-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.result || []).map((x) => ({
        course_id: x.payload?.course_id,
        name:      x.payload?.course_name || x.payload?.name || "Course",
        url:       x.payload?.course_url  || x.payload?.website || null,
        score:     x.score,
        distance:  x.distance,
        payload:   x.payload,
      }));
    } catch {
      return [];
    }
  }

  healthCheck() {
    return { initialized: this.isInitialized, version: this.modelVersion };
  }
}
