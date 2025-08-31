// api/golfChatbotRouter.js (ESM) — proxy to your Vercel quiz API
import { Router } from "express";

const router = Router();

// Configure target (defaults to your deployed quiz API)
const RAW_BASE =
  process.env.QUIZ_BASE_URL || "https://golf-profiler-ml.vercel.app";
// normalize base (remove trailing slash)
const QUIZ_BASE_URL = RAW_BASE.replace(/\/+$/, "");

// Tunables
const TIMEOUT_MS = Number(process.env.QUIZ_TIMEOUT_MS || 12000);

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
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { raw: text }; }

    return { status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

// Health (useful for Render/Vercel checks)
router.get("/health", (_req, res) => {
  res.json({ ok: true, base: QUIZ_BASE_URL, timeout_ms: TIMEOUT_MS });
});

// Start quiz -> POST /api/chatbot/start
router.post("/start", async (req, res) => {
  try {
    const { status, data } = await proxyJson(
      "POST",
      `${QUIZ_BASE_URL}/api/chatbot-start`,
      req.body
    );
    return res.status(status).json(data);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Upstream quiz start timed out" : String(e);
    console.error("proxy /start error:", msg);
    return res.status(504).json({ error: msg });
  }
});

// Answer quiz -> POST /api/chatbot/answer
router.post("/answer", async (req, res) => {
  try {
    const { status, data } = await proxyJson(
      "POST",
      `${QUIZ_BASE_URL}/api/chatbot-answer`,
      req.body
    );
    return res.status(status).json(data);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Upstream quiz answer timed out" : String(e);
    console.error("proxy /answer error:", msg);
    return res.status(504).json({ error: msg });
  }
});

// Get specific question -> GET /api/chatbot/question/:questionId
router.get("/question/:questionId", async (req, res) => {
  try {
    const qid = encodeURIComponent(req.params.questionId || "");
    const { status, data } = await proxyJson(
      "GET",
      `${QUIZ_BASE_URL}/api/chatbot-question?questionId=${qid}`
    );
    return res.status(status).json(data);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Upstream question fetch timed out" : String(e);
    console.error("proxy /question error:", msg);
    return res.status(504).json({ error: msg });
  }
});

export default router;
