// api/golfChatbotRouter.js (ESM) — proxy to your Vercel quiz API
import { Router } from "express";

const router = Router();

// Set this to your deployed quiz base (or keep the default)
const QUIZ_BASE_URL =
  process.env.QUIZ_BASE_URL || "https://golf-profiler-ml.vercel.app";

// Start quiz -> POST /api/chatbot/start
router.post("/start", async (req, res) => {
  try {
    const r = await fetch(`${QUIZ_BASE_URL}/api/chatbot-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {})
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("proxy /start error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

// Answer quiz -> POST /api/chatbot/answer
router.post("/answer", async (req, res) => {
  try {
    const r = await fetch(`${QUIZ_BASE_URL}/api/chatbot-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {})
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("proxy /answer error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

// Get specific question -> GET /api/chatbot/question/:questionId
router.get("/question/:questionId", async (req, res) => {
  try {
    const qid = encodeURIComponent(req.params.questionId || "");
    const r = await fetch(`${QUIZ_BASE_URL}/api/chatbot-question?questionId=${qid}`);
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("proxy /question error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

export default router;
