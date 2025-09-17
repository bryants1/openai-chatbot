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
 * Course search intent detection
 * ────────────────────────────────────────────────────────────────────────── */
function detectCourseSearchIntent(text = "") {
  const t = (text || "").toLowerCase();
  
  const courseKeywords = [
    'course', 'courses', 'golf course', 'golfing', 'play golf', 'tee time',
    'beginner', 'intermediate', 'advanced', 'difficulty', 'skill level',
    'looking for', 'find', 'recommend', 'suggest', 'best course'
  ];

  const locationKeywords = [
    'near', 'around', 'in', 'close to', 'within', 'area', 'location'
  ];

  const timeKeywords = [
    'today', 'tomorrow', 'weekend', 'this week', 'next week', 'morning', 'afternoon', 'evening'
  ];

  // Check if text contains course-related keywords
  const hasCourseIntent = courseKeywords.some(keyword => t.includes(keyword));
  const hasLocationIntent = locationKeywords.some(keyword => t.includes(keyword));
  const hasTimeIntent = timeKeywords.some(keyword => t.includes(keyword));

  // Extract location and date info
  const location = extractLocation(text);
  const dateInfo = extractDateInfo(text);

  return {
    isCourseSearch: hasCourseIntent,
    hasLocation: hasLocationIntent || location.length > 0,
    hasTime: hasTimeIntent || dateInfo !== null,
    location: location,
    dateInfo: dateInfo,
    confidence: (hasCourseIntent ? 1 : 0) + (hasLocationIntent ? 0.5 : 0) + (hasTimeIntent ? 0.3 : 0)
  };
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
    // Use Nominatim (OpenStreetMap) free geocoding service
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cityName)}&limit=1&countrycodes=us`);
    const data = await response.json();
    
    if (data && data.length > 0) {
      const result = data[0];
      return {
        lat: parseFloat(result.lat),
        lon: parseFloat(result.lon),
        display_name: result.display_name,
        city: result.name || cityName
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

function renderQuizSuggestionHTML(intent, state) {
  const { location, dateInfo } = intent;
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
          var box=document.getElementById('box');
          if(box){ box.value='yes'; document.getElementById('btn').click(); }
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

function renderReplyHTML(text=""){
  const md=(s)=>s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(m,l,u)=>`<a href="${u.replace(/"/g,"%22")}" target="_blank" rel="noreferrer">${l}</a>`);
  const lines=String(text).split(/\r?\n/);let html=[],list=false,para=[];
  const flush=()=>{if(para.length){html.push(`<p>${md(para.join(" "))}</p>`);para=[]}};
  for(const raw of lines){const line=raw.trim();
    if(!line){flush();if(list){html.push("</ul>");list=false}continue}
    if(/^([•\-\*]\s+)/.test(line)){flush();if(!list){html.push("<ul>");list=true}
      html.push(`<li>${md(line.replace(/^([•\-\*]\s+)/,"").trim())}</li>`)}
    else para.push(line)}
  flush();if(list)html.push("</ul>");return html.join("");
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
      lines.push(`• ${name}${score}`);
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

    // Exit quiz
    if (/^\s*(cancel|stop|exit|end)\s*(quiz)?\s*$/i.test(lastUser)) {
      SESS.set(sid, newChatState());
      return res.json({ html: "Got it – I've exited the quiz. Ask anything or type 'start' to begin again." });
    }

    const isStart = /^\s*(start|start quiz)\s*$/i.test(lastUser);

    // Extract location/date from any message and store in session
    if (!state.mode) {
      const courseIntent = detectCourseSearchIntent(lastUser);
      if (courseIntent.location && !state.location) {
        // Geocode the location to get coordinates
        const geocoded = await geocodeCity(courseIntent.location);
        if (geocoded) {
          state.location = { 
            city: geocoded.city, 
            coords: { lat: geocoded.lat, lon: geocoded.lon }, 
            zipCode: null, 
            radius: 25,
            display_name: geocoded.display_name
          };
        } else {
          // If geocoding fails, store just the city name and ask for clarification
          state.location = { 
            city: courseIntent.location, 
            coords: null, 
            zipCode: null, 
            radius: 25,
            needsClarification: true
          };
        }
      }
      if (courseIntent.dateInfo && !state.availability) {
        // Store extracted date
        state.availability = {
          date: courseIntent.dateInfo.date,
          type: courseIntent.dateInfo.type
        };
      }
      if (courseIntent.location || courseIntent.dateInfo) {
        SESS.set(sid, state);
      }
    }

    // Check for course search intent and suggest quiz
    if (!isStart && !state.mode) {
      const courseIntent = detectCourseSearchIntent(lastUser);
      console.log('Course intent detection:', { lastUser, courseIntent });
      if (courseIntent.isCourseSearch && courseIntent.confidence > 0.5) {
        // Show quiz suggestion with detected location/date
        const suggestionHTML = renderQuizSuggestionHTML(courseIntent, state);
        state.pendingQuizSuggestion = courseIntent;
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
    if (state.pendingQuizSuggestion && (lastUser.toLowerCase() === 'yes' || lastUser.toLowerCase() === 'y')) {
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
        
        // If we have both location and date, start with first question
        if (startAns.question) {
          state.mode="quiz";
          state.sessionId=startAns.sessionId;
          state.question=startAns.question;
          state.pendingQuizSuggestion = null; // Clear the pending suggestion
          SESS.set(sid,state);
          return res.json({ 
            html: renderQuestionHTML(state.question), 
            suppressSidecar:true,
            profile: {
              location: state.location,
              availability: state.availability,
              quizProgress: "Quiz started - question 1",
              scores: state.scores
            }
          });
        }
        
      } catch (error) {
        console.error("Quiz start from suggestion error:", error);
        return res.json({ html:"Sorry, I couldn't start the quiz right now." });
      }
    }

    // Handle quiz start FIRST, before RAG - using direct engine call
    if (isStart) {
      try {
        // Check if we already have location and date information
        const hasLocation = state.location && (state.location.coords || state.location.city);
        const hasDate = state.availability && state.availability.date;
        
        const startAns = await startSession({
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
      } catch (error) {
        console.error("Quiz start error:", error);
        return res.json({ html:"Sorry, I couldn't start the quiz right now." });
      }
    }

    // RAG by default (not in quiz and not already handled)
    if (state.mode !== "quiz" && !isStart) {
      try {
        const locForQuery = extractLocation(lastUser);
        const variants = [
          lastUser, lastUser.toLowerCase(), lastUser.replace(/[^\w\s]/g, " "),
          ...(locForQuery ? [`golf courses in ${locForQuery}`, `${locForQuery} golf courses`, `courses near ${locForQuery}`] : [])
        ].filter(Boolean);

        let siteHits=[];
        for (const v of variants){
          const hits=await retrieveSite(v,120);
          siteHits=[...siteHits, ...(hits||[])];
          if (siteHits.length >= 120) break;
        }
        siteHits = await voyageRerank(lastUser, siteHits, 40);

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
        const finalHits = [...keep.values()].slice(0, isListIntent(lastUser) ? 12 : 10);

        const MAX_CHARS=12000; let context="", links=[];
        for (let i=0;i<finalHits.length;i++){
          const h=finalHits[i];
          const url=h?.payload?.url || "";
          const title=h?.payload?.title || h?.payload?.h1 || "";
          const txt=(h?.payload?.text || "").slice(0,1400);
          const block = `[${i+1}] ${url}\n${title?title+"\n":""}${txt}\n---\n`;
          if (context.length + block.length > MAX_CHARS) break;
          context += block; links.push(url);
        }

        const systemContent = `You are a friendly golf buddy who knows course details from the site context.
        - Base everything ONLY on the Site Context. No guessing.
        - Keep answers short (2–4 sentences).
        - Use citations like [n] for facts.
        - If nothing relevant is in context, say: "${REFUSAL}".
        # Site Context
        ${context}`;

        const completion = await openai.chat.completions.create({
          model:"gpt-4o-mini",
          messages:[{ role:"system", content: systemContent }, ...messages.filter(m=>m.role==="user")],
          temperature:0.3, max_tokens:450
        });
        const reply = (completion.choices[0]?.message?.content || "").trim();
        if (!reply && links.length===0) return res.json({ html: REFUSAL });

        const sections=[];
        if (reply && reply !== REFUSAL) sections.push(renderReplyHTML(reply));
        else sections.push("Here are relevant pages on our site:");
        if (links.length) sections.push("<strong>Sources</strong><br/>" + [...new Set(links)].map(u=>"• <a href='"+u+"' target='_blank' rel='noreferrer'>"+u+"</a>").join("<br/>"));
        return res.json({ html: sections.join("<br/><br/>") });

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
        state.availability = { ...(from && {from}), ...(to && {to}), ...(bucket && {bucket}) };
        SESS.set(sid,state);

        // Availability stored in session only, not saved to database

        const startAns = await startSession({
          skipLocation: true,
          sessionId: state.sessionId,
          location: state.location,
          availability: state.availability
        });

        if (!startAns || !startAns.question) return res.json({ html:"Sorry, I couldn't start the quiz. Try again." });

        state.needsWhen=false; state.question=startAns.question; SESS.set(sid,state);
        return res.json({ html: renderQuestionHTML(state.question), suppressSidecar:true });
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
        if (state.question){ SESS.set(sid,state); return res.json({ html: renderQuestionHTML(state.question), suppressSidecar:true }); }
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
        if (state.question){ SESS.set(sid,state); return res.json({ html: renderQuestionHTML(state.question), suppressSidecar:true }); }
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
