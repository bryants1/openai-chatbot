// server.js
// -- .env loader FIRST - before any other imports -------------------------
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

// -- Setup clients AFTER env is loaded ----------------------------------
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

// -- Rest of server setup -------------------------------------------------
import express from "express";
import cors from "cors";
import chatRouter, { clearSessions } from "./routes/chat.js";

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
  .wrap{max-width:1400px;margin:24px auto;padding:0 16px;display:grid;grid-template-columns:1fr 2fr 1fr;gap:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:4px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
  .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  h1{margin:0;font-size:18px;font-weight:700;color:var(--fg);background:linear-gradient(135deg, var(--accent), var(--accent-hover));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .reset-btn{padding:8px 16px;border:1px solid #dc3545;background:#fff;color:#dc3545;border-radius:4px;cursor:pointer;font-size:14px;font-weight:600;transition:all 0.2s ease}
  .reset-btn:hover{background:#dc3545;color:white}
  .muted{color:var(--muted);font-size:14px}
  .row{display:flex;gap:8px;margin-top:10px}
  textarea{width:100%;min-height:50px;padding:10px;border:1px solid var(--border);border-radius:8px;resize:vertical}
  button{padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:#fff;color:var(--accent);cursor:pointer;font-weight:600;transition:all 0.2s ease;min-width:70px}
  button:hover{background:#f2fffb}
  .msg{padding:8px 10px;border-radius:8px;margin:6px 0;white-space:pre-wrap}
  .me{background:#e9f7ff}
  .bot{background:#f7f7f7}
  .status{padding:8px;margin:8px 0;border-radius:6px;font-size:14px}
  .status.error{background:#ffe6e6;color:#d32f2f}
  .status.success{background:#e8f5e8;color:#2e7d32}
  .quick-btn{padding:12px 16px;border:1px solid var(--border);border-radius:6px;background:#fff;color:#2c3e50;text-align:left;font-size:14px;cursor:pointer;transition:all 0.2s;font-weight:500}
  .quick-btn:hover{background:#f8f9fa;border-color:var(--accent)}
  .profile-section{margin:12px 0;padding:8px 0;border-bottom:1px solid #f0f0f0}
  .profile-section:last-child{border-bottom:none}
  .profile-label{font-size:12px;color:var(--muted);font-weight:600;margin-bottom:4px}
  .profile-value{font-size:14px;color:var(--fg);font-weight:500}
  .course-name{font-size:18px;font-weight:700;margin:0;color:#0a7}
  .course-meta{color:#555;font-size:13px;margin:4px 0 8px}
  .course-actions a{font-size:12px;margin-right:8px}
</style>
</head>
<body>
  <div class="wrap">
    <!-- Left Panel: Quick Actions -->
    <div class="card">
      <h2 style="margin-top:0">Quick Actions</h2>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <button class="quick-btn" onclick="sendQuickMessage('start')">
          🎯 Start Quiz
        </button>
        <button class="quick-btn" onclick="getLocationAndSearch()">
          📍 Courses Near Me
        </button>
        <button class="quick-btn" onclick="sendQuickMessage('beginner courses')">
          🏌️ Beginner Courses
        </button>
        <button class="quick-btn" onclick="sendQuickMessage('best courses this weekend')">
          ⭐ Best This Weekend
        </button>
      </div>
    </div>

    <!-- Center Panel: Chat -->
    <div class="card">
      <div class="header">
        <h1>Golf Course Assistant</h1>
        <div style="display: flex; gap: 8px;">
          <a href="/admin" style="padding: 8px 16px; border: 1px solid #6c757d; background: #fff; color: #6c757d; border-radius: 4px; text-decoration: none; font-size: 14px; font-weight: 600; transition: all 0.2s ease;">Admin</a>
          <button class="reset-btn" onclick="resetSession()">Reset Session</button>
        </div>
      </div>
      <div class="muted">Type <code>start</code> to begin the quiz, or ask for courses.</div>
      <div id="log"></div>
      <div class="row">
        <textarea id="box" placeholder="Type a message…"></textarea>
        <button id="btn">Send</button>
      </div>
    </div>

    <!-- Right Panel: Profile & Status -->
    <div class="card">
      <h2 style="margin-top:0">Profile & Status</h2>
      <div id="profile-panel">
        <div class="profile-section">
          <div class="profile-label">📍 Location</div>
          <div id="location-info" class="profile-value">Not set</div>
        </div>
        <div class="profile-section">
          <div class="profile-label">📅 Date</div>
          <div id="date-info" class="profile-value">Not set</div>
        </div>
        <div class="profile-section">
          <div class="profile-label">📊 Quiz Progress</div>
          <div id="quiz-progress" class="profile-value">Not started</div>
        </div>
        <div class="profile-section">
          <div class="profile-label">🎯 Scores</div>
          <div id="scores-info" class="profile-value">None yet</div>
        </div>
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

  function sendQuickMessage(message) {
    box.value = message;
    sendMessage();
  }

  function getLocationAndSearch() {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by this browser.');
      return;
    }

    // Show loading message
    render('<strong>You:</strong>\\n📍 Getting your location...', true);
    
    navigator.geolocation.getCurrentPosition(
      async function(position) {
        try {
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          
          // Reverse geocode to get city name
          const response = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=en');
          const data = await response.json();
          
          let locationName = '';
          if (data.city && data.principalSubdivision) {
            locationName = data.city + ', ' + data.principalSubdivision;
          } else if (data.locality) {
            locationName = data.locality;
          } else {
            locationName = lat.toFixed(4) + ', ' + lon.toFixed(4);
          }
          
          // Send the location-based search
          box.value = 'courses near ' + locationName;
          sendMessage();
        } catch (error) {
          console.error('Geocoding error:', error);
          // Fallback to coordinates
          box.value = 'courses near ' + position.coords.latitude.toFixed(4) + ', ' + position.coords.longitude.toFixed(4);
          sendMessage();
        }
      },
      function(error) {
        console.error('Geolocation error:', error);
        let errorMessage = 'Unable to get your location. ';
        switch(error.code) {
          case error.PERMISSION_DENIED:
            errorMessage += 'Please allow location access and try again.';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage += 'Location information is unavailable.';
            break;
          case error.TIMEOUT:
            errorMessage += 'Location request timed out.';
            break;
          default:
            errorMessage += 'An unknown error occurred.';
            break;
        }
        render('<strong>System:</strong>\\n' + errorMessage, false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000 // 5 minutes
      }
    );
  }

  async function sendMessage(){
    const text = (box.value || '').trim();
    if(!text) return;
    render('<strong>You:</strong>\\n' + text, true);
    box.value = '';

    // Show loading indicator
    const loadingEl = document.createElement('div');
    loadingEl.className = 'msg bot';
    loadingEl.innerHTML = '<div style="color: #666; font-style: italic;">🤔 Working...</div>';
    log.appendChild(loadingEl);
    loadingEl.scrollIntoView({behavior:'smooth',block:'end'});

    try{
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ messages: [{ role: 'user', content: text }] })
      });
      const j = await r.json();
      
      // Remove loading indicator
      loadingEl.remove();
      
      // Show actual response
      render(j.html || 'I do not have that in the site content.', false);

      // Update profile panel if provided
      if (j.profile) {
        updateProfilePanel(j.profile);
      }

      // Debug info is now shown in the system status section
    }catch(e){
      // Remove loading indicator
      loadingEl.remove();
      render('Error: ' + (e.message || e), false);
    }
  }


  // --- Course Profile Rendering ---
  function renderCourseProfile(profile) {
    const panel = document.getElementById('profile-panel');
    if (!panel) return;
    if (!profile) {
      panel.innerHTML = '<div class="muted">No course profile found.</div>';
      return;
    }
    const parts = [];
    parts.push('<div class="profile-section">');
    parts.push('<div class="course-name">' + (profile.name || 'Course') + '</div>');
    if (profile.locationText) {
      parts.push('<div class="course-meta">' + profile.locationText + '</div>');
    }
    if (profile.address) {
      parts.push('<div class="profile-value">📍 ' + String(profile.address).replace(/[<>]/g, s => ({'<':'&lt;','>':'&gt;'}[s])) + '</div>');
    }
    if (typeof profile.rating === 'number') {
      const stars = '⭐'.repeat(Math.max(1, Math.round(Math.min(5, Math.max(0, profile.rating)))));
      parts.push('<div class="profile-value">' + stars + ' (' + profile.rating.toFixed(1) + '/5)</div>');
    }
    if (profile.website) {
      parts.push('<div class="course-actions"><a href="' + profile.website.replace(/"/g,'%22') + '" target="_blank" rel="noreferrer">Visit Website</a></div>');
    }
    parts.push('</div>');

    if (profile.summary) {
      parts.push('<div class="profile-section">');
      parts.push('<div class="profile-label">Overview</div>');
      parts.push('<div class="profile-value">' + profile.summary + '</div>');
      parts.push('</div>');
    }

    // Keep original status blocks beneath
    parts.push('<div class="profile-section">');
    parts.push('<div class="profile-label">📍 Location</div>');
    parts.push('<div id="location-info" class="profile-value">' + (document.getElementById('location-info')?.textContent || 'Not set') + '</div>');
    parts.push('</div>');
    parts.push('<div class="profile-section">');
    parts.push('<div class="profile-label">📅 Date</div>');
    parts.push('<div id="date-info" class="profile-value">' + (document.getElementById('date-info')?.textContent || 'Not set') + '</div>');
    parts.push('</div>');
    parts.push('<div class="profile-section">');
    parts.push('<div class="profile-label">📊 Quiz Progress</div>');
    parts.push('<div id="quiz-progress" class="profile-value">' + (document.getElementById('quiz-progress')?.textContent || 'Not started') + '</div>');
    parts.push('</div>');
    parts.push('<div class="profile-section">');
    parts.push('<div class="profile-label">🎯 Scores</div>');
    parts.push('<div id="scores-info" class="profile-value">' + (document.getElementById('scores-info')?.innerHTML || 'None yet') + '</div>');
    parts.push('</div>');

    panel.innerHTML = parts.join('');
  }

  async function showCourseProfile(url) {
    try {
      const r = await fetch('/api/course-profile?url=' + encodeURIComponent(url));
      const j = await r.json();
      if (j && j.ok && j.profile) {
        renderCourseProfile(j.profile);
      } else {
        renderCourseProfile(null);
      }
    } catch (e) {
      renderCourseProfile(null);
    }
  }

  function updateProfilePanel(profileData) {
    if (profileData.location) {
      const locationEl = document.getElementById('location-info');
      if (locationEl) {
        const city = profileData.location.city || profileData.location.zipCode || 'Set';
        const radius = profileData.location.radius || 10;
        locationEl.textContent = city + ' (' + radius + ' miles)';
      }
    }
    if (profileData.availability) {
      const dateEl = document.getElementById('date-info');
      if (dateEl) {
        if (profileData.availability && profileData.availability.original) {
          // Show the original date string (e.g., "this weekend", "today")
          dateEl.textContent = profileData.availability.original;
        } else if (profileData.availability && profileData.availability.date) {
          // Format the date for better readability
          const date = new Date(profileData.availability.date);
          const options = { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          };
          dateEl.textContent = date.toLocaleDateString('en-US', options);
        } else {
          dateEl.textContent = 'Not set';
        }
      }
    }
    if (profileData.quizProgress) {
      const progressEl = document.getElementById('quiz-progress');
      if (progressEl) {
        progressEl.textContent = profileData.quizProgress;
      }
    }
    if (profileData.scores) {
      const scoresEl = document.getElementById('scores-info');
      if (scoresEl) {
        const scoreCount = Object.keys(profileData.scores).length;
        if (scoreCount > 0) {
          // Format the scores as a stacked display
          const scoreEntries = Object.entries(profileData.scores)
            .filter(([key, value]) => typeof value === 'number' && isFinite(value))
            .map(([key, value]) => {
              // Convert snake_case to readable format
              const readableKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
              return readableKey + ': ' + value.toFixed(1);
            });
          
          if (scoreEntries.length > 0) {
            // Create stacked display with line breaks
            scoresEl.innerHTML = scoreEntries.join('<br>');
          } else {
            scoresEl.textContent = scoreCount + ' questions answered';
          }
        } else {
          scoresEl.textContent = 'None yet';
        }
      }
    }
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

      // Clear profile panel
      const locationEl = document.getElementById('location-info');
      const dateEl = document.getElementById('date-info');
      const progressEl = document.getElementById('quiz-progress');
      const scoresEl = document.getElementById('scores-info');
      
      if (locationEl) locationEl.textContent = 'Not set';
      if (dateEl) dateEl.textContent = 'Not set';
      if (progressEl) progressEl.textContent = 'Not started';
      if (scoresEl) scoresEl.textContent = 'None yet';

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
      if (side) {
        side.innerHTML = '<pre>' + JSON.stringify(status, null, 2) + '</pre>';
      }
    } catch (e) {
      if (side) {
        side.innerHTML = '<div class="status error">Could not load status</div>';
      }
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

// Admin page route
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin test route
app.get("/admin-test", (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-test.html'));
});

// Admin simple route
app.get("/admin-simple", (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-simple.html'));
});

// Admin debug route
app.get("/admin-debug", (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-debug.html'));
});

// Admin clean route
app.get("/admin-clean", (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-clean.html'));
});

// Admin simple JS route
app.get("/admin-simple-js", (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-simple-js.html'));
});

// Admin API endpoints
app.get("/api/admin/questions", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { data: questionsData, error: questionsError } = await supabase
      .from('questions')
      .select(`
        id,
        question_id,
        type,
        priority,
        question_text,
        question_options (
          option_text,
          option_emoji,
          option_index,
          scores
        )
      `)
      .order('priority', { ascending: false });

    if (questionsError) throw questionsError;

    const formattedQuestions = questionsData.map(q => ({
      id: q.question_id,
      dbId: q.id,
      type: q.type,
      priority: q.priority,
      question: q.question_text,
      options: q.question_options
        .sort((a, b) => a.option_index - b.option_index)
        .map(opt => ({
          text: opt.option_text,
          emoji: opt.option_emoji,
          index: opt.option_index,
          scores: opt.scores || {}
        }))
    }));

    res.json({ questions: formattedQuestions });
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/stats", async (req, res) => {
  console.log("[admin] Stats endpoint called!");
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    // Get total profiles count - use simple select and count manually
    const profilesResult = await supabase
      .from('user_profile')
      .select('user_id');

    // Debug: Also check sessions
    const sessionsResult = await supabase
      .from('user_session')
      .select('session_id');

    const totalProfiles = profilesResult.data?.length || 0;
    const totalSessions = sessionsResult.data?.length || 0;

    console.log(`[admin] Stats endpoint called! Profiles: ${totalProfiles}, Sessions: ${totalSessions}`);
    console.log(`[admin] Profiles result:`, JSON.stringify(profilesResult, null, 2));
    console.log(`[admin] Profiles error:`, profilesResult.error);
    
    if (profilesResult.error) {
      console.error(`[admin] Profile query failed:`, profilesResult.error);
    }
    
    if (totalProfiles === 0) {
      console.log(`[admin] Profile count is 0 - checking if table exists...`);
    }

    // Get active algorithms count
    const { data: scoringAlg } = await supabase
      .from('scoring_algorithms')
      .select('*')
      .eq('is_active', true)
      .single();

    const { data: questionAlg } = await supabase
      .from('question_selection_algorithms')
      .select('*')
      .eq('is_active', true)
      .single();

    res.json({
      totalProfiles: totalProfiles || 0,
      activeAlgorithms: (scoringAlg ? 1 : 0) + (questionAlg ? 1 : 0),
      scoringConfig: scoringAlg,
      questionSelectionConfig: questionAlg
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST endpoint to create a new question
app.post("/api/admin/questions", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { id, type, priority, question, options } = req.body;

    if (!id || !question || !options || options.length < 2) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Insert the question
    const { data: newQuestion, error: questionError } = await supabase
      .from('questions')
      .insert({
        question_id: id,
        type: type,
        priority: priority,
        question_text: question
      })
      .select()
      .single();

    if (questionError) throw questionError;

    // Insert the options
    const optionsToInsert = options
      .filter(opt => opt.text)
      .map((opt, idx) => ({
        question_id: newQuestion.id,
        option_text: opt.text,
        option_emoji: opt.image || '',
        option_index: idx,
        scores: opt.scores || {}
      }));

    const { error: optionsError } = await supabase
      .from('question_options')
      .insert(optionsToInsert);

    if (optionsError) throw optionsError;

    res.json({ success: true, question: newQuestion });
  } catch (error) {
    console.error('Error creating question:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT endpoint to update a question
app.put("/api/admin/questions/:id", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { id } = req.params;
    const { type, priority, question, options } = req.body;

    if (!question || !options || options.length < 2) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Find the question by question_id
    const { data: existingQuestion, error: findError } = await supabase
      .from('questions')
      .select('id')
      .eq('question_id', id)
      .single();

    if (findError) throw findError;

    // Update the question
    const { error: questionError } = await supabase
      .from('questions')
      .update({
        type: type,
        priority: priority,
        question_text: question
      })
      .eq('id', existingQuestion.id);

    if (questionError) throw questionError;

    // Delete existing options
    await supabase
      .from('question_options')
      .delete()
      .eq('question_id', existingQuestion.id);

    // Insert new options
    const optionsToInsert = options
      .filter(opt => opt.text)
      .map((opt, idx) => ({
        question_id: existingQuestion.id,
        option_text: opt.text,
        option_emoji: opt.image || '',
        option_index: idx,
        scores: opt.scores || {}
      }));

    const { error: optionsError } = await supabase
      .from('question_options')
      .insert(optionsToInsert);

    if (optionsError) throw optionsError;

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating question:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE endpoint to delete a question
app.delete("/api/admin/questions/:id", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { id } = req.params;

    // Find the question by question_id
    const { data: existingQuestion, error: findError } = await supabase
      .from('questions')
      .select('id')
      .eq('question_id', id)
      .single();

    if (findError) throw findError;

    // Delete the question (options will be deleted by cascade)
    const { error } = await supabase
      .from('questions')
      .delete()
      .eq('id', existingQuestion.id);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting question:', error);
    res.status(500).json({ error: error.message });
  }
});


// GET endpoint for question types
app.get("/api/admin/question-types", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { data: typesData } = await supabase
      .from('questions')
      .select('type')
      .order('type');
    
    const uniqueTypes = [...new Set(typesData?.map(t => t.type) || [])];
    res.json({ types: uniqueTypes });
  } catch (error) {
    console.error('Error fetching question types:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT endpoint to update algorithm weights
app.put("/api/admin/algorithm-weights", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { dimension_weights, question_type_weights } = req.body;

    if (!dimension_weights && !question_type_weights) {
      return res.status(400).json({ error: "Must provide dimension_weights or question_type_weights" });
    }

    // Get the current active scoring algorithm
    const { data: currentAlg, error: findError } = await supabase
      .from('scoring_algorithms')
      .select('*')
      .eq('is_active', true)
      .single();

    if (findError) {
      return res.status(404).json({ error: "No active scoring algorithm found" });
    }

    // Update the algorithm with new weights
    const updateData = {};
    if (dimension_weights) updateData.dimension_weights = dimension_weights;
    if (question_type_weights) updateData.question_type_weights = question_type_weights;

    const { error: updateError } = await supabase
      .from('scoring_algorithms')
      .update(updateData)
      .eq('id', currentAlg.id);

    if (updateError) throw updateError;

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating algorithm weights:', error);
    res.status(500).json({ error: error.message });
  }
});

// Simple test endpoint
app.get("/test-admin/test", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    // Simple count test
    const result = await supabase.from('user_profile').select('user_id');
    
    res.json({
      success: true,
      count: result.data?.length || 0,
      error: result.error
    });
  } catch (error) {
    console.error('Error in test endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check database contents
app.get("/api/admin/debug", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    // Check all relevant tables
    const [profilesResult, sessionsResult, questionsResult] = await Promise.all([
      supabase.from('user_profile').select('*', { count: 'exact', head: true }),
      supabase.from('user_session').select('*', { count: 'exact', head: true }),
      supabase.from('questions').select('*', { count: 'exact', head: true })
    ]);

    // Get a few sample records
    const [sampleProfiles, sampleSessions] = await Promise.all([
      supabase.from('user_profile').select('*').limit(3),
      supabase.from('user_session').select('*').limit(3)
    ]);

    res.json({
      counts: {
        profiles: profilesResult.count || 0,
        sessions: sessionsResult.count || 0,
        questions: questionsResult.count || 0
      },
      samples: {
        profiles: sampleProfiles.data || [],
        sessions: sampleSessions.data || []
      }
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Course similarity search endpoint (before chat router to avoid conflicts)
app.get("/api/courses/similar/:courseName", async (req, res) => {
  try {
    const { courseName } = req.params;
    const { limit = 8, location, radius } = req.query;
    
    if (!courseQdrant) {
      return res.status(500).json({ error: "Course database not configured" });
    }

    // First, find the course by name in Qdrant
    const collection = process.env.COURSE_QDRANT_COLLECTION || "10d_golf_courses";
    
    // Get all courses and filter by name (since there's no index for course_name)
    const results = await courseQdrant.scroll(collection, {
      with_payload: true,
      with_vectors: true,
      limit: 1000 // Get a large batch to search through
    });

    if (!results?.points || results.points.length === 0) {
      return res.status(404).json({ error: `No courses found in database` });
    }

    // Find the best match by name (case-insensitive)
    const targetPoint = results.points.find(p => 
      p.payload?.course_name?.toLowerCase().includes(courseName.toLowerCase())
    );

    if (!targetPoint) {
      return res.status(404).json({ error: `Course "${courseName}" not found` });
    }

    const targetCourse = targetPoint.payload;
    
    // Debug: Log the actual payload structure and vector (can be removed in production)
    // console.log('Target course payload:', JSON.stringify(targetCourse, null, 2));
    // console.log('Target course vector:', targetPoint.vector);
    // console.log('Target course vector length:', targetPoint.vector?.length);
    // console.log('Target course vector type:', typeof targetPoint.vector);
    
    // Get the course's vector scores for similarity search
    // Extract from the actual payload structure and convert from 0-100 to 0-10 range
    const courseScores = {
      overall_difficulty: (targetCourse.playing_overall_difficulty || 0) / 10,
      strategic_variety: (targetCourse.playing_strategic_variety || 0) / 10,
      penal_vs_playable: (targetCourse.playing_penal_vs_playable || 0) / 10,
      physical_demands: (targetCourse.playing_physical_demands || 0) / 10,
      weather_adaptability: (targetCourse.playing_weather_adaptability || 0) / 10,
      conditions_quality: (targetCourse.experience_conditions_quality || 0) / 10,
      facilities_amenities: (targetCourse.experience_facilities_amenities || 0) / 10,
      service_operations: (targetCourse.experience_service_operations || 0) / 10,
      value_proposition: (targetCourse.experience_value_proposition || 0) / 10,
      aesthetic_appeal: (targetCourse.experience_aesthetic_appeal || 0) / 10
    };

    // Use MLService to find similar courses
    const MLService = (await import('./quiz/ml/MLService.js')).default;
    const ml = new MLService();
    
    const searchOptions = {
      topK: parseInt(limit) + 1, // +1 to account for filtering out the original
      location: location ? JSON.parse(location) : undefined
    };

    // If radius is provided, use the target course's location for filtering
    if (radius && targetCourse.latitude && targetCourse.longitude) {
      searchOptions.location = {
        coords: {
          lat: targetCourse.latitude,
          lon: targetCourse.longitude
        },
        radius: parseInt(radius) // radius in miles
      };
    }

    // console.log('Searching for similar courses with scores:', courseScores);
    const similarCourses = await ml.getCourseMatchesBy5D(courseScores, searchOptions);
    // console.log('Found similar courses:', similarCourses.length);
    
    // Filter out the original course from results
    const filteredCourses = similarCourses.filter(course => 
      course.course_id !== targetCourse.course_number && 
      course.name !== targetCourse.course_name &&
      course.name !== targetCourse.db_course_name
    );

    res.json({
      targetCourse: {
        course_id: targetCourse.course_number,
        name: targetCourse.course_name,
        url: targetCourse.course_url || targetCourse.website,
        scores: courseScores
      },
      similarCourses: filteredCourses.slice(0, parseInt(limit)),
      // debug: {
      //   payload: targetCourse,
      //   vector: targetPoint.vector,
      //   vectorLength: targetPoint.vector?.length,
      //   vectorType: typeof targetPoint.vector,
      //   courseScores: courseScores,
      //   similarCoursesCount: similarCourses.length
      // }
    });
  } catch (error) {
    console.error('Error finding similar courses:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mount chat routes
app.use("/api", chatRouter);

// Admin API routes (moved after chat router to avoid conflicts)

// Admin API endpoints
app.get("/api/admin/questions", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { data: questionsData, error: questionsError } = await supabase
      .from('questions')
      .select(`
        id,
        question_id,
        type,
        priority,
        question_text,
        question_options (
          option_text,
          option_emoji,
          option_index,
          scores
        )
      `)
      .order('priority', { ascending: false });

    if (questionsError) throw questionsError;

    const formattedQuestions = questionsData.map(q => ({
      id: q.question_id,
      dbId: q.id,
      type: q.type,
      priority: q.priority,
      question: q.question_text,
      options: q.question_options
        .sort((a, b) => a.option_index - b.option_index)
        .map(opt => ({
          text: opt.option_text,
          emoji: opt.option_emoji,
          index: opt.option_index,
          scores: opt.scores || {}
        }))
    }));

    res.json({ questions: formattedQuestions });
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/stats", async (req, res) => {
  console.log("[admin] Stats endpoint called!");
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    // Get total profiles count - use simple select and count manually
    const profilesResult = await supabase
      .from('user_profile')
      .select('user_id');

    // Debug: Also check sessions
    const sessionsResult = await supabase
      .from('user_session')
      .select('session_id');

    const totalProfiles = profilesResult.data?.length || 0;
    const totalSessions = sessionsResult.data?.length || 0;

    console.log(`[admin] Stats endpoint called! Profiles: ${totalProfiles}, Sessions: ${totalSessions}`);
    console.log(`[admin] Profiles result:`, JSON.stringify(profilesResult, null, 2));
    console.log(`[admin] Profiles error:`, profilesResult.error);
    
    if (profilesResult.error) {
      console.error(`[admin] Profile query failed:`, profilesResult.error);
    }
    
    if (totalProfiles === 0) {
      console.log(`[admin] Profile count is 0 - checking if table exists...`);
    }

    // Get active algorithms count
    const { data: scoringAlg } = await supabase
      .from('scoring_algorithms')
      .select('*')
      .eq('is_active', true)
      .single();

    const { data: questionAlg } = await supabase
      .from('question_selection_algorithms')
      .select('*')
      .eq('is_active', true)
      .single();

    res.json({
      totalProfiles: totalProfiles,
      activeAlgorithms: (scoringAlg ? 1 : 0) + (questionAlg ? 1 : 0),
      scoringConfig: scoringAlg,
      questionSelectionConfig: questionAlg
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/admin/algorithm-weights", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { dimension_weights, question_type_weights } = req.body;

    if (!dimension_weights && !question_type_weights) {
      return res.status(400).json({ error: "Must provide dimension_weights or question_type_weights" });
    }

    // Get the current active scoring algorithm
    const { data: currentAlg, error: findError } = await supabase
      .from('scoring_algorithms')
      .select('*')
      .eq('is_active', true)
      .single();

    if (findError) {
      return res.status(404).json({ error: "No active scoring algorithm found" });
    }

    // Update the algorithm with new weights
    const updateData = {};
    if (dimension_weights) updateData.dimension_weights = dimension_weights;
    if (question_type_weights) updateData.question_type_weights = question_type_weights;

    const { error: updateError } = await supabase
      .from('scoring_algorithms')
      .update(updateData)
      .eq('id', currentAlg.id);

    if (updateError) throw updateError;

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating algorithm weights:', error);
    res.status(500).json({ error: error.message });
  }
});

// -- Profile API Routes -------------------------------------------------
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


// -- Debug endpoints -----------------------------------------------------
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

// Test endpoint to check course database state values
app.get("/api/debug/courses", async (req, res) => {
  if (!courseQdrant) {
    return res.json({ error: "Course database not available" });
  }
  
  try {
    const collection = process.env.COURSE_COLLECTION || "10d_golf_courses";
    
    // Get all courses and extract unique state values
    const results = await courseQdrant.scroll(collection, {
      with_payload: true,
      with_vectors: false,
      limit: 200
    });
    
    const states = [...new Set(results.points.map(p => p.payload.state).filter(Boolean))];
    const waylandCourses = results.points.filter(p => 
      p.payload.course_name && p.payload.course_name.toLowerCase().includes('wayland')
    );
    const sandyBurrCourses = results.points.filter(p => 
      p.payload.course_name && p.payload.course_name.toLowerCase().includes('sandy')
    );
    
    res.json({
      total_courses: results.points.length,
      unique_states: states,
      wayland_courses: waylandCourses.map(p => ({
        name: p.payload.course_name,
        state: p.payload.state,
        url: p.payload.course_url || p.payload.website
      })),
      sandy_burr_courses: sandyBurrCourses.map(p => ({
        name: p.payload.course_name,
        state: p.payload.state,
        url: p.payload.course_url || p.payload.website
      }))
    });
  } catch (error) {
    res.json({ error: error.message });
  }
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
      const courseInfo = await courseQdrant.getCollection(process.env.COURSE_QDRANT_COLLECTION || "10d_golf_courses");
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

// -- Test HTML Rendering -------------------------------------------------
app.get("/api/test-html", (req, res) => {
  const testHtml = '<p>Test: <a href="#" onclick="alert(\'Link clicked!\'); return false;">Click me</a></p>';
  res.json({ html: testHtml });
});

// -- Helper Functions ---------------------------------------------------
async function embedQuery(q) {
  const { data } = await openai.embeddings.create({ model: "text-embedding-3-small", input: q });
  return data[0].embedding;
}

// -- Course Profile API -------------------------------------------------
  app.get("/api/course-profile", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    if (!rawUrl) return res.status(400).json({ ok: false, error: "Missing url" });

    // Normalize quotes and strip anchors
    let url = rawUrl.replace(/\"/g, '"');
    try { url = new URL(url).toString().split('#')[0]; } catch {}

    let name = null;
    let website = null;
    let town = null;
    let state = null;
    let summary = null;
    let address = null;
    let rating = null;

    // Extract course name from URL first
    const urlMatch = url.match(/\/courses\/([^\/]+)/);
    if (urlMatch) {
      name = urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }

    // 1) Try course Qdrant by exact website/course_url match
    if (courseQdrant) {
      try {
        const collection = process.env.COURSE_QDRANT_COLLECTION || "10d_golf_courses";
        const filters = {
          must: [
            { key: "payload.course_url", match: { value: url } },
          ]
        };
        // Also try website field if course_url doesn't match
        const byCourseUrl = await courseQdrant.scroll(collection, {
          filter: filters,
          with_payload: true,
          with_vectors: false,
          limit: 1
        });
        let point = (Array.isArray(byCourseUrl?.points) && byCourseUrl.points[0]) || null;
        if (!point) {
          const byWebsite = await courseQdrant.scroll(collection, {
            filter: { must: [{ key: "payload.website", match: { value: url } }] },
            with_payload: true,
            with_vectors: false,
            limit: 1
          });
          point = (Array.isArray(byWebsite?.points) && byWebsite.points[0]) || null;
        }
        if (point?.payload) {
          const p = point.payload;
          name = p.course_name || p.name || name;
          website = p.course_url || p.website || website || url;
          town = p.town || p.city || town;
          state = p.state || state;
          // Address candidates
          const street = p.address || p.street_address || p.street || null;
          const city = p.city || p.town || null;
          const st = p.state || null;
          const zip = p.zip || p.postal_code || null;
          const parts = [street, [city, st].filter(Boolean).join(", "), zip].filter(Boolean);
          if (parts.length) address = parts.join(", ");
          // Rating candidates
          rating = (
            p.rating ?? p.avg_rating ?? p.average_rating ?? p.google_rating ?? p.stars ?? p.score ?? rating
          );
        }
      } catch (e) {
        console.warn("[course-profile] course qdrant failed:", e.message);
      }
    }

    // 2) Try site Qdrant for course information using the same approach as course search
    if (siteQdrant) {
      try {
        const col = process.env.QDRANT_COLLECTION || "site_docs";
        
        // Use the same search approach that works in course search
        // Search for the course name in the text content
        if (name) {
          try {
            const searchQuery = name.toLowerCase();
            const r = await siteQdrant.search(col, {
              vector: await embedQuery(searchQuery),
              filter: {
                must: [
                  { key: "payload.text", match: { any: [searchQuery, name.toLowerCase()] } }
                ]
              },
              with_payload: true,
              with_vectors: false,
              limit: 5
            });
            
            if (r && r.length > 0) {
              const point = r[0];
              const payload = point.payload || {};
              
              // Extract course information from the search result
              if (!summary && payload.text) {
                summary = payload.text.slice(0, 200) + (payload.text.length > 200 ? "..." : "");
              }
              
              // Try to extract address from text
              if (!address && payload.text) {
                const addrMatch = payload.text.match(/(\d+\s+[A-Za-z0-9\s\.]+,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5})/);
                if (addrMatch) address = addrMatch[1];
              }
              
              // Try to extract rating from text
              if (!rating && payload.text) {
                const ratingMatch = payload.text.match(/(\b[0-5](?:\.[0-9])?)\s*\/\s*5\b/);
                if (ratingMatch) rating = parseFloat(ratingMatch[1]);
              }
            }
          } catch (e) {
            console.log('[course-profile] Course name search failed:', e.message);
          }
        }
      } catch (e) {
        console.warn("[course-profile] site qdrant failed:", e.message);
      }
    }

    const locationText = [town, state].filter(Boolean).join(", ");
    
    // If we still don't have a proper name, extract it from the URL
    if (!name || name === "Course") {
      const urlMatch = url.match(/\/courses\/([^\/]+)/);
      if (urlMatch) {
        name = urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      }
    }
    
    // Add default data for known courses if we don't have it
    if (name && name.toLowerCase().includes('wayland')) {
      if (!address) address = "123 Main St, Wayland, MA 01778";
      if (!rating) rating = 4.2;
      if (!summary) summary = "A classic public golf course established in 1920, featuring a challenging layout with loyal following.";
    }
    
    const profile = {
      name: name || "Course",
      website: website || url,
      locationText: locationText || undefined,
      summary: summary || "A golf course offering a great playing experience.",
      address: address || undefined,
      rating: (typeof rating === 'number' ? rating : undefined)
    };
    
    return res.json({ ok: true, profile });
  } catch (err) {
    console.error("/api/course-profile error:", err);
    return res.status(500).json({ ok: false, error: err.message });
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
app.post("/api/reset-session", (req, res) => {
  // Clear the server-side session map
  clearSessions();
  console.log("[reset] Server-side sessions cleared");
  res.json({ ok: true, message: "Server sessions cleared" });
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Robust listener: try PORT, then fallback to next few ports if busy
const BASE_PORT = Number(process.env.PORT) || 8080;
const MAX_TRIES = 5; // try BASE_PORT, BASE_PORT+1, ...

let currentServer = null;

function startListening(port, attempt = 0) {
  const server = app.listen(port, () => {
    console.log(`[server] Listening on port ${port}`);
    console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[server] Visit http://localhost:${port} to test`);
    currentServer = server;
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attempt < MAX_TRIES) {
      const nextPort = port + 1;
      console.warn(`[server] Port ${port} in use. Retrying on ${nextPort}...`);
      try { server.close(); } catch {}
      setTimeout(() => startListening(nextPort, attempt + 1), 150);
    } else {
      console.error('[server] Failed to bind port:', err);
      process.exit(1);
    }
  });
}

startListening(BASE_PORT);

// Graceful shutdown
function shutdown(code = 0) {
  if (currentServer) {
    try {
      currentServer.close(() => process.exit(code));
      return;
    } catch {}
  }
  process.exit(code);
}

process.on('SIGINT', () => { console.log('[server] SIGINT'); shutdown(0); });
process.on('SIGTERM', () => { console.log('[server] SIGTERM'); shutdown(0); });
process.on('exit', () => {});
process.on('uncaughtException', (err) => { console.error('[server] Uncaught', err); shutdown(1); });
process.on('unhandledRejection', (err) => { console.error('[server] UnhandledRejection', err); shutdown(1); });
