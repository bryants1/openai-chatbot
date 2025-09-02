// server.js — Chat + Quiz + RAG over site_docs (Voyage re-rank + list intent + fixed sidecar)

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import chatbotRouter from "./api/golfChatbotRouter.js";

// ──────────────────────────────────────────────────────────────────────────────
// ENV needed:
// OPENAI_API_KEY=...
// QDRANT_URL=https://<cluster>.aws.cloud.qdrant.io
// QDRANT_API_KEY=... (if private)
// QDRANT_COLLECTION=site_docs
// SITE_BASE=https://golf.totalguide.net
// PUBLIC_BASE_URL=... (optional)
// Optional named vector for site_docs: SITE_VECTOR_NAME=text
// VOYAGE_API_KEY=...      (optional but recommended)
// VOYAGE_RERANK_MODEL=rerank-2-lite  (or rerank-2)
// DEBUG_RAG=1  (optional)
// ──────────────────────────────────────────────────────────────────────────────

const REFUSAL = "I don’t have that in the site content.";
const DEBUG_RAG = process.env.DEBUG_RAG === "1";

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const QDRANT_URL       = process.env.QDRANT_URL;
const QDRANT_API_KEY   = process.env.QDRANT_API_KEY || "";
const QDRANT_COLL      = process.env.QDRANT_COLLECTION || "site_docs";
const SITE_BASE        = (process.env.SITE_BASE || "").replace(/\/+$/, "");
const SITE_VECTOR_NAME = (process.env.SITE_VECTOR_NAME || "").trim();
const PUBLIC_BASE_URL  = process.env.PUBLIC_BASE_URL || "";

const VOYAGE_API_KEY      = (process.env.VOYAGE_API_KEY || "").trim();
const VOYAGE_RERANK_MODEL = (process.env.VOYAGE_RERANK_MODEL || "rerank-2-lite").trim();

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY"); process.exit(1);
}
if (!QDRANT_URL) {
  console.error("Missing QDRANT_URL (site_docs)."); process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers

// Detect list-style intent (e.g., “best/top/near/under $…”)
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

// Convert simple markdown bullets/links into HTML for nicer answers
function renderReplyHTML(text = "") {
  const mdLink = (s) =>
    s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
      const safe = url.replace(/"/g, "%22");
      return `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`;
    });

  const lines = String(text).split(/\r?\n/);
  let html = [], listOpen = false, para = [];

  function flushPara() {
    if (para.length) {
      const p = mdLink(para.join(" "));
      html.push(`<p>${p}</p>`);
      para = [];
    }
  }

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      if (listOpen) { html.push("</ul>"); listOpen = false; }
      continue;
    }
    if (/^([•\-\*]\s+)/.test(line)) {
      flushPara();
      if (!listOpen) { html.push("<ul>"); listOpen = true; }
      const item = line.replace(/^([•\-\*]\s+)/, "").trim();
      html.push(`<li>${mdLink(item)}</li>`);
    } else {
      para.push(line);
    }
  }
  flushPara();
  if (listOpen) html.push("</ul>");
  return html.join("");
}

// Voyage re-rank (fail-open). Input = Qdrant hits array.
async function voyageRerank(query, hits, topN = 40) {
  try {
    if (!VOYAGE_API_KEY || !hits?.length) return hits;
    const url = "https://api.voyageai.com/v1/rerank";
    const documents = hits.map(h => {
      const t = (h?.payload?.title || h?.payload?.h1 || "").toString();
      const x = (h?.payload?.text  || "").toString();
      const combined = (t && x) ? `${t}\n\n${x}` : (t || x);
      return combined || "";
    });
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: VOYAGE_RERANK_MODEL,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
      }),
    });
    if (!r.ok) return hits;
    const data = await r.json();
    const order = (data?.data || []).map(d => ({ idx: d.index, score: d.relevance_score }));
    if (!order.length) return hits;
    const byIdx = new Map(order.map(o => [o.idx, o.score]));
    return hits
      .map((h, i) => ({ ...h, _voy: byIdx.has(i) ? byIdx.get(i) : -1e9 }))
      .sort((a, b) => b._voy - a._voy)
      .map(({ _voy, ...h }) => h);
  } catch (e) {
    if (DEBUG_RAG) console.warn("Voyage rerank failed:", e?.message || e);
    return hits;
  }
}

async function embedQuery(q) {
  const EMB = "text-embedding-3-small";
  const { data } = await openai.embeddings.create({ model: EMB, input: q });
  return data[0].embedding;
}

async function retrieveSite(question, topK = 40) {
  const vector = await embedQuery(question);
  const body = {
    vector, limit: topK, with_payload: true, with_vectors: false,
    ...(SITE_VECTOR_NAME ? { using: SITE_VECTOR_NAME } : {}),
  };
  const results = await qdrant.search(QDRANT_COLL, body);
  return results || [];
}

// ──────────────────────────────────────────────────────────────────────────────
// Minimal UI (for quick local testing)
app.get("/", (req, res) => {
  const origin = PUBLIC_BASE_URL || `https://${req.get("host")}`;
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
    const r = await fetch('/api/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ messages:[{role:'user', content:text}] })
    });
    const j = await r.json();
    render(j.html || '${REFUSAL}', false);
  }catch(e){
    render('Error: ' + (e.message||e), false);
  }
  try{
    // now uses GET; server also supports POST
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
// Sessions
const SESS = new Map(); // sid -> { sessionId, question, answers, scores, lastLinks: [] }
function getSid(req, res) {
  const cookie = req.headers.cookie || "";
  const m = /sid=([A-Za-z0-9_-]+)/.exec(cookie);
  if (m) return m[1];
  const sid = Math.random().toString(36).slice(2);
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}

// Mount quiz router once
app.use("/api/chatbot", chatbotRouter);

// ──────────────────────────────────────────────────────────────────────────────
// Chat endpoint (QUIZ + RAG)
app.post("/api/chat", async (req, res) => {
  try {
    const sid = getSid(req, res);
    const state = SESS.get(sid) || { sessionId:null, question:null, answers:{}, scores:{}, lastLinks:[] };
    const { messages = [] } = req.body || {};
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content?.trim() || "";

    // quiz handoff
    if (/^\s*(start|quiz|pick\s*\d+|answer\s*\d+)\s*$/i.test(lastUser)) {
      return chatbotRouter.handle(req, res);
    }

    // Retrieve candidates from Qdrant
    const variants = [lastUser, lastUser.toLowerCase(), lastUser.replace(/[^\w\s]/g," ")].filter(Boolean);
    let siteHits = [];
    for (const v of variants) {
      const hits = await retrieveSite(v, 40);
      siteHits = [...siteHits, ...(hits || [])];
      if (siteHits.length >= 40) break;
    }

    // Voyage re-rank
    siteHits = await voyageRerank(lastUser, siteHits, 40);

    // Dedup by url#chunk
    const seen = new Set();
    siteHits = siteHits.filter(h => {
      const key = `${h.payload?.url}#${h.payload?.chunk_index ?? "html"}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    // Filter + tiny lexical boost
    const qlen = lastUser.split(/\s+/).filter(Boolean).length;
    const dynamicThreshold = 0.10 + Math.min(0.15, qlen * 0.01);
    const tokens = normalizeText(lastUser).split(/\s+/).filter(t => t && t.length > 2);
    function lexBoost(h) {
      const hay = normalizeText((h?.payload?.title || "") + " " + (h?.payload?.text || ""));
      let k = 0; for (const t of tokens) if (hay.includes(t)) k++; return k;
    }

    const goodSite = siteHits
      .filter(h => (h?.score ?? 0) >= dynamicThreshold)
      .map(h => ({ ...h, _lex: lexBoost(h) }));

    // Prefer course pages slightly over articles when list intent
    function typeBoost(h){
      if (!isListIntent(lastUser)) return 0;
      const u = (h?.payload?.url || "").toLowerCase();
      if (u.includes("/courses/")) return 0.15;
      if (u.includes("/articles/")) return 0.05;
      return 0;
    }
    goodSite.sort((a,b)=> (b.score + 0.03*b._lex + typeBoost(b)) - (a.score + 0.03*a._lex + typeBoost(a)));

    // keep top-2 + host-balance to ~10
    const top2 = goodSite.slice(0,2);
    const byHost = new Map();
    for (const h of goodSite) {
      const url = h.payload?.url || ""; let host = "";
      try { host = new URL(url).hostname; } catch {}
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(h);
    }
    const balanced = [];
    for (const [,arr] of byHost) { balanced.push(...arr.slice(0,2)); if (balanced.length >= 12) break; }
    const keep = new Map();
    for (const h of [...top2, ...balanced]) {
      const key = h.payload?.url || "";
      if (!keep.has(key)) keep.set(key, h);
    }
    const finalHits = [...keep.values()].slice(0, 10);

    // Build context + link list
    const MAX_CHARS = 12000;
    let context = "", links = [];
    for (let i=0;i<finalHits.length;i++){
      const h = finalHits[i];
      const url = h.payload?.url || "";
      const title = h.payload?.title || h.payload?.h1 || "";
      const txt = (h.payload?.text || "").slice(0, 1400);
      const block = `[${i+1}] ${url}\n${title ? (title + "\n") : ""}${txt}\n---\n`;
      if ((context.length + block.length) > MAX_CHARS) break;
      context += block;
      links.push(url);
    }

    // Summarization prompt (evidence-bound)
    let systemContent = `You are a friendly golf buddy who knows course details from the site context.
    Your tone should be conversational, like talking golfer-to-golfer, but still accurate and evidence-bound.

    Rules:
    - Base everything ONLY on the Site Context. No guessing or outside knowledge.
    - If there are drawbacks, mention them clearly and casually (e.g., "you might want to watch out for...").
    - If info is mixed, mention both sides naturally ("some players liked X, but others noticed Y").
    - Keep answers short and chatty (2–4 sentences) when the user asks a question.
    - Always sprinkle in citations like [n] when you state facts.
    - If nothing relevant is in context, say: "I don’t have that in the site content."

    Example style:
    "Stow Acres has two courses. The South is classic and scenic... for its design but some reviews mention spotty conditions [2]."

    # Site Context (cite with [n])
    ${context}`;

    // Switch to list-output for “best/top/near/under $…”
    if (isListIntent(lastUser)) {
      systemContent = `You are a friendly golf buddy who extracts concrete answers from the Site Context.
      The user asked for recommendations. Produce a clear, scannable LIST, not a generic summary.

      Output rules:
      - Return a bulleted list of 5–10 courses in the format: • [Course Name](URL) — 1 short reason from the context, with a [n] citation.
      - Extract names directly from the context (from rankings, "best-of" articles, or course pages). Do NOT invent courses.
      - Prefer items geographically relevant if the query mentions a place (e.g., "near Boston").
      - If you only have list pages, parse the list items and present them as bullets.
      - After the list, include: "Want more options? Try refining by budget or walkability." (no citation needed).
      - If you cannot find course names in the context, say: "I don’t have that in the site content."

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

    // Build HTML (always show Sources if we have any)
    const allLinks = [...new Set(links)];
    if (!reply && !allLinks.length) return res.json({ html: REFUSAL });

    const sections = [];
    if (reply && reply !== REFUSAL) sections.push(renderReplyHTML(reply));
    else sections.push("Here are relevant pages on our site:");
    if (allLinks.length) {
      const sourcesHtml = allLinks.map(u => "• " + anchor(u)).join("<br/>");
      sections.push("<strong>Sources</strong><br/>" + sourcesHtml);
      SESS.set(sid, { ...state, lastLinks: allLinks.slice(0,10) });
    } else {
      SESS.set(sid, { ...state, lastLinks: [] });
    }

    return res.json({ html: sections.join("<br/><br/>") });
  } catch (e) {
    console.error("chat error:", e); return res.status(500).json({ error: String(e) });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Sidecar: related info panel (weather) — supports GET and POST
app.get("/api/sidecar", async (req, res) => {
  try {
    const q = (req.query.q || req.query.text || "").toString();
    const html = await buildSidecar(q);
    return res.json({ html });
  } catch (e) {
    console.warn("sidecar error:", e?.message || e); return res.json({ html: "" });
  }
});
app.post("/api/sidecar", async (req, res) => {
  try {
    const q = (req.body?.q || req.body?.text || "").toString();
    const html = await buildSidecar(q);
    return res.json({ html });
  } catch (e) {
    console.warn("sidecar error:", e?.message || e); return res.json({ html: "" });
  }
});

async function buildSidecar(q) {
  try {
    const loc = extractLocation(q || "");
    if (!loc) return "";
    const geo = await geocode(loc);
    if (!geo) return "";
    const wx = await fetchWeather(geo.lat, geo.lon);
    return renderWeatherCard(geo, wx);
  } catch { return ""; }
}

// Helpers for side panel
function extractLocation(text = "") {
  const t = text.trim();

  // “in/near/around …”
  let m = t.match(/\b(?:in|near|around)\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
  if (m) return m[1].replace(/[.,]+$/,'').trim();

  // “courses in Wayland”
  m = t.match(/\b(?:courses?|golf|weather)\s+in\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
  if (m) return m[1].replace(/[.,]+$/,'').trim();

  // simple fallback: last 1–3 words
  const words = t.replace(/[^A-Za-z\s-]/g, " ").trim().split(/\s+/);
  if (words.length <= 3 && words.length > 0) return words.join(" ");

  const tail = t.match(/([A-Za-z][A-Za-z\s-]{1,40})$/);
  return tail ? tail[1].trim() : "";
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
  if (!wx || !wx.current_weather) return "";
  const cur = wx.current_weather;
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
      '<div>Now: ' + cur.temperature + '°C, wind ' + cur.windspeed + ' km/h</div>' +
      '<div style="margin-top:8px;font-weight:600">Next days</div>' +
      (rows || '<div>No forecast.</div>') +
      '<div style="margin-top:10px;font-size:12px;color:#666">Source: ' +
      '<a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>' +
      '</div>' +
    '</div>';
}

// ──────────────────────────────────────────────────────────────────────────────
// Health & debug
app.get("/api/ping", (_, res) => res.json({ ok: true }));

app.get("/api/debug/site-top", async (req, res) => {
  try {
    const EMB = "text-embedding-3-small";
    const q = req.query.q || "wayland";
    const { data } = await openai.embeddings.create({ model: EMB, input: q });
    const vector = data[0].embedding;
    const body = { vector, limit: 10, with_payload: true, with_vectors: false,
                   ...(SITE_VECTOR_NAME ? { using: SITE_VECTOR_NAME } : {}) };
    const results = await qdrant.search(QDRANT_COLL, body);
    const out = (results || []).map(r => ({
      score: r.score, url: r.payload?.url, title: r.payload?.title,
      preview: (r.payload?.text || "").slice(0,160)
    }));
    res.json({ q, collection: QDRANT_COLL, using: SITE_VECTOR_NAME || "(default)", out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server listening on", PORT));
