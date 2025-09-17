// server.js
// ── .env loader FIRST - before any other imports ─────────────────────────
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { QdrantClient } from "@qdrant/js-client-rest";
import { createClient } from '@supabase/supabase-js';

// Always load .env that sits next to this file (server.js), not CWD
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, ".env");

// Optional: tell yourself which .env we tried to use
if (!fs.existsSync(ENV_PATH)) {
  console.error(`[env] No .env found at ${ENV_PATH}`);
} else {
  console.log(`[env] Loading .env from ${ENV_PATH}`);
}

// LOAD ENV FIRST
dotenv.config({ path: ENV_PATH, override: true });

// Debug env vars
console.log("[debug] QDRANT_URL =", process.env.QDRANT_URL ? "loaded" : "MISSING");
console.log("[debug] COURSE_QDRANT_URL =", process.env.COURSE_QDRANT_URL ? "loaded" : "MISSING");
console.log("[debug] QDRANT_COLLECTION =", process.env.QDRANT_COLLECTION || "not set");
console.log("[debug] SUPABASE_URL =", process.env.SUPABASE_URL ? "loaded" : "MISSING");
console.log("[debug] SUPABASE_SERVICE_ROLE_KEY =", process.env.SUPABASE_SERVICE_ROLE_KEY ? "loaded" : "MISSING");

// Mask for safe logging
const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})` : "undefined");
console.log("[env] OPENAI_API_KEY =", mask(process.env.OPENAI_API_KEY || ""));

// Fail fast with helpful messages if keys are missing
if (!process.env.OPENAI_API_KEY) {
  console.error(
    `[env] Missing OPENAI_API_KEY. Expected it in ${ENV_PATH}. ` +
    `If you set an OS-level OPENAI_API_KEY, remove it or rename to avoid conflicts.`
  );
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    `[env] Missing Supabase credentials. Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ${ENV_PATH}`
  );
  process.exit(1);
}

// ── Setup clients AFTER env is loaded ─────────────────────────────────
import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

console.log(`[openai] OpenAI client initialized with key prefix: ${process.env.OPENAI_API_KEY.slice(0, 6)}…`);

// Setup Qdrant clients
export const siteQdrant = process.env.QDRANT_URL ? new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY || ""
}) : null;

export const courseQdrant = process.env.COURSE_QDRANT_URL ? new QdrantClient({
  url: process.env.COURSE_QDRANT_URL,
  apiKey: process.env.COURSE_QDRANT_API_KEY || ""
}) : null;

console.log(`[qdrant] Site client: ${siteQdrant ? 'initialized' : 'disabled'}`);
console.log(`[qdrant] Course client: ${courseQdrant ? 'initialized' : 'disabled'}`);

// Setup Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log(`[supabase] Client initialized`);

// ── Rest of server setup ───────────────────────────────────────────────
import express from "express";
import cors from "cors";
import chatRouter from "./routes/chat.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Main chat interface
app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Golf Course Assistant</title>
<style>
  :root{--bg:#fafafa;--fg:#222;--muted:#777;--card:#fff;--border:#e5e5e5;--accent:#0a7}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
  .wrap{max-width:1100px;margin:24px auto;padding:0 16px;display:grid;grid-template-columns:2fr 1fr;gap:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:4px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
  .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  h1{margin:0;font-size:18px;font-weight:700;color:var(--fg);background:linear-gradient(135deg, var(--accent), var(--accent-hover));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .reset-btn{padding:8px 16px;border:1px solid #dc3545;background:#fff;color:#dc3545;border-radius:4px;cursor:pointer;font-size:14px;font-weight:600;transition:all 0.2s ease}
  .reset-btn:hover{background:#dc3545;color:white}
  .muted{color:var(--muted);font-size:14px}
  .row{display:flex;gap:8px;margin-top:10px}
  textarea{width:100%;min-height:60px;padding:12px;border:1px solid var(--border);border-radius:10px;resize:vertical}
  button{padding:10px 16px;border-radius:10px;border:1px solid var(--accent);background:#fff;color:var(--accent);cursor:pointer;font-weight:600;transition:all 0.2s ease;min-width:80px}
  button:hover{background:#f2fffb}
  .msg{padding:10px 12px;border-radius:10px;margin:8px 0;white-space:pre-wrap}
  .me{background:#e9f7ff}
  .bot{background:#f7f7f7}
  .status{padding:8px;margin:8px 0;border-radius:6px;font-size:14px}
  .status.error{background:#ffe6e6;color:#d32f2f}
  .status.success{background:#e8f5e8;color:#2e7d32}
  .quick-btn{padding:12px 16px;border:1px solid var(--border);border-radius:6px;background:#fff;color:#2c3e50;text-align:left;font-size:14px;cursor:pointer;transition:all 0.2s;font-weight:500}
  .quick-btn:hover{background:#f8f9fa;border-color:var(--accent)}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="header">
        <h1>Golf Course Assistant</h1>
        <button class="reset-btn" onclick="resetSession()">Reset Session</button>
      </div>
      <div class="muted">Type <code>start</code> to begin the quiz, or ask for courses.</div>
      <div id="log"></div>
      <div class="row">
        <textarea id="box" placeholder="Type a message…"></textarea>
        <button id="btn">Send</button>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Quick Actions</h2>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="quick-btn" onclick="sendQuickMessage('start')">🎯 Start Quiz</button>
        <button class="quick-btn" onclick="sendQuickMessage('courses near me')">📍 Courses Near Me</button>
        <button class="quick-btn" onclick="sendQuickMessage('beginner courses')">🏌️ Beginner Courses</button>
        <button class="quick-btn" onclick="sendQuickMessage('best courses this weekend')">⭐ Best This Weekend</button>
      </div>
    </div>
  </div>

<script>
  const log  = document.getElementById('log');
  const box  = document.getElementById('box');
  const btn  = document.getElementById('btn');
  const side = document.getElementById('side');

  function render(html, mine){
    const d = document.createElement('div');
    d.className = 'msg ' + (mine ? 'me' : 'bot');
    d.innerHTML = html;
    log.appendChild(d);
    d.scrollIntoView({behavior:'smooth',block:'end'});
  }

  async function sendMessage(){
    const text = (box.value || '').trim();
    if(!text) return;
    render('<strong>You:</strong>\\n' + text, true);
    box.value = '';

    try{
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ messages: [{ role: 'user', content: text }] })
      });
      const j = await r.json();
      render(j.html || 'I do not have that in the site content.', false);

      // Update debug info if provided
      if (j.debug) {
        side.innerHTML = '<div class="status ' + (j.debug.error ? 'error' : 'success') + '">' +
                        JSON.stringify(j.debug, null, 2) + '</div>';
      }
    }catch(e){
      render('Error: ' + (e.message || e), false);
    }
  }

  function sendQuickMessage(text){
    box.value = text;
    sendMessage();
  }

  async function resetSession(){
    if(confirm('Reset session and clear all cookies? This will start a fresh quiz session.')){
      // Clear server-side sessions first
      try {
        await fetch('/api/reset-session', { method: 'POST' });
      } catch (e) {
        console.log('Could not clear server sessions:', e);
      }

      // Clear all cookies
      document.cookie.split(";").forEach(function(c) {
        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
      });

      // Clear chat log
      log.innerHTML = '';

      // Show confirmation
      render('Session reset! Server and browser cleared. Type "start" to begin a new quiz.', false);

      // Refresh debug info
      setTimeout(loadStatus, 100);
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch('/api/debug/status');
      const status = await r.json();
      side.innerHTML = '<pre>' + JSON.stringify(status, null, 2) + '</pre>';
    } catch (e) {
      side.innerHTML = '<div class="status error">Could not load status</div>';
    }
  }

  btn.addEventListener('click', sendMessage);
  box.addEventListener('keydown', (e) => {
    if(e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      sendMessage();
    }
  });

  // Load initial status
  window.addEventListener('load', () => {
    box.focus();
    loadStatus();
  });
</script>
</body>
</html>`);
});

// Mount chat routes
app.use("/api", chatRouter);

// ── Profile API Routes ─────────────────────────────────────────────────
app.post("/api/profile-session-start", async (req, res) => {
  try {
    const { user_id, session_id, seed } = req.body;
    console.log('Starting session:', { user_id, session_id });

    const { data, error } = await supabase
      .from('user_session')
      .insert({
        user_id,
        session_id,
        answers: {},
        scores: {},
        progress: seed || {}
      });

    if (error) {
      console.error('Supabase error:', error);
      throw error;
    }

    console.log('Session started successfully:', { user_id, session_id });
    res.json({ ok: true, data });
  } catch (error) {
    console.error('Failed to start session:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/profile-location", async (req, res) => {
  try {
    const { user_id, city, lat, lon, radius_km } = req.body;
    console.log('Saving location:', { user_id, city, lat, lon, radius_km });

    const { data, error } = await supabase
      .from('user_profile')
      .upsert({
        user_id,
        home_city: city,
        home_lat: lat,
        home_lon: lon,
        travel_radius_km: radius_km,
        profile_updated_at: new Date().toISOString()
      });

    if (error) {
      console.error('Supabase error:', error);
      throw error;
    }

    console.log('Location saved successfully:', { user_id, city });
    res.json({ ok: true, data });
  } catch (error) {
    console.error('Failed to save location:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/profile-availability", async (req, res) => {
  try {
    const { user_id, from, to, bucket } = req.body;
    const availability = { from, to, bucket };
    console.log('Saving availability:', { user_id, availability });

    const { data, error } = await supabase
      .from('user_profile')
      .upsert({
        user_id,
        availability_windows: [availability],
        profile_updated_at: new Date().toISOString()
      });

    if (error) {
      console.error('Supabase error:', error);
      throw error;
    }

    console.log('Availability saved successfully:', { user_id, availability });
    res.json({ ok: true, data });
  } catch (error) {
    console.error('Failed to save availability:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/profile-session-progress", async (req, res) => {
  try {
    const { user_id, session_id, answers, scores, answered_id } = req.body;
    console.log('Saving session progress:', { user_id, session_id, answered_id });

    // First, get current session to append to question_sequence
    const { data: currentSession, error: fetchError } = await supabase
      .from('user_session')
      .select('question_sequence')
      .eq('user_id', user_id)
      .eq('session_id', session_id)
      .single();

    if (fetchError) {
      console.error('Error fetching current session:', fetchError);
    }

    const currentSequence = currentSession?.question_sequence || [];
    const updatedSequence = [...currentSequence, answered_id];

    const { data, error } = await supabase
      .from('user_session')
      .update({
        answers,
        scores,
        question_sequence: updatedSequence,
        progress: { last_answered_question: answered_id },
        last_seen_at: new Date().toISOString()
      })
      .eq('user_id', user_id)
      .eq('session_id', session_id);

    if (error) {
      console.error('Supabase error:', error);
      throw error;
    }

    console.log('Session progress saved successfully:', { user_id, session_id, answered_id, sequence_length: updatedSequence.length });
    res.json({ ok: true, data });
  } catch (error) {
    console.error('Failed to save session progress:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Test endpoint for profile API
app.post("/api/ping", (req, res) => {
  res.json({ ok: true, message: "Profile API is working", timestamp: new Date().toISOString() });
});

// ── Debug endpoints ────────────────────────────────────────────────────
app.get("/api/debug/status", async (req, res) => {
  const status = {
    openai: !!process.env.OPENAI_API_KEY,
    qdrant_site: !!siteQdrant,
    qdrant_course: !!courseQdrant,
    supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    profile_api: true, // Now it's built-in
    env_vars: {
      QDRANT_URL: !!process.env.QDRANT_URL,
      COURSE_QDRANT_URL: !!process.env.COURSE_QDRANT_URL,
      QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || "not set",
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      NODE_ENV: process.env.NODE_ENV || "development"
    }
  };
  res.json(status);
});

app.get("/api/debug/qdrant", async (req, res) => {
  const results = {};

  try {
    if (siteQdrant) {
      const siteInfo = await siteQdrant.getCollection(process.env.QDRANT_COLLECTION || "site_docs");
      results.site_docs = { status: "connected", info: siteInfo };
    } else {
      results.site_docs = { status: "disabled", error: "QDRANT_URL not configured" };
    }
  } catch (e) {
    results.site_docs = { status: "failed", error: e.message };
  }

  try {
    if (courseQdrant) {
      const courseInfo = await courseQdrant.getCollection(process.env.COURSE_COLLECTION || "courses");
      results.courses = { status: "connected", info: courseInfo };
    } else {
      results.courses = { status: "disabled", error: "COURSE_QDRANT_URL not configured" };
    }
  } catch (e) {
    results.courses = { status: "failed", error: e.message };
  }

  res.json(results);
});

app.get("/api/debug/supabase", async (req, res) => {
  try {
    // Test the connection
    const { data, error } = await supabase
      .from('user_session')
      .select('count(*)', { count: 'exact', head: true });

    if (error) throw error;

    res.json({
      success: true,
      connection: "working",
      tables: "accessible"
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      connection: "failed"
    });
  }
});

app.get("/api/debug/quiz", async (req, res) => {
  try {
    console.log("Testing quiz engine import...");
    const { startSession } = await import("./quiz/engine.js");
    console.log("Quiz engine imported successfully");

    const result = await startSession({});
    console.log("Quiz start test result:", result);

    res.json({ success: true, result });
  } catch (error) {
    console.error("Quiz engine test failed:", error);
    res.json({
      success: false,
      error: error.message,
      stack: error.stack?.split('\n').slice(0, 5)
    });
  }
});

// Health check
app.get("/api/ping", (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// Catch all for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.post("/api/reset-session", (req, res) => {
  // Clear the server-side session map
  SESS.clear();
  console.log("[reset] Server-side sessions cleared");
  res.json({ ok: true, message: "Server sessions cleared" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[server] Visit http://localhost:${PORT} to test`);
});
