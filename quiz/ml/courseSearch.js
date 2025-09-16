// src/ml/courseSearch.js (ESM)
// Search for courses using your 10D user vector, optionally geo-filtered.

import { scoresTo10DArray } from "./userVector.js"; // <- uses your 10D DIM_ORDER

/**
 * @typedef {Object} Location
 * @property {{lat:number, lon:number}=} coords
 * @property {number=} radius  // miles; converted to meters for the API
 */

/**
 * @typedef {Object} SearchOptions
 * @property {number=} topK            // default 8
 * @property {Location=} location      // { coords:{lat,lon}, radius(miles) }
 * @property {string=}  endpoint       // override POST URL for qdrant search
 */

/**
 * Convert the 10D vector to a plain array and build the request body.
 */
function buildRequestBody(scores, { topK = 8, location } = {}) {
  // scoresTo10DArray returns a 10-length array of 0..1 (or nulls)
  // We keep nulls so your backend can decide how to treat unknown dims.
  const vector10 = scoresTo10DArray(scores, { keepNull: true });

  const body = {
    vector: vector10,
    limit: Math.max(1, Math.min(100, topK)), // simple guard
  };

  if (location?.coords) {
    body.lat = Number(location.coords.lat);
    body.lon = Number(location.coords.lon);
    if (location.radius != null) {
      // miles -> meters (Qdrant side/your API expects meters)
      body.radius = Number(location.radius) * 1609.34;
    }
  }

  return body;
}

/**
 * Normalize the response points into a simple course array.
 */
function normalizeResults(apiResult) {
  const rows = Array.isArray(apiResult?.result) ? apiResult.result : [];
  return rows.map((pt) => ({
    course_id: pt.payload?.course_id,
    name: pt.payload?.course_name || pt.payload?.name || "Course",
    url:
      pt.payload?.course_url ||
      pt.payload?.website ||
      null,
    score: pt.score,
    distance: pt.distance, // your API sometimes returns this if geo-filtered
    payload: pt.payload,
  }));
}

/**
 * Resolve the endpoint to call:
 * - Prefer explicit options.endpoint
 * - Then env QDRANT_SEARCH_URL (your serverless aggregator)
 * - Finally fallback to your Vercel function used earlier
 */
function resolveEndpoint(overrideEndpoint) {
  if (overrideEndpoint) return overrideEndpoint.trim();
  if (process.env.QDRANT_SEARCH_URL) return process.env.QDRANT_SEARCH_URL.trim();

  // Fallback to your existing deployed function that proxies Qdrant
  return "https://golf-profiler-ml.vercel.app/api/qdrant-search";
}

/**
 * Main search function.
 * @param {Object} scores   // 10D object with 0..10 values (or partial)
 * @param {SearchOptions=} options
 * @returns {Promise<Array<{course_id?:string, name:string, url:string|null, score:number, distance?:number, payload?:any}>>}
 */
export async function searchCourses(scores, options = {}) {
  const endpoint = resolveEndpoint(options.endpoint);
  const body = buildRequestBody(scores, options);

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    // Surface a concise error with a short body preview
    const txt = await r.text().catch(() => "");
    throw new Error(`qdrant-search failed: HTTP ${r.status} – ${txt.slice(0, 200)}`);
  }

  const data = await r.json().catch(() => ({}));
  return normalizeResults(data);
}

/**
 * Convenience wrapper when you only want the top N courses (no geo).
 * @param {Object} scores
 * @param {number=} topK
 */
export async function topCourses(scores, topK = 8) {
  return searchCourses(scores, { topK });
}
