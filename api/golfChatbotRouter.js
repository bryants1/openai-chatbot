// api/golfChatbotRouter.js (ESM) — proxy to your Vercel quiz API
import { Router } from "express";

const router = Router();

// Configure target (defaults to your deployed quiz API)
const RAW_BASE = process.env.QUIZ_BASE_URL || "https://golf-profiler-ml.vercel.app";
// normalize base (remove trailing slash)
const QUIZ_BASE_URL = RAW_BASE.replace(/\/+$/, "");

// Tunables
const TIMEOUT_MS = Number(process.env.QUIZ_TIMEOUT_MS || 15000);

// Shared proxy helper (supports POST/GET, JSON body, timeout)
async function proxyJson(method, url, bodyObj) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(bodyObj || {}) : undefined,
      signal: controller.signal,
      redirect: "follow"
    });

    // Try to parse JSON; if it fails, surface raw text
    let data;
    const text = await r.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    return { status: r.status, data };
  } catch (e) {
    if (e?.name === "AbortError") {
      throw e; // Re-throw to handle timeout specifically
    }
    throw new Error(`Fetch failed: ${e?.message || e}`);
  } finally {
    clearTimeout(t);
  }
}

// Helper to try multiple endpoint patterns
async function tryMultipleEndpoints(endpoints, method, body) {
  let lastError = null;

  for (const url of endpoints) {
    try {
      console.log(`Trying ${method} ${url}`);
      const result = await proxyJson(method, url, body);

      // If we got a successful response, return it
      if (result.status >= 200 && result.status < 300) {
        return result;
      }

      // If we got a 4xx error (client error), it means the endpoint exists but request is bad
      if (result.status >= 400 && result.status < 500) {
        return result; // Return the error response
      }

      // For 5xx errors, try next endpoint
      lastError = new Error(`HTTP ${result.status}`);
    } catch (e) {
      lastError = e;
      console.error(`Failed ${url}:`, e?.message);
      // Continue to next endpoint
    }
  }

  // If all endpoints failed, throw the last error
  throw lastError || new Error("All endpoints failed");
}

// ----------------------- Routes -----------------------

// Health (useful for Render/Vercel checks)
router.get("/health", (_req, res) => {
  res.json({ ok: true, base: QUIZ_BASE_URL, timeout_ms: TIMEOUT_MS });
});

// Start quiz -> POST /api/chatbot/start
router.post("/start", async (req, res) => {
  try {
    const endpoints = [
      `${QUIZ_BASE_URL}/api/chatbot-start`,
      `${QUIZ_BASE_URL}/api/chatbot/start` // Try both patterns
    ];

    const result = await tryMultipleEndpoints(endpoints, "POST", req.body);
    return res.status(result.status).json(result.data);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Upstream quiz start timed out" : String(e?.message || e);
    console.error("proxy /start error:", msg);
    return res.status(504).json({ error: msg });
  }
});

// Answer quiz -> POST /api/chatbot/answer
router.post("/answer", async (req, res) => {
  try {
    const endpoints = [
      `${QUIZ_BASE_URL}/api/chatbot-answer`,
      `${QUIZ_BASE_URL}/api/chatbot/answer`
    ];

    const result = await tryMultipleEndpoints(endpoints, "POST", req.body);
    return res.status(result.status).json(result.data);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Upstream quiz answer timed out" : String(e?.message || e);
    console.error("proxy /answer error:", msg);
    return res.status(504).json({ error: msg });
  }
});

// Get specific question -> GET /api/chatbot/question/:questionId
router.get("/question/:questionId", async (req, res) => {
  try {
    const qid = encodeURIComponent(req.params.questionId || "");
    const endpoints = [
      `${QUIZ_BASE_URL}/api/chatbot-question?questionId=${qid}`,
      `${QUIZ_BASE_URL}/api/chatbot/question/${qid}`
    ];

    const result = await tryMultipleEndpoints(endpoints, "GET", null);
    return res.status(result.status).json(result.data);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Upstream question fetch timed out" : String(e?.message || e);
    console.error("proxy /question error:", msg);
    return res.status(504).json({ error: msg });
  }
});

// Finish quiz -> POST /api/chatbot/finish
router.post("/finish", async (req, res) => {
  try {
    const endpoints = [
      `${QUIZ_BASE_URL}/api/chatbot-finish`,
      `${QUIZ_BASE_URL}/api/chatbot/finish`
    ];

    const result = await tryMultipleEndpoints(endpoints, "POST", req.body);
    return res.status(result.status).json(result.data);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Upstream quiz finish timed out" : String(e?.message || e);
    console.error("proxy /finish error:", msg);
    return res.status(504).json({ error: msg });
  }
});

// Feedback -> POST /api/chatbot/feedback
router.post("/feedback", async (req, res) => {
  try {
    const endpoints = [
      `${QUIZ_BASE_URL}/api/chatbot-feedback`,
      `${QUIZ_BASE_URL}/api/chatbot/feedback`
    ];

    const result = await tryMultipleEndpoints(endpoints, "POST", req.body);
    return res.status(result.status).json(result.data);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Upstream feedback timed out" : String(e?.message || e);
    console.error("proxy /feedback error:", msg);
    return res.status(504).json({ error: msg });
  }
});

export default router;
