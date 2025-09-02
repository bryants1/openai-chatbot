// server.js — Chat + Quiz + RAG over site_docs
// Features: Voyage re-rank (fail-open), list-intent output, location-aware retrieval,
// pretty HTML, sidecar (GET & POST), and working quiz handoff (Render-safe).

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch"; // robust for Node < 18 too
import chatbotRouter from "./api/golfChatbotRouter.js";

// ──────────────────────────────────────────────────────────────────────────────
// ENV
const REFUSAL = "I don’t have that in the site content.";
const DEBUG_RAG = process.env.DEBUG_RAG === "1";

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const QDRANT_URL       = process.env.QDRANT_URL;
const QDRANT_API_KEY   = process.env.QDRANT_API_KEY || "";
const QDRANT_COLL      = process.env.QDRANT_COLLECTION || "site_docs";
const SITE_VECTOR_NAME = (process.env.SITE_VECTOR_NAME || "").trim();
const VOYAGE_API_KEY      = (process.env.VOYAGE_API_KEY || "").trim();
const VOYAGE_RERANK_MODEL = (process.env.VOYAGE_RERANK_MODEL || "rerank-2-lite").trim();
const PORT = process.env.PORT || 8080;

// IMPORTANT: local self-calls for quiz (works behind proxies on Render)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/,"");
const SELF_BASE = PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;

if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
if (!QDRANT_URL)     { console.error("Missing QDRANT_URL");     process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

const app = express();
app.set("trust proxy", 1);         // honor X-Forwarded-Proto on Render
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers

function isListIntent(q) {
  if (!q) return false;
  const s = q.toLowerCase();
  return /(best|top|list|recommend|recommendation|near|close to|within|under\s*\$?\d+|courses?\s+(in|near|around)|bucket\s*list)/i.test(s);
}
function normalizeText(s) {
  return (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
}
function anchor(u) {
  const esc = (t) => t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  try { const url = new URL(u); return `<a href="${esc(url.toString())}" target="_blank" rel="noreferrer">${esc(url.toString())}</a>`; }
  catch { return esc(u); }
}

// Markdown-ish -> HTML for LLM replies
function renderReplyHTML(text = "") {
  const mdLink = (s) =>
    s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
      const safe = url.replace(/"/g, "%22");
      return `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`;
    });
  const lines = String(text).split(/\r?\n/);
  let html = [], listOpen = false, para = [];
  const flushPara = () => {
    if (para.length) { html.push(`<p>${mdLink(para.join(" "))}</p>`); para = []; }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); if (listOpen) { html.push("</ul>"); listOpen = false; } continue; }
    if (/^([•\-\*]\s+)/.test(line)) {
      flushPara();
      if (!listOpen) { html.push("<ul>"); listOpen = true; }
      html.push(`<li>${mdLink(line.replace(/^([•\-\*]\s+)/, "").trim())}</li>`);
    } else { para.push(line); }
  }
  flushPara(); if (listOpen) html.push("</ul>");
  return html.join("");
}

// Quiz render helpers
function renderQuestionHTML(q, num = 1) {
  const lines = (q.options || [])
    .map((o, i) => `<li>${i}. ${o.emoji || ""} ${o.text}</li>`).join("");
  return `<strong>Question ${num}:</strong> ${q.text}<ul>${lines}</ul><div>Reply like: "pick 1" or just "1".</div>`;
}
function renderFinalProfileHTML(profile = {}, scores = {}, total = 0) {
  const skill   = profile.skillLevel || profile.skill?.label || "-";
  const persona = profile.personality || profile.personality?.primary || "-";
  const rec     = profile.recommendations || {};
  const whyArr  = Array.isArray(rec.why) ? rec.why : (Array.isArray(profile.why) ? profile.why : []);
  const prefs   = profile.preferences?.core || [];
  const courses = profile.matchedCourses || [];
  const lodging  = rec.lodging || profile.lodging || "";
  const ml = rec.mlInsights || profile.mlInsights || null;
  const alt = rec.alternativeOptions || profile.alternativeOptions || null;
  const altStyles = Array.isArray(alt?.courseStyles)
    ? alt.courseStyles.map(s => (typeof s === "string" ? s : (s.style || ""))).filter(Boolean) : [];
  const lines = [];
  lines.push(`You've completed the quiz! Here's your profile:\n`);
  lines.push(`Skill Level: ${skill}`);
  lines.push(`Personality: ${persona}\n`);
  lines.push(`Recommendations`);
  lines.push(`• Style: ${rec.courseStyle || "-"}`);
  lines.push(`• Budget: ${rec.budgetLevel || "-"}`);
  if (Array.isArray(rec.amenities)) { lines.push(`• Amenities:`); rec.amenities.forEach(a => lines.push(`  • ${a}`)); }
  if (lodging) lines.push(`• Lodging: ${lodging}`);
  if (whyArr.length) { lines.push(`\nWhy`); whyArr.forEach(w => lines.push(`• ${w}`)); }
  if (ml) {
    lines.push(`\nML Insights`);
    if (ml.similarUserCount != null) lines.push(`• Based on ${ml.similarUserCount} similar golfers`);
    if (ml.confidence != null)       lines.push(`• Model confidence: ${ml.confidence}`);
    if (ml.dataQuality)              lines.push(`• Data quality: ${ml.dataQuality}`);
  }
  if (altStyles.length) { lines.push(`\nAlternative Course Styles`); altStyles.forEach(s => lines.push(`• ${s}`)); }
  if (courses.length) { lines.push(`\nMatched Courses`); courses.slice(0,6).forEach(c => lines.push(`• ${c.name}${c.score ? ` — score ${Number(c.score).toFixed(3)}` : ""}`)); }
  if (prefs.length) { lines.push(`\nYour Preferences`); prefs.forEach(p => lines.push(`• ${p}`)); }
  if (Object.keys(scores).length) {
    lines.push(`\nScores`);
    Object.entries(scores).forEach(([k,v]) => {
      const label = k.replace(/([A-Z])/g,' $1');
      lines.push(`• ${label}: ${Number(v).toFixed ? Number(v).toFixed(1) : v}`);
    });
  }
  lines.push(`\nReply “feedback 5 great fit” or “feedback 2 too expensive”.`);
  return lines.join("\n");
}

// Voyage re-rank (fail-open)
async function voyageRerank(query, hits, topN = 40) {
  try {
    if (!VOYAGE_API_KEY || !hits?.length) return hits;
    const url = "https://api.voyageai.com/v1/rerank";
    const documents = hits.map(h => {
      const t = (h?.payload?.title || h?.payload?.h1 || "").toString();
      const x = (h?.payload?.text  || "").toString();
      return (t && x) ? `${t}\n\n${x}` : (t || x) || "";
    });
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: VOYAGE_RERANK_MODEL, query, documents, top_n: Math.min(topN, documents.length) })
    });
    if (!r.ok) return hits;
    const data = await r.json();
    const order = (data?.data || []).map(d => ({ idx: d.index, score: d.relevance_score }));
    if (!order.length) return hits;
    const byIdx = new Map(order.map(o => [o.idx, o.score]));
    return hits.map((h,i)=>({ ...h, _voy: byIdx.has(i) ? byIdx.get(i) : -1e9 }))
               .sort((a,b)=>b._voy - a._voy)
               .map(({_voy, ...h}) => h);
  } catch { return hits; }
}

async function embedQuery(q) {
  const { data } = await openai.embeddings.create({ model: "text-embedding-3-small", input: q });
  return data[0].embedding;
}
async function retrieveSite(question, topK = 120) {
  const vector = await embedQuery(question);
  const body = {
    vector, limit: topK, with_payload: true, with_vectors: false,
    ...(SITE_VECTOR_NAME ? { using: SITE_VECTOR_NAME } : {}),
  };
  const results = await qdrant.search(QDRANT_COLL, body);
  return results || [];
}
function isCourseURL(h) {
  const u = (h?.payload?.url || "").toLowerCase();
  return u.includes("/courses/");
}

// ──────────────────────────────────────────────────────────────────────────────
// Minimal UI
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OpenAI Chatbot</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif;background:#fafafa;color:#222;margin:0}
.container{display:grid;grid-template-columns:2fr 1fr;gap:24px;max-width:1200px;margin:24px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
h1{font-size:20px;margin:0 0 8px} .muted{color:#777} .row{display:flex;gap:8px}
input,textarea{width:100%;padding:12px;border:1px solid #ddd;border-radius:10px}
button{padding:10px 14px;border-radius:10px;border:1px solid #0a7;cursor:pointer}
.msg{padding:10px 12px;border-radius:10px;margin:8px 0}
.me{background:#e9f7ff} .bot{background:#f7f7f7}
pre{white-space:pre-wrap}
</style></head>
<body>
<div class="container">
  <div class="card">
    <h1>OpenAI Chatbot</h1>
    <div class="muted">Try: <code>best courses near boston</code> or <code>start</code> for quiz</div>
    <div id="log"></div>
    <div class="row">
      <textarea id="box" rows="2" placeholder="Type a message…"></textarea>
      <button id="btn">Send</button>
    </div>
  </div>
  <div class="card">
    <h2>Related</h2>
    <div id="side" class="muted">No related info.</div>
  </div>
</div>
<script>
const log = document.getElementById('log');
const box = document.getElementById('box');
const btn = document.getElementById('btn');
const side = document.getElementById('side');
function render(html, isMe){
  const div = document.createElement('div');
  div.className = 'msg ' + (isMe ? 'me' : 'bot');
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
async function sendMessage(){
  const text = box.value.trim();
  if(!text) return;
  render('<strong>You:</strong><br/>' + text, true);
  box.value = '';
  try{
    const r = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ messages:[{role:'user', content:text}] }) });
    const j = await r.json();
    render(j.html || 'I don’t have that in the site content.', false);
  }catch(e){ render('Error: ' + (e.message||e), false); }
  try{
    const r2 = await fetch('/api/sidecar?q=' + encodeURIComponent(text));
    const p = await r2.json();
    side.innerHTML = p.html || '<div class="card">No related info.</div>';
  }catch{ side.innerHTML = '<div class="card">No related info.</div>'; }
}
btn.addEventListener('click', sendMessage);
box.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); }});
window.addEventListener('load', ()=> box.focus());
</script>
</body></html>`);
});

// ──────────────────────────────────────────────────────────────────────────────
// Sessions + quiz
const SESS = new Map();
function getSid(req, res) {
  const cookie = req.headers.cookie || "";
  const m = /sid=([A-Za-z0-9_-]+)/.exec(cookie);
  if (m) return m[1];
  const sid = Math.random().toString(36).slice(2);
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}
app.use("/api/chatbot", chatbotRouter);

// ──────────────────────────────────────────────────────────────────────────────
// Chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const sid = getSid(req, res);
    const state = SESS.get(sid) || { lastLinks: [], sessionId: null, question: null, answers: {}, scores: {} };
    const { messages = [] } = req.body || {};
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content?.trim() || "";
    const locForQuery = (function extractLocation(text = "") {
      const t = text.trim();
      let m = t.match(/\b(?:in|near|around)\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
      if (m) return m[1].replace(/[.,]+$/,'').trim();
      m = t.match(/\b(?:courses?|golf|weather)\s+in\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
      if (m) return m[1].replace(/[.,]+$/,'').trim();
      const words = t.replace(/[^A-Za-z\s-]/g, " ").trim().split(/\s+/);
      if (words.length <= 3 && words.length > 0) return words.join(" ");
      const tail = t.match(/([A-Za-z][A-Za-z\s-]{1,40})$/);
      return tail ? tail[1].trim() : "";
    })(lastUser);

    // QUIZ: start (“start” or “start quiz”) — use SELF_BASE to avoid proxy/proto issues
    if (/^(start|begin|go|let.?s\s*start)(?:\s+quiz)?$/i.test(lastUser)) {
      const r = await fetch(`${SELF_BASE}/api/chatbot/start`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" });
      const data = await r.json().catch(()=>null);
      if (!data || !data.sessionId || !data.question) {
        console.error("Quiz start failed or bad payload:", data);
        return res.json({ html:"Started a new quiz, but I couldn't fetch a question. Try again." });
      }
      state.sessionId = data.sessionId;
      state.question  = data.question || null;
      state.answers   = {};
      state.scores    = {};
      state.lastLinks = [];
      SESS.set(sid, state);
      return res.json({ html: renderQuestionHTML(data.question, data.questionNumber || 1) });
    }

    // QUIZ: numeric pick (“pick 1”, “answer 2”, or just “1”)
    const pickOnly = lastUser.match(/^(?:pick|answer|option)?\s*(\d+)\s*$/i);
    if (pickOnly && state.sessionId && state.question?.id) {
      const idx = Number(pickOnly[1]);
      const payload = {
        sessionId: state.sessionId,
        questionId: state.question.id,
        optionIndex: idx,
        currentAnswers: state.answers,
        currentScores: state.scores
      };
      const r = await fetch(`${SELF_BASE}/api/chatbot/answer`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
      const data = await r.json().catch(()=>null);
      if (!data) return res.json({ html:"Thanks! I couldn’t fetch the next question; try 'start quiz' again." });

      if (data.complete) {
        state.question = null; SESS.set(sid, state);
        const html = renderFinalProfileHTML(data.profile, data.scores, data.totalQuestions).replace(/\n/g,"<br/>");
        return res.json({ html });
      }
      if (data.question) {
        state.question = data.question;
        state.answers  = data.currentAnswers || state.answers;
        state.scores   = data.currentScores  || state.scores;
        SESS.set(sid, state);
        return res.json({ html: renderQuestionHTML(data.question, data.questionNumber || (Object.keys(state.answers||{}).length + 1)) });
      }
      return res.json({ html:"Thanks! I couldn’t fetch the next question; try 'start quiz' again." });
    }

    // If a quiz is in progress, remind
    if (state.sessionId && state.question) {
      return res.json({ html: renderQuestionHTML(state.question, Object.keys(state.answers||{}).length + 1) });
    }

    // Retrieval (location-aware variants)
    const variants = [
      lastUser,
      lastUser.toLowerCase(),
      lastUser.replace(/[^\w\s]/g, " "),
      ...(locForQuery ? [
        `golf courses in ${locForQuery}`,
        `${locForQuery} golf courses`,
        `courses near ${locForQuery}`
      ] : [])
    ].filter(Boolean);

    let siteHits = [];
    for (const v of variants) {
      const hits = await retrieveSite(v, 120);
      siteHits = [...siteHits, ...(hits || [])];
      if (siteHits.length >= 120) break;
    }

    // Voyage re-rank
    siteHits = await voyageRerank(lastUser, siteHits, 40);

    // Dedup by url#chunk
    const seen = new Set();
    siteHits = siteHits.filter(h => {
      const key = `${h.payload?.url}#${h.payload?.chunk_index ?? "html"}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    });

    // Filter + lexical boost
    const qlen = lastUser.split(/\s+/).filter(Boolean).length;
    const dynamicThreshold = 0.06 + Math.min(0.12, qlen * 0.01);
    const tokens = normalizeText(lastUser).split(/\s+/).filter(t => t && t.length > 2);
    function lexBoost(h) {
      const hay = normalizeText((h?.payload?.title || "") + " " + (h?.payload?.text || ""));
      let k = 0; for (const t of tokens) if (hay.includes(t)) k++; return k;
    }
    const goodSite = siteHits
      .filter(h => (h?.score ?? 0) >= dynamicThreshold)
      .map(h => ({ ...h, _lex: lexBoost(h) }));

    // Strong type boost in list mode
    function typeBoost(h){
      if (!isListIntent(lastUser)) return 0;
      const u = (h?.payload?.url || "").toLowerCase();
      if (u.includes("/courses/")) return 0.30;
      if (u.includes("/articles/")) return 0.07;
      return 0;
    }
    goodSite.sort((a,b)=> (b.score + 0.03*b._lex + typeBoost(b)) - (a.score + 0.03*a._lex + typeBoost(a)));

    // Single-site corpus: skip host balancing entirely
    const balanced = goodSite.slice(0, 20);

    // De-dupe by URL and assemble final
    const keep = new Map();
    for (const h of balanced) {
      const key = h.payload?.url || "";
      if (!keep.has(key)) keep.set(key, h);
    }
    let finalHits = [...keep.values()];
    if (isListIntent(lastUser)) {
      const courses  = finalHits.filter(isCourseURL);
      const articles = finalHits.filter(h => !isCourseURL(h));
      finalHits = [...courses, ...articles].slice(0, 12);
    } else {
      finalHits = finalHits.slice(0, 10);
    }

    // Context + links
    const MAX_CHARS = 12000;
    let context = "", links = [];
    for (let i=0;i<finalHits.length;i++){
      const h = finalHits[i];
      const url = h.payload?.url || "";
      const title = h.payload?.title || h.payload?.h1 || "";
      const txt = (h.payload?.text || "").slice(0, 1400);
      const block = `[${i+1}] ${url}\n${title ? (title + "\n") : ""}${txt}\n---\n`;
      if ((context.length + block.length) > MAX_CHARS) break;
      context += block; links.push(url);
    }

    // Prompt
    let systemContent = `You are a friendly golf buddy who knows course details from the site context.
    Your tone should be conversational but accurate and evidence-bound.

    Rules:
    - Base everything ONLY on the Site Context. No guessing or outside knowledge.
    - If there are drawbacks, mention them casually ("watch out for...").
    - Keep answers short (2–4 sentences) for normal questions.
    - Always use citations like [n] for facts.
    - If nothing relevant is in context, say: "${REFUSAL}".

    # Site Context (cite with [n])
    ${context}`;
    if (isListIntent(lastUser)) {
      systemContent = `You are a friendly golf buddy who extracts concrete answers from the Site Context.
      The user asked for recommendations. Produce a clear, scannable LIST, not a generic summary.

      Strict rules for list mode:
      - Use ONLY course pages present in the Site Context; do NOT invent items.
      - Each bullet MUST cite a UNIQUE [n] that corresponds to that exact course page.
      - At most one bullet per source [n].
      - If fewer than 5 courses are present, return the available ones only.

      Output format:
      - Bullets like: • [Course Name](URL) — 1 short reason from the context, with a [n] citation.

      # Site Context (cite with [n])
      ${context}`;
    }

    // LLM
    let reply = "";
    try {
      const completion = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [{ role: "system", content: systemContent }, ...messages.filter(m => m.role === "user")],
        temperature: 0.3,
        max_output_tokens: 450,
      });
      const parts = completion.output ?? [];
      reply = parts.map(p => p?.content?.map(c => c.text || "").join("") || "").join("");
      reply = (reply || "").trim();
      if (DEBUG_RAG) console.log("LLM reply:", reply.slice(0,200));
    } catch (e) {
      console.warn("OpenAI summarize failed:", e?.message || e);
      reply = "";
    }

    const allLinks = [...new Set(links)];
    if (!reply && !allLinks.length) return res.json({ html: REFUSAL });

    const sections = [];
    if (reply && reply !== REFUSAL) sections.push(renderReplyHTML(reply));
    else sections.push("Here are relevant pages on our site:");
    if (allLinks.length) {
      const sourcesHtml = allLinks.map(u => "• " + anchor(u)).join("<br/>");
      sections.push("<strong>Sources</strong><br/>" + sourcesHtml);
      SESS.set(sid, { ...state, lastLinks: allLinks.slice(0,12) });
    } else {
      SESS.set(sid, { ...state, lastLinks: [] });
    }
    return res.json({ html: sections.join("<br/><br/>") });
  } catch (e) {
    console.error("chat error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Sidecar (GET & POST)
app.get("/api/sidecar", async (req, res) => {
  try {
    const q = (req.query.q || req.query.text || "").toString();
    const html = await buildSidecar(q);
    return res.json({ html });
  } catch (e) { console.warn("sidecar error:", e?.message || e); return res.json({ html: "" }); }
});
app.post("/api/sidecar", async (req, res) => {
  try {
    const q = (req.body?.q || req.body?.text || "").toString();
    const html = await buildSidecar(q);
    return res.json({ html });
  } catch (e) { console.warn("sidecar error:", e?.message || e); return res.json({ html: "" }); }
});

async function buildSidecar(q) {
  try {
    const loc = (function extractLocation(text = "") {
      const t = text.trim();
      let m = t.match(/\b(?:in|near|around)\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
      if (m) return m[1].replace(/[.,]+$/,'').trim();
      m = t.match(/\b(?:courses?|golf|weather)\s+in\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
      if (m) return m[1].replace(/[.,]+$/,'').trim();
      const words = t.replace(/[^A-Za-z\s-]/g, " ").trim().split(/\s+/);
      if (words.length <= 3 && words.length > 0) return words.join(" ");
      const tail = t.match(/([A-Za-z][A-Za-z\s-]{1,40})$/);
      return tail ? tail[1].trim() : "";
    })(q || "");
    if (!loc) return "";
    const geo = await geocode(loc);
    if (!geo) return "";
    const wx = await fetchWeather(geo.lat, geo.lon);
    return renderWeatherCard(geo, wx);
  } catch { return ""; }
}
async function geocode(place) {
  const url = "https://geocode.maps.co/search?q=" + encodeURIComponent(place) + "&format=json";
  const r = await fetch(url, { headers: { "User-Agent": "totalguide-chat/1.0" } });
  const j = await r.json().catch(() => []);
  if (!Array.isArray(j) || !j.length) return null;
  const best = j.find(x => /United States|USA|Massachusetts|MA/i.test(x.display_name)) || j[0];
  return { lat: Number(best.lat), lon: Number(best.lon), name: best.display_name };
}
async function fetchWeather(lat, lon) {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat +
              "&longitude=" + lon +
              "&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto";
  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  return j;
}
function renderWeatherCard(geo, wx) {
  if (!wx || (!wx.current_weather && !wx.current)) return "";
  const cur = wx.current_weather || wx.current || {};
  const temp = cur.temperature_2m ?? cur.temperature ?? "–";
  const wind = cur.wind_speed_10m ?? cur.windspeed ?? "–";
  const d = wx.daily || {};
  const time = d.time || [];
  const tmax = d.temperature_2m_max || [];
  const tmin = d.temperature_2m_min || [];
  const prec = d.precipitation_sum || [];
  let rows = "";
  const days = Math.min(time.length, 3);
  for (let i = 0; i < days; i++) {
    rows += '<div style="display:flex;justify-content:space-between;border-top:1px solid #eee;padding:6px 0">' +
              '<span>' + (time[i] ?? "") + '</span>' +
              '<span>' + (tmin[i] ?? "") + '–' + (tmax[i] ?? "") + '°</span>' +
              '<span>' + (prec[i] ?? 0) + 'mm</span>' +
            '</div>';
  }
  return '' +
    '<div class="card">' +
      '<div style="font-weight:600;margin-bottom:6px">Weather – ' + geo.name + '</div>' +
      '<div>Now: ' + temp + '°C, wind ' + wind + ' km/h</div>' +
      '<div style="margin-top:8px;font-weight:600">Next days</div>' +
      (rows || '<div>No forecast.</div>') +
      '<div style="margin-top:10px;font-size:12px;color:#666">Source: ' +
      '<a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>' +
      '</div>' +
    '</div>';
}

// ──────────────────────────────────────────────────────────────────────────────
// Health & debug
app.use("/api/chatbot", chatbotRouter); // keep proxy router
app.get("/api/ping", (_, res) => res.json({ ok: true }));
app.get("/api/debug/site-top", async (req, res) => {
  try {
    const { data } = await openai.embeddings.create({ model: "text-embedding-3-small", input: (req.query.q || "wayland").toString() });
    const vector = data[0].embedding;
    const body = { vector, limit: 10, with_payload: true, with_vectors: false, ...(SITE_VECTOR_NAME ? { using: SITE_VECTOR_NAME } : {}) };
    const results = await qdrant.search(QDRANT_COLL, body);
    const out = (results || []).map(r => ({ score: r.score, url: r.payload?.url, title: r.payload?.title, preview: (r.payload?.text || "").slice(0,160) }));
    res.json({ q: req.query.q || "wayland", collection: QDRANT_COLL, using: SITE_VECTOR_NAME || "(default)", out });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log("Server listening on", PORT));
