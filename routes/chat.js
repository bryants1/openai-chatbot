// routes/chat.js
import { Router } from "express";
import { openai, siteQdrant, courseQdrant } from "../server.js";
// Import quiz engine functions directly
import { startSession, submitAnswer, getQuestion } from "../quiz/engine.js";

const router = Router();

/* ──────────────────────────────────────────────────────────────────────────
 * Env / clients
 * ────────────────────────────────────────────────────────────────────────── */
const REFUSAL = "I don't have that in the site content.";
const DEBUG_RAG = process.env.DEBUG_RAG === "1";
const SITE_VECTOR = (process.env.SITE_VECTOR_NAME || "").trim();

/* ──────────────────────────────────────────────────────────────────────────
 * Database helpers - Direct calls to server endpoints
 * ────────────────────────────────────────────────────────────────────────── */
async function saveSessionStart(userId, sessionId, seed = {}) {
  try {
    const response = await fetch(`http://localhost:${process.env.PORT || 8080}/api/profile-session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, session_id: sessionId, seed })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Failed to save session start');
    console.log('Session started successfully:', { userId, sessionId });
    return result;
  } catch (error) {
    console.error('Failed to save session start:', error);
    throw error;
  }
}

async function saveLocation(userId, city, lat, lon, radiusKm) {
  try {
    const response = await fetch(`http://localhost:${process.env.PORT || 8080}/api/profile-location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, city, lat, lon, radius_km: radiusKm })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Failed to save location');
    console.log('Location saved successfully:', { userId, city });
    return result;
  } catch (error) {
    console.error('Failed to save location:', error);
    throw error;
  }
}

async function saveAvailability(userId, availability) {
  try {
    const response = await fetch(`http://localhost:${process.env.PORT || 8080}/api/profile-availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, ...availability })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Failed to save availability');
    console.log('Availability saved successfully:', { userId, availability });
    return result;
  } catch (error) {
    console.error('Failed to save availability:', error);
    throw error;
  }
}

async function saveSessionProgress(userId, sessionId, answers, scores, answeredId) {
  try {
    const response = await fetch(`http://localhost:${process.env.PORT || 8080}/api/profile-session-progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        session_id: sessionId,
        answers,
        scores,
        answered_id: answeredId
      })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Failed to save session progress');
    console.log('Session progress saved successfully:', { userId, sessionId, answeredId });
    return result;
  } catch (error) {
    console.error('Failed to save session progress:', error);
    throw error;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * OpenAI-powered intent detection
 * ────────────────────────────────────────────────────────────────────────── */
async function detectIntentWithOpenAI(text = "") {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Analyze the user's message and determine their intent. Respond with a JSON object containing:
{
  "intent": "course_search" | "quiz_request" | "general_question" | "other",
  "confidence": 0.0-1.0,
  "location": "extracted location or null",
  "dateInfo": {"date": "extracted date string or null", "type": "date type (today, tomorrow, weekend, specific date, etc.) or null"},
  "reasoning": "brief explanation"
}

Intent definitions:
- "course_search": User wants to find/search for golf courses (e.g., "courses in Boston", "golf courses near me", "best courses this weekend", "show me courses in wayland")
- "quiz_request": User wants to play golf or get personalized recommendations (e.g., "start quiz", "I want to play golf", "I'm looking to play a course", "recommend courses for me", "what courses match my skill level", "I want to play this weekend")
- "general_question": General golf-related questions not about finding courses or playing
- "other": Anything else

Key distinction: If the user expresses intent to PLAY golf (not just find courses), classify as quiz_request. If they want to SEARCH/BROWSE courses, classify as course_search.`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.1,
      max_tokens: 200
    });

    const response = completion.choices[0]?.message?.content?.trim();
    if (!response) {
      return { intent: "general_question", confidence: 0.5, location: null, dateInfo: null, reasoning: "No response from OpenAI" };
    }

    try {
      const parsed = JSON.parse(response);
    return {
        intent: parsed.intent || "general_question",
        confidence: parsed.confidence || 0.5,
        location: parsed.location || null,
        dateInfo: parsed.dateInfo || null,
        reasoning: parsed.reasoning || "Parsed from OpenAI"
      };
    } catch (parseError) {
      console.warn("Failed to parse OpenAI intent response:", response);
      return { intent: "general_question", confidence: 0.5, location: null, dateInfo: null, reasoning: "Parse error" };
    }
  } catch (error) {
    console.error("OpenAI intent detection failed:", error);
    return { intent: "general_question", confidence: 0.5, location: null, dateInfo: null, reasoning: "OpenAI error" };
  }
}

function extractLocation(text = "") {
  const t = (text || "").trim();
  
  // Look for patterns like "near wayland", "in boston", "around newton"
  // Stop at time words like "this weekend", "today", etc.
  let m = t.match(/\b(?:in|near|around|close to|at)\s+([A-Za-z][A-Za-z\s-]*?)(?:\s+(?:this|next|weekend|today|tomorrow|morning|afternoon|evening)|$)/i);
  if (m) {
    const location = m[1].trim();
    // Remove any trailing time words that might have been captured
    return location.replace(/\s+(this|next|weekend|today|tomorrow|morning|afternoon|evening)$/i, '').trim();
  }
  
  // Look for "courses in [location]"
  m = t.match(/\bcourses?\s+(?:in|near|around|at)\s+([A-Za-z][A-Za-z\s-]*?)(?:\s+(?:this|next|weekend|today|tomorrow|morning|afternoon|evening)|$)/i);
  if (m) {
    const location = m[1].trim();
    return location.replace(/\s+(this|next|weekend|today|tomorrow|morning|afternoon|evening)$/i, '').trim();
  }
  
  // Look for "play at [location]"
  m = t.match(/\bplay\s+(?:at|in|near|around)\s+([A-Za-z][A-Za-z\s-]*?)(?:\s+(?:this|next|weekend|today|tomorrow|morning|afternoon|evening)|$)/i);
  if (m) {
    const location = m[1].trim();
    return location.replace(/\s+(this|next|weekend|today|tomorrow|morning|afternoon|evening)$/i, '').trim();
  }
  
  return "";
}

async function geocodeCity(cityName) {
  try {
    // Use Nominatim (OpenStreetMap) free geocoding service with proper headers
    // Get multiple results to check for ambiguity
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cityName)}&limit=5&countrycodes=us`, {
      headers: {
        'User-Agent': 'GolfCourseBot/1.0',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.error('Geocoding API error:', response.status, response.statusText);
      return null;
    }
    
    const data = await response.json();
    
    if (data && data.length > 0) {
      // Check if there are multiple results with different states
      const states = new Set();
      data.forEach(result => {
        const parts = result.display_name.split(', ');
        if (parts.length >= 3) {
          // Look for state in different positions
          for (let i = parts.length - 3; i >= 0; i--) {
            const part = parts[i].trim();
            // Check if it looks like a state (2 letters, or contains State/Commonwealth, or is a known state name)
            if (part.length === 2 && /^[A-Z]{2}$/.test(part)) {
              states.add(part);
              break;
            } else if (part.includes('State') || part.includes('Commonwealth')) {
              states.add(part);
              break;
            } else if (['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'].includes(part)) {
              states.add(part);
              break;
            }
          }
        }
      });
      
      // If multiple states found, return ambiguity flag
      if (states.size > 1) {
        return {
          ambiguous: true,
          city: cityName,
          states: Array.from(states),
          results: data
        };
      }
      
      // Return the first result
      const result = data[0];
      // Extract state from the first result
      let state = null;
      const parts = result.display_name.split(', ');
      for (let i = parts.length - 3; i >= 0; i--) {
        const part = parts[i].trim();
        if (part.length === 2 && /^[A-Z]{2}$/.test(part)) {
          state = part;
          break;
        } else if (part.includes('State') || part.includes('Commonwealth')) {
          state = part;
          break;
        } else if (['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'].includes(part)) {
          state = part;
          break;
        }
      }
      
      return {
        lat: parseFloat(result.lat),
        lon: parseFloat(result.lon),
        display_name: result.display_name,
        city: result.name || cityName,
        state: state
      };
    }
    
    return null;
  } catch (error) {
    console.error('Geocoding error:', error);
    return null;
  }
}

function extractDateInfo(text = "") {
  const t = (text || "").toLowerCase();
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Check for specific time references
  if (/\b(?:today|this morning|this afternoon|this evening)\b/.test(t)) {
    return { type: 'today', date: today.toISOString().split('T')[0] };
  }
  if (/\b(?:tomorrow|next day)\b/.test(t)) {
    return { type: 'tomorrow', date: tomorrow.toISOString().split('T')[0] };
  }
  if (/\b(?:this weekend|weekend|saturday|sunday)\b/.test(t)) {
    // Find next Saturday
    const nextSaturday = new Date(today);
    const daysUntilSaturday = (6 - today.getDay()) % 7;
    nextSaturday.setDate(today.getDate() + (daysUntilSaturday === 0 ? 7 : daysUntilSaturday));
    return { type: 'weekend', date: nextSaturday.toISOString().split('T')[0] };
  }
  if (/\b(?:next week|this week)\b/.test(t)) {
    return { type: 'next_week', date: null };
  }

  return null;
}

/**
 * Detect location/radius update commands
 * ────────────────────────────────────────────────────────────────────────── */
function detectLocationUpdate(text = "") {
  const t = (text || "").toLowerCase();
  
  // Look for radius changes: "change radius to 20 miles", "set radius to 15", etc.
  const radiusMatch = t.match(/(?:change|set|update)\s+radius\s+to\s+(\d+)(?:\s+miles?)?/i);
  if (radiusMatch) {
    return { type: 'radius', value: parseInt(radiusMatch[1]) };
  }
  
  // Look for location changes: "change location to sudbury", "set location to boston", etc.
  const locationMatch = t.match(/(?:change|set|update)\s+location\s+to\s+([a-zA-Z\s-]+)/i);
  if (locationMatch) {
    const location = locationMatch[1].trim();
    return { type: 'location', value: location };
  }
  
  return null;
}

function renderQuizSuggestionHTML(intent, state) {
  const location = intent.location || (state.location && state.location.city);
  const dateInfo = intent.dateInfo || state.availability;
  
  let suggestionText = "The best way for me to match you with a course is to ask you a few questions. ";
  if (location) {
    if (state.location && state.location.needsClarification) {
      suggestionText += `I see you're looking around ${location} (I'll need to clarify the exact location). `;
    } else {
      suggestionText += `I see you're looking around ${location}. `;
    }
  }
  if (dateInfo) {
    const timeText = {
      'today': 'today',
      'tomorrow': 'tomorrow',
      'weekend': 'this weekend',
      'next_week': 'next week'
    }[dateInfo.type] || 'soon';
    suggestionText += `I also noticed you want to play ${timeText}. `;
  }
  suggestionText += "Is that okay?";
  return `
    <div style="margin:8px 0">
      <div style="margin-bottom:6px">🎯 Smart Match</div>
      <div style="margin:8px 0; line-height:1.4; font-size:13px; color:#2c3e50;">
        ${suggestionText}
      </div>
      <div style="display:flex; gap:8px; margin-top:6px">
        <button onclick="(function(){
          // Directly start the quiz instead of sending 'yes' message
          fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'START_QUIZ_FROM_SUGGESTION' }] })
          })
          .then(r => r.json())
          .then(data => {
            if (data.html) {
              const log = document.getElementById('log');
              if (log) {
                const botMsg = document.createElement('div');
                botMsg.className = 'msg bot';
                botMsg.innerHTML = data.html;
                log.appendChild(botMsg);
                log.scrollIntoView({behavior:'smooth',block:'end'});
              }
              if (data.profile) {
                updateProfile(data.profile);
              }
            }
          })
          .catch(e => console.error('Quiz start error:', e));
        })()">
          Yes, start quiz
        </button>
        <button onclick="(function(){
          var box=document.getElementById('box');
          if(box){ box.value='no'; document.getElementById('btn').click(); }
        })()" style="background:#6c757d; border-color:#6c757d; color:white;">
          No, just search
        </button>
      </div>
    </div>
  `;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Session helpers
 * ────────────────────────────────────────────────────────────────────────── */
const SESS = new Map();

export function clearSessions() {
  SESS.clear();
  console.log("[reset] Chat sessions cleared");
}
function newChatState() {
  return {
    mode: null,
    sessionId: null,
    question: null,
    answers: {},
    scores: {},
    location: null,
    availability: null,
    needsLocation: false,
    needsWhen: false,
    lastLinks: []
  };
}
function getSid(req, res) {
  const cookie = req.headers.cookie || "";
  const m = /sid=([A-Za-z0-9_-]+)/.exec(cookie);
  if (m) return m[1];
  const sid = Math.random().toString(36).slice(2);
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}
function getUid(req, res) {
  const cookie = req.headers.cookie || "";
  const m = /uid=([A-Za-z0-9_-]+)/.exec(cookie);
  if (m) return m[1];
  const uid = Math.random().toString(36).slice(2);
  res.setHeader("Set-Cookie", `uid=${uid}; Path=/; HttpOnly; SameSite=Lax`);
  return uid;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Small utilities
 * ────────────────────────────────────────────────────────────────────────── */
const DIM_ORDER = [
  "overall_difficulty","strategic_variety","penal_vs_playable","physical_demands","weather_adaptability",
  "conditions_quality","facilities_amenities","service_operations","value_proposition","aesthetic_appeal"
];

function normalizeText(s) { return (s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function isListIntent(q) {
  if (!q) return false;
  const s = q.toLowerCase();
  return /(best|top|list|recommend|recommendation|near|close to|within|under\s*\$?\d+|courses?\s+(in|near|around)|bucket\s*list)/i.test(s);
}

function renderReplyHTML(text = "", linkHints = []) {
  // linkify markdown links first
  const md = (s) => s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, l, u) =>
    `<a href="${u.replace(/"/g, "%22")}" target="_blank" rel="noreferrer">${l}</a>`
  );

  // Linkify known course names to open right-panel profiles
  function linkifyCourses(s) {
    if (!Array.isArray(linkHints) || !linkHints.length) return s;
    let out = s;
    for (const hint of linkHints) {
      const name = (hint.name || "").trim();
      const url = (hint.url || "").trim();
      if (!name || !url) continue;
      const safeU = url.replace(/"/g, "%22");
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "gi");
      out = out.replace(re, (m) => `<a href="#" onclick="showCourseProfile('${safeU}'); return false;">${m}</a>`);
    }
    return out;
  }

  const lines = String(text).split(/\r?\n/);
  let html = [], list = false, para = [];
  const flush = () => { if (para.length) { html.push(`<p>${md(linkifyCourses(para.join(" ")))}</p>`); para = []; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); if (list) { html.push("</ul>"); list = false; } continue; }
    if (/^([•\-\*]\s+)/.test(line)) {
      flush(); if (!list) { html.push("<ul>"); list = true; }
      html.push(`<li>${md(linkifyCourses(line.replace(/^([•\-\*]\s+)/, "").trim()))}</li>`);
    } else para.push(line);
  }
  flush(); if (list) html.push("</ul>"); return html.join("");
}
function renderQuestionHTML(q){
  const headline=(q.conversational_text||q.text||"").trim();
  let html = `<div style="font-size:18px;font-weight:600;margin:0 0 20px;color:#333">${headline}</div>`;

  // Add clickable options
  if (q.options && Array.isArray(q.options)) {
    html += `<div style="margin:20px 0">`;
    for (const option of q.options) {
      const optionIndex = option.index ?? option.option_index ?? 0;
      const optionText = option.text ?? option.option_text ?? "";
      html += `
        <button onclick="(function(){
          var box=document.getElementById('box');
          if(box){ box.value='${optionIndex}'; document.getElementById('btn').click(); }
        })()" style="display:block;width:100%;text-align:left;padding:12px 16px;margin:8px 0;border:2px solid #ddd;background:white;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s" onmouseover="this.style.borderColor='#0a7';this.style.backgroundColor='#f8fff8'" onmouseout="this.style.borderColor='#ddd';this.style.backgroundColor='white'">
          ${optionText}
        </button>
      `;
    }
    html += `</div>`;

    html += `<div style="text-align:center;color:#666;font-size:12px;margin-top:20px">
      Or type a number (${q.options.map(o => o.index ?? o.option_index ?? 0).join(', ')}) in the chat below
    </div>`;
  }

  return html;
}

// Final profile: **only** matched courses + 10-D scores (no skill/persona/recs)
function renderFinalProfileHTML(profile = {}, scores = {}, total = 0) {
  const courses = Array.isArray(profile.matchedCourses) ? profile.matchedCourses : [];
  const dims = DIM_ORDER;

  const lines = [];
  lines.push(`You've completed the quiz!`);
  if (total) lines.push(`Questions answered: ${total}`);
  lines.push("");

  if (courses.length) {
    lines.push(`Matched Courses`);
    for (const c of courses.slice(0, 8)) {
      const name = (c.name || c.payload?.course_name || "Course");
      const score = (typeof c.score === "number") ? ` – ${c.score.toFixed(3)}` : "";
      const url = c.url || c.payload?.course_url || c.payload?.website || "";
      if (url) {
        const safe = String(url).replace(/"/g, '%22');
        // Make the course name open the right-panel profile; include a small external visit link
        lines.push(`• <a href="#" onclick="showCourseProfile('${safe}'); return false;">${name}</a>${score} <a href="${safe}" target="_blank" rel="noreferrer" style="font-size:12px;margin-left:6px">Visit</a>`);
      } else {
      lines.push(`• ${name}${score}`);
      }
    }
    lines.push("");
  }

  const haveAny = dims.some(k => typeof scores?.[k] === "number" && isFinite(scores[k]));
  if (haveAny) {
    lines.push(`Your 10D Profile (0–10)`);
    for (const k of dims) {
      const v = (typeof scores?.[k] === "number" && isFinite(scores[k])) ? scores[k].toFixed(2) : "—";
      lines.push(`• ${k.replace(/_/g," ")}: ${v}`);
    }
  }

  return lines.join("\n");
}

/* ──────────────────────────────────────────────────────────────────────────
 * RAG helpers
 * ────────────────────────────────────────────────────────────────────────── */
async function embedQuery(q){
  const { data } = await openai.embeddings.create({ model:"text-embedding-3-small", input:q });
  return data[0].embedding;
}

async function retrieveSite(question, topK=120){
  if (!siteQdrant) {
    console.warn("[rag] Site Qdrant not available");
    return [];
  }
  try {
    const vector = await embedQuery(question);
    const body = { vector, limit: topK, with_payload: true, with_vectors: false, ...(SITE_VECTOR ? {using: SITE_VECTOR} : {}) };
    return await siteQdrant.search(process.env.QDRANT_COLLECTION || "site_docs", body) || [];
  } catch (error) {
    console.warn("[rag] Site search failed:", error.message);
    return [];
  }
}

async function retrieveCourses(question, topK=20){
  if (!courseQdrant) {
    console.warn("[rag] Course Qdrant not available");
    return [];
  }
  try {
    // Extract location from question for filtering
    const location = extractLocation(question);
    const collection = process.env.COURSE_COLLECTION || "courses";
    
    // Try to find courses by state
    let stateToSearch = null;
    if (location && location.includes(',')) {
      stateToSearch = location.split(',')[1]?.trim();
    } else if (location && location.toLowerCase().includes('massachusetts')) {
      stateToSearch = 'massachusetts';
    }
    
    if (stateToSearch) {
      console.log(`[course-search] Looking for state: "${stateToSearch}"`);
      // Try different state formats
      const stateVariants = [stateToSearch, stateToSearch.toUpperCase(), stateToSearch.toLowerCase()];
      if (stateToSearch === 'MA') {
        stateVariants.push('Massachusetts', 'MASSACHUSETTS', 'massachusetts');
      } else if (stateToSearch.toLowerCase() === 'massachusetts') {
        stateVariants.push('MA', 'ma');
      }
      
      for (const stateVariant of stateVariants) {
        console.log(`[course-search] Trying state variant: "${stateVariant}"`);
        const results = await courseQdrant.scroll(collection, {
          filter: { must: [{ key: "payload.state", match: { value: stateVariant } }] },
          with_payload: true,
          with_vectors: false,
          limit: topK
        });
        console.log(`[course-search] Found ${results?.points?.length || 0} courses for state "${stateVariant}"`);
        if (results?.points?.length > 0) {
          return results.points;
        }
      }
    }
    
    // No fallback vector search - course database uses different vector size
    console.log("[course-search] No courses found with state filtering");
    return [];
  } catch (error) {
    console.warn("[rag] Course search failed:", error.message);
    return [];
  }
}

async function voyageRerank(query,hits,topN=40){
  try{
    const key=(process.env.VOYAGE_API_KEY||"").trim();
    if(!key||!hits?.length) return hits;
    const url="https://api.voyageai.com/v1/rerank";
    const docs=hits.map(h=>`${h?.payload?.title||h?.payload?.h1||""}\n\n${h?.payload?.text||""}`);
    const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},
      body:JSON.stringify({model:process.env.VOYAGE_RERANK_MODEL||"rerank-2-lite",query,documents:docs,top_n:Math.min(topN,docs.length)})});
    if(!r.ok) return hits;
    const data=await r.json(); const order=(data?.data||[]).map(d=>({idx:d.index,score:d.relevance_score}));
    const byIdx=new Map(order.map(o=>[o.idx,o.score]));
    return hits.map((h,i)=>({...h,_voy:byIdx.has(i)?byIdx.get(i):-1e9}))
               .sort((a,b)=>b._voy-a._voy).map(({_voy,...h})=>h);
  }catch{return hits;}
}

/* ──────────────────────────────────────────────────────────────────────────
 * /api/chat (main endpoint)
 * ────────────────────────────────────────────────────────────────────────── */
router.post("/chat", async (req, res) => {
  try {
    const sid = getSid(req, res);
    const uid = getUid(req, res);
    const state = SESS.get(sid) || newChatState();
    const { messages=[] } = req.body || {};
    const lastUser = [...messages].reverse().find(m=>m.role==="user")?.content?.trim() || "";

    // Debug session
    console.log('Session debug:', {
      sid,
      uid,
      hasState: !!SESS.get(sid),
      currentSessionId: state.sessionId,
      sessionMapSize: SESS.size
    });

    if (!state.sessionId) {
      state.sessionId = Date.now().toString();
      // Save session start to database
      try {
        await saveSessionStart(uid, state.sessionId, {});
      } catch (error) {
        console.error("Failed to save session start:", error);
      }
    }
    SESS.set(sid, state);

    // Check if this is a quiz start request
    const isStart = /^\s*(start|start quiz)\s*$/i.test(lastUser);

    // Handle quiz start FIRST, before any other processing
    if (isStart) {
      try {
        // Reset session state for fresh quiz start
        state.mode = null;
        state.question = null;
        state.questionNumber = null;
        state.answers = {};
        state.scores = {};
        state.pendingQuizSuggestion = null;
        
        // Check if we already have location and date information
        const hasLocation = state.location && (state.location.coords || state.location.city);
        const hasDate = state.availability && state.availability.date;

        const startAns = await startSession({
          sessionId: state.sessionId, // ensure engine ties to this session
          skipLocation: hasLocation,
          location: state.location,
          availability: state.availability
        });
        
        if (!startAns) {
          SESS.set(sid, newChatState());
          return res.json({ html:"Sorry, I couldn't start the quiz right now." });
        }
        
        if (startAns.needsLocation) {
          state.mode="quiz";
          state.sessionId=startAns.sessionId;
          state.needsLocation=true;
          state.pendingQuizSuggestion = null; // Clear the pending suggestion
          SESS.set(sid,state);
          return res.json({
            html: `
              <div style="font-size:16px;margin:0 0 10px">Where are you looking for golf courses?</div>
              <div style="margin:10px 0">
                <input type="text" id="zipcode" placeholder="ZIP (e.g., 02134)"
                       style="padding:8px;border:1px solid #ddd;border-radius:6px;width:150px;margin-right:8px">
                <select id="radius" style="padding:8px;border:1px solid #ddd;border-radius:6px">
                  <option value="10">10 miles</option>
                  <option value="25" selected>25 miles</option>
                  <option value="50">50 miles</option>
                  <option value="100">100 miles</option>
                  <option value="9999">Anywhere</option>
                </select>
                <button onclick="(function(){
                  var zip=document.getElementById('zipcode').value.trim();
                  var radius=document.getElementById('radius').value.trim();
                  var box=document.getElementById('box');
                  if(box){ box.value='LOCATION:'+zip+':'+radius; document.getElementById('btn').click(); }
                })()" style="margin-left:8px;padding:8px 12px;background:#0a7;color:white;border:none;border-radius:6px;cursor:pointer">Continue</button>
              </div>`,
            suppressSidecar:true,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: "Quiz started - needs location",
              scores: state.scores
            }
          });
        }
        
        // If we have both location and date, show quiz suggestion instead of starting immediately
        if (startAns.question) {
          // Don't start the quiz yet - show suggestion first
          // Create a mock intent object for the suggestion
          const mockIntent = {
            location: state.location?.city || state.location?.display_name,
            dateInfo: state.availability?.original || state.availability?.date
          };
          state.pendingQuizSuggestion = mockIntent;
          const suggestionHTML = renderQuizSuggestionHTML(mockIntent, state);
          SESS.set(sid, state);
          return res.json({ 
            html: suggestionHTML,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: "Quiz suggested",
              scores: state.scores
            }
          });
        }
      } catch (error) {
        console.error("Quiz start error:", error);
        return res.json({ html:"Sorry, I couldn't start the quiz right now." });
      }
    }

    // Exit quiz
    if (/^\s*(cancel|stop|exit|end)\s*(quiz)?\s*$/i.test(lastUser)) {
      SESS.set(sid, newChatState());
      return res.json({ html: "Got it – I've exited the quiz. Ask anything or type 'start' to begin again." });
    }

    // Handle location/radius updates
    const locationUpdate = detectLocationUpdate(lastUser);
    if (locationUpdate) {
      if (locationUpdate.type === 'radius') {
        if (state.location) {
          state.location.radius = locationUpdate.value;
          SESS.set(sid, state);
          return res.json({ 
            html: `✅ Updated search radius to ${locationUpdate.value} miles.`,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: state.mode === 'quiz' ? `Quiz in progress - Question ${state.questionNumber || 1}` : "Not started",
              scores: state.scores
            }
          });
        } else {
          return res.json({ html: "❌ No location set yet. Please set a location first." });
        }
      } else if (locationUpdate.type === 'location') {
        // Geocode the new location
        const geocoded = await geocodeCity(locationUpdate.value);
        if (geocoded) {
          if (geocoded.ambiguous) {
            // Multiple states found - ask for clarification
            state.location = { 
              city: geocoded.city, 
              coords: null, 
              zipCode: null, 
              radius: state.location?.radius || 10,
              needsStateClarification: true,
              availableStates: geocoded.states
            };
            SESS.set(sid, state);
            const statesList = geocoded.states.join(', ');
            return res.json({ 
              html: `I found multiple cities named "${geocoded.city}" in different states: ${statesList}. Which state did you mean?`,
              profile: {
                location: state.location,
                availability: state.availability,
                quizProgress: state.mode === 'quiz' ? `Quiz in progress - Question ${state.questionNumber || 1}` : "Location needs state clarification",
                scores: state.scores
              }
            });
          } else {
            // Single result found
            state.location = { 
              city: geocoded.city, 
              coords: { lat: geocoded.lat, lon: geocoded.lon }, 
              zipCode: null, 
              radius: state.location?.radius || 10,
              display_name: geocoded.display_name,
              state: geocoded.state
            };
            SESS.set(sid, state);
            return res.json({ 
              html: `✅ Updated location to ${geocoded.city}, ${geocoded.state} (${state.location.radius} mile radius).`,
              profile: {
                location: state.location,
                availability: state.availability,
                quizProgress: state.mode === 'quiz' ? `Quiz in progress - Question ${state.questionNumber || 1}` : "Not started",
                scores: state.scores
              }
            });
          }
        } else {
          return res.json({ html: `❌ Could not find location "${locationUpdate.value}". Please try a different city name.` });
        }
      }
    }

    // Extract location/date from any message and store in session
    if (!state.mode) {
      const intent = await detectIntentWithOpenAI(lastUser);
      console.log('OpenAI intent detection:', { lastUser, intent });
      
      if (intent.location && !state.location) {
        // Geocode the location to get coordinates
        const geocoded = await geocodeCity(intent.location);
          if (geocoded) {
            if (geocoded.ambiguous) {
              // Multiple states found - ask for clarification
              state.location = { 
                city: geocoded.city, 
                coords: null, 
                zipCode: null, 
                radius: 10,
                needsStateClarification: true,
                availableStates: geocoded.states
              };
            } else {
            // Single result found
              state.location = { 
                city: geocoded.city, 
                coords: { lat: geocoded.lat, lon: geocoded.lon }, 
                zipCode: null, 
                radius: 10,
                display_name: geocoded.display_name,
                state: geocoded.state
              };
            }
          } else {
            // If geocoding fails, store just the city name and ask for clarification
            state.location = { 
            city: intent.location, 
              coords: null, 
              zipCode: null, 
              radius: 10,
              needsClarification: true
            };
        }
      }
      if (intent.dateInfo && !state.availability) {
        // Store extracted date - handle both string and object formats
        let dateString, dateType;
        
        if (typeof intent.dateInfo === 'string') {
          dateString = intent.dateInfo;
          dateType = 'relative';
        } else if (intent.dateInfo.date) {
          dateString = intent.dateInfo.date;
          dateType = intent.dateInfo.type || 'relative';
        }
        
        if (dateString) {
          // Convert relative dates to actual dates
          let actualDate;
          const today = new Date();
          
          switch (dateString.toLowerCase()) {
            case 'today':
              actualDate = today.toISOString().split('T')[0]; // YYYY-MM-DD format
              break;
            case 'tomorrow':
              const tomorrow = new Date(today);
              tomorrow.setDate(today.getDate() + 1);
              actualDate = tomorrow.toISOString().split('T')[0];
              break;
            case 'this weekend':
            case 'weekend':
              // Find next Saturday
              const nextSaturday = new Date(today);
              const daysUntilSaturday = (6 - today.getDay()) % 7;
              if (daysUntilSaturday === 0 && today.getDay() !== 6) {
                nextSaturday.setDate(today.getDate() + 7); // Next week's Saturday
        } else {
                nextSaturday.setDate(today.getDate() + daysUntilSaturday);
              }
              actualDate = nextSaturday.toISOString().split('T')[0];
              break;
            default:
              // Try to parse as a date string
              const parsedDate = new Date(dateString);
              if (!isNaN(parsedDate.getTime())) {
                actualDate = parsedDate.toISOString().split('T')[0];
          } else {
                actualDate = dateString; // Keep original if can't parse
              }
          }
          
        state.availability = {
            date: actualDate,
            type: dateType,
            original: dateString // Keep original for reference
        };
      }
      }
      if (intent.location || intent.dateInfo) {
        SESS.set(sid, state);
      }
    }

    // Handle state clarification if needed
    if (state.location && state.location.needsStateClarification) {
      const stateMatch = lastUser.match(/\b([A-Z]{2}|[A-Za-z\s]+(?:State|Commonwealth)?)\b/);
      if (stateMatch) {
        const requestedState = stateMatch[1].trim();
        // Try to geocode with the specific state
        const geocoded = await geocodeCity(`${state.location.city}, ${requestedState}`);
        if (geocoded && !geocoded.ambiguous) {
          state.location = { 
            city: geocoded.city, 
            coords: { lat: geocoded.lat, lon: geocoded.lon }, 
            zipCode: null, 
            radius: 10,
            display_name: geocoded.display_name,
            state: geocoded.state
          };
          state.location.needsStateClarification = false;
          SESS.set(sid, state);
            return res.json({ 
              html: `✅ Got it! ${geocoded.city}, ${geocoded.state}. Now, when would you like to play?`,
              profile: {
                location: state.location,
                availability: state.availability,
                quizProgress: "Location confirmed - needs date",
                scores: state.scores
              }
            });
        } else {
          return res.json({ 
            html: `❌ I couldn't find ${state.location.city} in ${requestedState}. Please try a different state or be more specific.`,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: "Location needs clarification",
              scores: state.scores
            }
          });
        }
      } else {
        // Ask for state clarification
        const statesList = state.location.availableStates.join(', ');
        return res.json({ 
          html: `I found multiple cities named "${state.location.city}" in different states: ${statesList}. Which state did you mean?`,
          profile: {
            location: state.location,
            availability: state.availability,
            quizProgress: "Location needs state clarification",
            scores: state.scores
          }
        });
      }
    }

    // Check for quiz request intent and suggest quiz
    if (!isStart && !state.mode) {
      const intent = await detectIntentWithOpenAI(lastUser);
      console.log('OpenAI intent detection:', { lastUser, intent });
      
      // Only suggest quiz for explicit quiz requests, not general course searches
      if (intent.intent === "quiz_request" && intent.confidence > 0.7) {
        // Check if we have location but no date - ask for date first
        const hasLocation = state.location && (state.location.coords || state.location.city);
        const hasDate = state.availability && state.availability.date;
        
        if (hasLocation && !hasDate) {
          // We have location but no date - ask for date first
          state.mode = "quiz";
          state.needsWhen = true;
          SESS.set(sid, state);
          return res.json({
            html: `
              <div style="font-size:16px;margin:0 0 10px">When would you like to play?</div>
              <div style="margin:10px 0">
                <input type="date" id="playdate" style="padding:8px;border:1px solid #ddd;border-radius:6px;margin-right:8px">
                <button onclick="(function(){
                  var date=document.getElementById('playdate').value.trim();
                  var box=document.getElementById('box');
                  if(box){ box.value='WHEN:'+date+'::any'; document.getElementById('btn').click(); }
                })()" style="margin-left:8px;padding:8px 12px;background:#0a7;color:white;border:none;border-radius:6px;cursor:pointer">Continue</button>
              </div>`,
            suppressSidecar: true,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: "Quiz started - needs date",
              scores: state.scores
            }
          });
        }
        
        // Show quiz suggestion with detected location/date
        const suggestionHTML = renderQuizSuggestionHTML(intent, state);
        state.pendingQuizSuggestion = intent;
        SESS.set(sid, state);
        return res.json({ 
          html: suggestionHTML,
          profile: {
            location: state.location,
            availability: state.availability,
            quizProgress: "Quiz suggested",
            scores: state.scores
          }
        });
      }
    }

    // Handle quiz start from pending suggestion
    if (state.pendingQuizSuggestion && (lastUser.toLowerCase() === 'yes' || lastUser.toLowerCase() === 'y' || lastUser === 'START_QUIZ_FROM_SUGGESTION')) {
      try {
        const hasLocation = state.location && (state.location.coords || state.location.city);
        const hasDate = state.availability && state.availability.date;
        
        const startAns = await startSession({
          skipLocation: hasLocation,
          sessionId: state.sessionId,
          location: state.location,
          availability: state.availability
        });
        
        if (!startAns) {
          SESS.set(sid, newChatState());
          return res.json({ html:"Sorry, I couldn't start the quiz right now." });
        }
        
        if (startAns.needsLocation) {
          state.mode="quiz";
          state.sessionId=startAns.sessionId;
          state.needsLocation=true;
          state.pendingQuizSuggestion = null; // Clear the pending suggestion
          SESS.set(sid,state);
          return res.json({
            html: `
              <div style="font-size:16px;margin:0 0 10px">Where are you looking for golf courses?</div>
              <div style="margin:10px 0">
                <input type="text" id="zipcode" placeholder="ZIP (e.g., 02134)"
                       style="padding:8px;border:1px solid #ddd;border-radius:6px;width:150px;margin-right:8px">
                <select id="radius" style="padding:8px;border:1px solid #ddd;border-radius:6px">
                  <option value="10">10 miles</option>
                  <option value="25" selected>25 miles</option>
                  <option value="50">50 miles</option>
                </select>
                <button onclick="(function(){
                  var zip=document.getElementById('zipcode').value.trim();
                  var radius=document.getElementById('radius').value.trim();
                  var box=document.getElementById('box');
                  if(box){ box.value='LOCATION:'+zip+':'+radius; document.getElementById('btn').click(); }
                })()" style="margin-left:8px;padding:8px 12px;background:#0a7;color:white;border:none;border-radius:6px;cursor:pointer">Continue</button>
              </div>`,
            suppressSidecar:true,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: "Quiz started - needs location",
              scores: state.scores
            }
          });
        }
        
        if (startAns.needsWhen) {
          state.mode="quiz";
          state.sessionId=startAns.sessionId;
          state.needsWhen=true;
          state.pendingQuizSuggestion = null; // Clear the pending suggestion
          SESS.set(sid,state);
          return res.json({
            html: `
              <div style="font-size:16px;margin:0 0 10px">When would you like to play?</div>
              <div style="margin:10px 0">
                <input type="date" id="playdate" style="padding:8px;border:1px solid #ddd;border-radius:6px;margin-right:8px">
                <button onclick="(function(){
                  var date=document.getElementById('playdate').value.trim();
                  var box=document.getElementById('box');
                  if(box){ box.value='WHEN:'+date+'::any'; document.getElementById('btn').click(); }
                })()" style="margin-left:8px;padding:8px 12px;background:#0a7;color:white;border:none;border-radius:6px;cursor:pointer">Continue</button>
              </div>`,
            suppressSidecar:true,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: "Quiz started - needs date",
              scores: state.scores
            }
          });
        }
        
        // If we have both location and date, show quiz suggestion instead of starting immediately
        if (startAns.question) {
          // Don't start the quiz yet - show suggestion first
          const suggestionHTML = renderQuizSuggestionHTML(state.pendingQuizSuggestion, state);
          SESS.set(sid, state);
          return res.json({ 
            html: suggestionHTML,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: "Quiz suggested",
              scores: state.scores
            }
          });
        }
        
      } catch (error) {
        console.error("Quiz start from suggestion error:", error);
        return res.json({ html:"Sorry, I couldn't start the quiz right now." });
      }
    }

    // Handle "no" response to quiz suggestion - do regular course search
    if (state.pendingQuizSuggestion && (lastUser.toLowerCase() === 'no' || lastUser.toLowerCase() === 'n')) {
      // Clear the pending suggestion and do a regular course search
      state.pendingQuizSuggestion = null;
      SESS.set(sid, state);
      
      // Continue to RAG search below
    }


    // RAG by default (not in quiz and not already handled)
    if (state.mode !== "quiz" && !isStart) {
      try {
        const locForQuery = extractLocation(lastUser);
        const variants = [
          lastUser, lastUser.toLowerCase(), lastUser.replace(/[^\w\s]/g, " "),
          ...(locForQuery ? [
            `golf courses in ${locForQuery}`, 
            `${locForQuery} golf courses`, 
            `courses near ${locForQuery}`,
            // Also search for city name without state if location includes state
            ...(locForQuery.includes(',') ? [
              `golf courses in ${locForQuery.split(',')[0].trim()}`,
              `${locForQuery.split(',')[0].trim()} golf courses`,
              `courses near ${locForQuery.split(',')[0].trim()}`
            ] : [])
          ] : [])
        ].filter(Boolean);

        let siteHits=[];
        for (const v of variants){
          const hits=await retrieveSite(v,120);
          siteHits=[...siteHits, ...(hits||[])];
          if (siteHits.length >= 120) break;
        }
        siteHits = await voyageRerank(lastUser, siteHits, 40);

        // Also search for courses in the course database
        let courseHits=[];
        for (const v of variants){
          const hits=await retrieveCourses(v,20);
          console.log(`Course search for "${v}":`, hits?.length || 0, 'results');
          courseHits=[...courseHits, ...(hits||[])];
          if (courseHits.length >= 20) break;
        }
        console.log('Total course hits:', courseHits.length);

        // dedupe
        const seen = new Set();
        siteHits = siteHits.filter(h=>{
          const key=`${h?.payload?.url}#${h?.payload?.chunk_index ?? "html"}`;
          if(seen.has(key)) return false; seen.add(key); return true;
        });

        // lexical boost
        const tokens = normalizeText(lastUser).split(/\s+/).filter(t=>t.length>2);
        const qlen   = tokens.length;
        const threshold = 0.06 + Math.min(0.12, qlen * 0.01);
        const norm = (h)=> normalizeText(`${h?.payload?.title||""} ${h?.payload?.text||""}`);
        function lex(h){ const hay=norm(h); let n=0; for(const t of tokens) if(hay.includes(t)) n++; return n; }

        const good = siteHits
          .filter(h => (h?.score ?? 0) >= threshold)
          .map(h => ({ ...h, _lex: lex(h) }))
          .sort((a,b)=> (b.score + 0.03*b._lex) - (a.score + 0.03*a._lex));

        const keep = new Map();
        for (const h of good.slice(0, 20)){ const key=h?.payload?.url || ""; if(!keep.has(key)) keep.set(key,h); }
        const finalHits = [...keep.values()].slice(0, isListIntent(lastUser) ? 8 : 6); // Reduced from 12/10 to 8/6

        const MAX_CHARS=12000; let context="", links=[];
        for (let i=0;i<finalHits.length;i++){
          const h=finalHits[i];
          const url=h?.payload?.url || "";
          const title=h?.payload?.title || h?.payload?.h1 || "";
          const txt=(h?.payload?.text || "").slice(0,1400);
          const block = `[${i+1}] ${url}\n${title?title+"\n":""}${txt}\n---\n`;
          if (context.length + block.length > MAX_CHARS) break;
          context += block;
          // Extract name based on content type
          let name = h?.payload?.title || h?.payload?.h1 || h?.payload?.course_name;
          
          // If no name found, try to extract from URL or text
          if (!name || name === url) {
            // For course pages, try to extract course name from URL path
            const urlMatch = url.match(/\/courses\/([^\/]+)/);
            if (urlMatch) {
              name = urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            } else {
              // For articles, try multiple extraction methods
              // 1. Look for article title in URL path
              const articleMatch = url.match(/\/articles\/([^\/]+)/);
              if (articleMatch) {
                name = articleMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
              } else {
                // 2. Use the first line of text as title if available
                const firstLine = txt.split('\n')[0]?.trim();
                if (firstLine && firstLine.length > 10 && firstLine.length < 150) {
                  name = firstLine;
                } else {
                  // 3. Try to extract course name from text content for course pages
                  const textMatch = txt.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Country Club|Golf Club|Golf Course))/);
                  if (textMatch) {
                    name = textMatch[1];
                  } else {
                    name = url; // Fallback to URL
                  }
                }
              }
            }
          }
          
          // Only add if name is meaningful and not too generic
          if (name && name.length > 5 && name !== url && !name.includes('|')) {
            links.push({ url, name });
          }
        }

        // Add course hits to links array
        for (const h of courseHits.slice(0, 5)) { // Reduced from 10 to 5
          const url = h?.payload?.url || h?.payload?.course_url || "";
          const name = h?.payload?.course_name || h?.payload?.name || "";
          if (url && name && !links.some(l => l.url === url) && name.length > 5) {
            links.push({ url, name });
          }
        }

        // Build course names list for the AI to use (limit to top 5 to prevent overwhelming)
        const topLinks = links.slice(0, 5); // Limit to top 5 links to prevent AI confusion
        const courseNames = topLinks.map(l => l.name).filter(Boolean);
        const courseNamesText = courseNames.length > 0 ? 
          `\n# Available Course Names (use ONLY 1-2 of these exact names in your response):
${courseNames.map(name => `- ${name}`).join('\n')}` : '';
        

        const systemContent = `You are a friendly golf buddy who knows course details from the site context.
        - Base everything ONLY on the Site Context. No guessing.
        - Keep answers short (2–4 sentences).
        - Use citations like [n] for facts.
        - If nothing relevant is in context, say: "${REFUSAL}".
        - IMPORTANT: Use the exact course names from the "Available Course Names" list below in your response.
        # Site Context
        ${context}${courseNamesText}`;

        const completion = await openai.chat.completions.create({
          model:"gpt-4o-mini",
          messages:[{ role:"system", content: systemContent }, ...messages.filter(m=>m.role==="user")],
          temperature:0.3, max_tokens:450
        });
        let reply = (completion.choices[0]?.message?.content || "").trim();
        if (!reply && links.length===0) return res.json({ html: REFUSAL });
        
        // Post-process the reply to clean up course name duplications
        if (links.length > 0) {
          for (const link of links) {
            const exactName = link.name;
            if (!exactName) continue;
            
            // Fix common duplications like "Wayland Country ClubCountry Club"
            const duplicationPatterns = [
              // Exact duplication: "Wayland Country ClubWayland Country Club"
              new RegExp(`\\b${exactName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}${exactName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, 'gi'),
              // Partial duplication: "Wayland Country ClubCountry Club"
              new RegExp(`\\b${exactName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}Country Club\\b`, 'gi'),
              new RegExp(`\\b${exactName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}Golf Club\\b`, 'gi'),
              new RegExp(`\\b${exactName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}Golf Course\\b`, 'gi')
            ];
            
            for (const pattern of duplicationPatterns) {
              reply = reply.replace(pattern, exactName);
            }
          }
        }


        const sections=[];
        if (reply && reply !== REFUSAL) {
          // Check for repetitive text and truncate if needed
          let cleanReply = reply;
          if (reply.length > 2000) {
            // If response is too long, it might be repetitive - truncate it
            cleanReply = reply.substring(0, 2000) + "...";
          }
          
          // Simple post-processing: convert course names to clickable links
          for (const link of topLinks.slice(0, 2)) { // Only process top 2 links to avoid confusion
            if (link.name && link.url && link.name.length > 5) {
              const safeUrl = link.url.replace(/"/g, '%22');
              const escapedName = link.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const regex = new RegExp(`\\b${escapedName}\\b`, 'gi');
              cleanReply = cleanReply.replace(regex, (match) => 
                `<a href="#" onclick="showCourseProfile('${safeUrl}'); return false;">${match}</a>`
              );
            }
          }
          
          sections.push(`<p>${cleanReply}</p>`);
        } else {
          sections.push("Here are relevant pages on our site:");
          if (links.length) {
            const dedup = new Map();
            for (const l of links) {
              if (!dedup.has(l.url)) dedup.set(l.url, l);
            }
            const unique = [...dedup.values()];
            const html = unique.map(({ url, name }) => {
              const safeU = String(url).replace(/"/g, '%22');
              const safeN = String(name || url).replace(/[<>]/g, s => ({'<':'&lt;','>':'&gt;'}[s]));
              // Primary link opens the profile panel; include a small external visit link
              return `• <a href="#" onclick="showCourseProfile('${safeU}'); return false;">${safeN}</a> <a href='${safeU}' target='_blank' rel='noreferrer' style='font-size:12px;margin-left:6px'>Visit</a>`;
            }).join("<br/>");
            sections.push("<strong>Courses</strong><br/>" + html);
          }
        }
        return res.json({ 
          html: sections.join("<br/><br/>"),
          links: links.length > 0 ? links : null
        });

      } catch (error) {
        console.warn("[rag] RAG failed:", error.message);
        return res.json({
          html: `I can help you with golf courses! The search system is temporarily unavailable, but you can type "start" to begin the quiz.`
        });
      }
    }

    // LOCATION capture (no upstream /answer) - using direct engine call
    if (state.mode==="quiz" && state.needsLocation && lastUser.startsWith("LOCATION:")){
      const parts = lastUser.split(":");
      const zipCode = parts[1]?.trim() || "";
      const radius  = parseInt(parts[2]) || 25;

      let locationData = { zipCode, radius, coords:null, city:null, state:null };
      if (zipCode) {
        try {
          const r=await fetch(`https://api.zippopotam.us/us/${zipCode}`);
          if (r.ok){
            const geo=await r.json(); const p=geo?.places?.[0];
            if (p){
              locationData.coords={lat:parseFloat(p.latitude), lon:parseFloat(p.longitude)};
              locationData.city = p["place name"];
              locationData.state= p["state abbreviation"];
            }
          }
        } catch {}
      }

      state.location = locationData;
      SESS.set(sid,state);

      // Location stored in session only, not saved to database

      state.needsLocation=false; state.needsWhen=true;
      SESS.set(sid,state);

      return res.json({ html: `
        <div style="font-size:18px;font-weight:600;margin:0 0 20px;color:#333">When would you like to play?</div>
        <div style="margin:10px 0">
          <input type="date" id="playdate"
                 style="padding:8px;border:1px solid #ddd;border-radius:6px;width:200px;margin-right:8px">
          <button onclick="(function(){
            var date=document.getElementById('playdate').value.trim();
            var box=document.getElementById('box');
            if(box){ box.value='WHEN:'+date+'::any'; document.getElementById('btn').click(); }
          })()" style="margin-left:8px;padding:8px 12px;background:#0a7;color:white;border:none;border-radius:6px;cursor:pointer">Continue</button>
        </div>`, suppressSidecar:true });
    }

    // WHEN capture (no upstream /answer) → fetch first MC question - using direct engine call
    if (state.mode==="quiz" && state.needsWhen && lastUser.startsWith("WHEN:")) {
      try {
        const [_,from="",to="",bucket=""] = lastUser.split(":");
        // Set availability with proper date formatting for frontend display
        state.availability = { 
          ...(from && {from}), 
          ...(to && {to}), 
          ...(bucket && {bucket}),
          date: from, // Set the date for frontend display
          original: from // Set the original date string for frontend display
        };
        SESS.set(sid,state);

        // Availability stored in session only, not saved to database

        const startAns = await startSession({
          skipLocation: true,
          sessionId: state.sessionId,
          location: state.location,
          availability: state.availability
        });

        if (!startAns || !startAns.question) return res.json({ html:"Sorry, I couldn't start the quiz. Try again." });

        state.needsWhen=false; 
        state.question=startAns.question; 
        state.questionNumber=startAns.questionNumber || 1; // Set initial question number
        SESS.set(sid,state);
        return res.json({ 
          html: renderQuestionHTML(state.question), 
          suppressSidecar:true,
          profile: {
            location: state.location,
            availability: state.availability,
            quizProgress: `Quiz in progress - Question ${state.questionNumber}`,
            scores: state.scores
          }
        });
      } catch (error) {
        console.error("Quiz WHEN capture error:", error);
        return res.json({ html:"Sorry, I couldn't continue the quiz. Try again." });
      }
    }

    // NUMERIC pick - using direct engine call
    const pickOnly = lastUser.match(/^(?:pick|answer|option)?\s*(\d+)\s*$/i);
    if (pickOnly && state.mode==="quiz" && state.sessionId && state.question?.id){
      try {
        const idx = Number(pickOnly[1]);
        const answeredId = state.question.id;

        const payload = {
          sessionId: state.sessionId,
          questionId: answeredId,
          optionIndex: idx,
          currentAnswers: state.answers,
          currentScores: state.scores,
          location: state.location,
          availability: state.availability,
          userId: uid
        };

        const apiAns = await submitAnswer(payload);
        if (!apiAns) return res.json({ html:"Thanks! I couldn't fetch the next question; try 'start' again." });

        state.answers = apiAns.currentAnswers || state.answers;
        state.scores  = apiAns.currentScores  || state.scores;
        state.question= apiAns.question       || null;

        // Save session progress to database
        try {
          await saveSessionProgress(uid, state.sessionId, state.answers, state.scores, answeredId);
        } catch (error) {
          console.error("Failed to save session progress:", error);
        }

        if (apiAns.complete){
          state.mode=null; state.question=null; SESS.set(sid,state);
          const html = renderFinalProfileHTML(apiAns.profile, apiAns.scores ?? state.scores, apiAns.totalQuestions ?? 0).replace(/\n/g,"<br/>");
          return res.json({ html });
        }
        if (state.question){ 
          // Update question number from the API response
          if (apiAns.questionNumber) {
            state.questionNumber = apiAns.questionNumber;
          }
          SESS.set(sid,state); 
          return res.json({ 
            html: renderQuestionHTML(state.question), 
            suppressSidecar:true,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: `Quiz in progress - Question ${state.questionNumber || 1}`,
              scores: state.scores
            }
          }); 
        }
        return res.json({ html:"Thanks! I couldn't fetch the next question; try 'start' again." });
      } catch (error) {
        console.error("Quiz answer error:", error);
        return res.json({ html:"Sorry, there was an error processing your answer. Try again." });
      }
    }

    // FREE-TEXT → classify → submit - using direct engine call
    if (state.mode==="quiz" && state.sessionId && state.question?.id){
      try {
        // Ensure options
        if (!Array.isArray(state.question.options) || !state.question.options.length){
          const qd = await getQuestion({ questionId: state.question.id });
          if (qd && qd.options) state.question.options = qd.options;
        }

        let idx=0;
        try{
          const options=(state.question.options||[]).map((o,i)=>({
            index: (o.index ?? o.option_index ?? i),
            text: String(o.text ?? o.option_text ?? "")
              .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+/gu,"")
              .toLowerCase().trim()
          }));
          const user=lastUser.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+/gu,"").toLowerCase().trim();
          const m=user.match(/^\d+$/);
          if (m && options.some(o=>o.index===Number(m[0]))) idx=Number(m[0]);
          else{
            const exact=options.find(o=>o.text===user);
            if (exact) idx=exact.index; else{
              const partial=options.find(o=>o.text && o.text.includes(user));
              if (partial) idx=partial.index;
            }
          }
        }catch{ idx=0; }

        const answeredId = state.question.id;
        const ftPayload = {
          sessionId: state.sessionId,
          questionId: answeredId,
          optionIndex: idx,
          currentAnswers: state.answers,
          currentScores: state.scores,
          location: state.location,
          availability: state.availability,
          userId: uid
        };

        const ftAns = await submitAnswer(ftPayload);
        if (!ftAns) return res.json({ html:"Thanks! I couldn't fetch the next question; try 'start' again." });

        state.answers = ftAns.currentAnswers || state.answers;
        state.scores  = ftAns.currentScores  || state.scores;
        state.question= ftAns.question       || null;

        // Save session progress to database
        try {
          await saveSessionProgress(uid, state.sessionId, state.answers, state.scores, answeredId);
        } catch (error) {
          console.error("Failed to save session progress:", error);
        }

        if (ftAns.complete){
          state.mode=null; state.question=null; SESS.set(sid,state);
          const html = renderFinalProfileHTML(ftAns.profile, ftAns.scores ?? state.scores, ftAns.totalQuestions ?? 0).replace(/\n/g,"<br/>");
          return res.json({ html });
        }
        if (state.question){ 
          // Update question number from the API response
          if (ftAns.questionNumber) {
            state.questionNumber = ftAns.questionNumber;
          }
          SESS.set(sid,state); 
          return res.json({ 
            html: renderQuestionHTML(state.question), 
            suppressSidecar:true,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: `Quiz in progress - Question ${state.questionNumber || 1}`,
              scores: state.scores
            }
          });
        }
        return res.json({ html:"Thanks! I couldn't fetch the next question; try 'start' again." });
      } catch (error) {
        console.error("Quiz text answer error:", error);
        return res.json({ html:"Sorry, there was an error processing your answer. Try again." });
      }
    }

    // Default
    return res.json({ html: 'Tell me what you\'re looking for – try "courses in Wayland" or type "start" to begin the quiz.' });

  } catch (e) {
    console.error("chat error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

export default router;
