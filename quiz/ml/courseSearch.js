// src/ml/courseSearch.js (ESM)
// Search for courses using your 10D user vector, optionally geo-filtered.

import { scoresTo10DArray } from "./userVector.js"; // <- uses your 10D DIM_ORDER
import { QdrantClient } from "@qdrant/js-client-rest";

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
 * Get Qdrant client directly
 */
function getQdrantClient() {
  const url = process.env.COURSE_QDRANT_URL;
  const apiKey = process.env.COURSE_QDRANT_API_KEY || "";
  
  if (!url) {
    throw new Error("COURSE_QDRANT_URL not configured");
  }
  
  return new QdrantClient({ url, apiKey });
}

/**
 * Main search function.
 * @param {Object} scores   // 10D object with 0..10 values (or partial)
 * @param {SearchOptions=} options
 * @returns {Promise<Array<{course_id?:string, name:string, url:string|null, score:number, distance?:number, payload?:any}>>}
 */
export async function searchCourses(scores, options = {}) {
  const qdrant = getQdrantClient();
  const body = buildRequestBody(scores, options);
  const collection = process.env.COURSE_QDRANT_COLLECTION || "10d_golf_courses";
  
  let searchParams = {
    vector: body.vector,
    limit: body.limit,
    with_payload: true,
    with_vectors: false
  };

  // Add geo filtering if coordinates provided
  if (body.lat !== undefined && body.lon !== undefined) {
    const geoRadius = body.radius || 50000; // default 50km in meters
    searchParams.filter = {
      must: [{
        key: "payload.location",
        geo_radius: {
          center: { lat: Number(body.lat), lon: Number(body.lon) },
          radius: geoRadius
        }
      }]
    };
  }

  const results = await qdrant.search(collection, searchParams);
  return normalizeResults({ result: results || [] });
}

/**
 * Convenience wrapper when you only want the top N courses (no geo).
 * @param {Object} scores
 * @param {number=} topK
 */
export async function topCourses(scores, topK = 8) {
  return searchCourses(scores, { topK });
}
