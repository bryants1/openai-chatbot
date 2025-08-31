// server.js — Chat + Quiz + Site-Search–assisted RAG over site_docs (summarizes + clickable links)
// No 5-D vectors here; answers grounded in your site content + site search.
// Quiz is proxied to your Vercel app via /api/chatbot/* (router mount unchanged).

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { load as loadHTML } from "cheerio";
import chatbotRouter from "./api/golfChatbotRouter.js";

// ──────────────────────────────────────────────────────────────────────────────
// ENV needed:
// OPENAI_API_KEY=...
// QDRANT_URL=https://<cluster>.aws.cloud.qdrant.io
// QDRANT_API_KEY=... (if private)
// QDRANT_COLLECTION=site_docs
// SITE_BASE=https://golf.totalguide.net  (or set SITE_SEARCH_BASE)
// PUBLIC_BASE_URL=https://<this-render-app-domain>   (optional; fallback uses req.host)
// Optional named vector for site_docs: SITE_VECTOR_NAME=text
// Optional debug: DEBUG_RAG=1
// ──────────────────────────────────────────────────────────────────────────────

const REFUSAL = "I don’t have that in the site content.";
const DEBUG_RAG = process.env.DEBUG_RAG === "1";

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const QDRANT_URL      = process.env.QDRANT_URL;
const QDRANT_API_KEY  = process.env.QDRANT_API_KEY || "";
const QDRANT_COLL     = process.env.QDRANT_COLLECTION || "site_docs";
const SITE_VECTOR_NAME = (process.env.SITE_VECTOR_NAME || "").trim(); // leave blank for unnamed vector
const SITE_SEARCH_BASE = (process.env.SITE_BASE || process.env.SITE_SEARCH_BASE || "").replace(/\/+$/, "");
const PUBLIC_BASE_URL  = process.env.PUBLIC_BASE_URL || "";

if (!OPENAI_API_KEY || !QDRANT_URL) {
  console.error("Missing env. Need OPENAI_API_KEY and QDRANT_URL (site_docs).");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

// ──────────────────────────────────────────────────────────────────────────────
// App
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// UI (two-pane; composer pinned bottom-left)
app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>OpenAI Chatbot</title>
      <style>
        :root { --bg:#fafafa; --fg:#111; --muted:#666; --border:#ddd; --accent:#06c; }
        *{box-sizing:border-box}
        html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
        .page{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;grid-template-columns:2fr 1fr}
        header{grid-column:1/3;padding:14px 20px;border-bottom:1px solid var(--border);background:#fff;position:sticky;top:0;z-index:2}
        h1{margin:0;font-size:20px}
        .hint{color:var(--muted);font-size:12px;margin-top:4px}
        .log-wrap{grid-row:2;grid-column:1;overflow:auto;padding:16px 20px}
        .msg{margin:10px 0;line-height:1.5;white-space:pre-wrap}
        .me{font-weight:600;margin-bottom:6px}
        .bot{white-space:normal}
        a{color:var(--accent);text-decoration:none}
        .side{grid-row:2/4;grid-column:2;border-left:1px solid var(--border);background:#fff;display:flex;flex-direction:column}
        .side-head{padding:12px 16px;border-bottom:1px solid var(--border);font-weight:600}
        .side-body{flex:1 1 auto;overflow:auto;padding:12px 16px}
        .card{border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:12px;background:#fff}
        .composer-wrap{grid-row:3;grid-column:1;background:#fff;border-top:1px solid var(--border);position:sticky;bottom:0}
        .composer{display:flex;gap:8px;padding:12px 20px;max-width:1000px;margin:0 auto}
        .composer textarea{flex:1;padding:10px 12px;resize:none;min-height:44px;max-height:160px;border:1px solid var(--border);border-radius:8px;font:inherit;background:#fff}
        .composer button{padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:#fff;cursor:pointer}
      </style>
    </head>
    <body>
      <div class="page">
        <header>
          <h1>OpenAI Chatbot</h1>
          <div class="hint">Try: <code>start quiz</code>, <code>pick 1</code>, or <code>courses in stow</code></div>
        </header>

        <div id="log" class="log-wrap"></div>

        <aside class="side">
          <div class="side-head">Related</div>
          <div id="side" class="side-body">
            <div class="card">Ask about a place (e.g., “courses in Stow”) to see local weather here.</div>
          </div>
        </aside>

        <div class="composer-wrap">
          <div class="composer">
            <textarea id="msg" placeholder="Type a message… (Enter = send, Shift+Enter = newline)"></textarea>
            <button id="sendBtn">Send</button>
          </div>
        </div>
      </div>

      <script>
        const log  = document.getElementById('log');
        const side = document.getElementById('side');
        const box  = document.getElementById('msg');
        const btn  = document.getElementById('sendBtn');

        function addHTML(container, html){
          const row = document.createElement('div');
          row.className = 'msg';
          row.innerHTML = html;
          container.appendChild(row);
          container.scrollTop = container.scrollHeight;
        }
        function addYou(text){
          const safe = text.replace(/</g,'&lt;');
          addHTML(log, '<div class="me">You:</div><div>'+safe+'</div>');
        }

        async function sendMessage(){
          const m = box.value.trim();
          if(!m) return;
          box.value = '';
          addYou(m);
          try{
            const r = await fetch('/api/chat',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({messages:[{role:'user',content:m}]})});
            const d = await r.json().catch(()=>({}));
            if (d.html) addHTML(log, '<div class="bot">'+d.html+'</div>');
            else addHTML(log, '<div class="bot">'+(d.reply||'(no reply)').replace(/</g,'&lt;')+'</div>');
          }catch(e){ addHTML(log, '<div class="bot">Error: '+(e?.message||e)+'</div>'); }

          try{
            const s = await fetch('/api/sidecar?q='+encodeURIComponent(m));
            const p = await s.json().catch(()=>({}));
            side.innerHTML = p.html || '<div class="card">No related info.</div>';
          }catch{ side.innerHTML = '<div class="card">No related info.</div>'; }
        }

        btn.addEventListener('click', sendMessage);
        box.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); }});
        window.addEventListener('load', ()=> box.focus());
      </script>
    </body>
    </html>
  `);
});

// ──────────────────────────────────────────────────────────────────────────────
// Session (cookie)
const SESS = new Map(); // sid -> { sessionId, question, answers, scores, lastLinks: [] }
function getSid(req, res) {
  const raw = req.headers.cookie || "";
  const found = raw.split(";").map(s=>s.trim()).find(s=>s.startsWith("chat_sid="));
  if (found) return found.split("=")[1];
  const sid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  res.setHeader("Set-Cookie", `chat_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
function anchor(url, label){ const safe=(label||url).replace(/</g,"&lt;"); const href=url.replace(/"/g,"%22"); return `<a href="${href}" target="_blank" rel="noopener">${safe}</a>`; }
function normalizeText(s){ return (s||"").trim().replace(/\s+/g," "); }
function pickMinScoreFor(query){ const wc=normalizeText(query).split(/\s+/).filter(Boolean).length; if (wc<=1) return 0.18; if (wc===2) return 0.22; return 0.24; }

// Pretty final renderer
function renderFinalProfileHTML(profile = {}, scores = {}, total = 0) {
  const skill   = profile.skillLevel || profile.skill?.label || "-";
  const persona = profile.personality || profile.personality?.primary || "-";
  const rec     = profile.recommendations || {};
  const whyArr  = Array.isArray(rec.why) ? rec.why : (Array.isArray(profile.why) ? profile.why : []);
  const prefs   = profile.preferences?.core || [];
  const courses = profile.matchedCourses || [];
  const lodging  = rec.lodging || profile.lodging || "";
  const mlInsights = rec.mlInsights || profile.mlInsights || null;
  const alt      = rec.alternativeOptions || profile.alternativeOptions || null;
  const altStyles = Array.isArray(alt?.courseStyles) ? alt.courseStyles.map(s => (typeof s === "string" ? s : (s.style || ""))).filter(Boolean) : [];

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
  if (mlInsights) {
    lines.push(`\nML Insights`);
    if (mlInsights.similarUserCount != null) lines.push(`• Based on ${mlInsights.similarUserCount} similar golfers`);
    if (mlInsights.confidence != null)       lines.push(`• Model confidence: ${mlInsights.confidence}`);
    if (mlInsights.dataQuality)              lines.push(`• Data quality: ${mlInsights.dataQuality}`);
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

// Embeddings + site retrieval
const EMB_MODEL = "text-embedding-3-small";
async function embedQuery(q) {
  const { data } = await openai.embeddings.create({ model: EMB_MODEL, input: q });
  return data[0].embedding;
}
async function retrieveSite(question, topK = 12) {
  const vector = await embedQuery(question);
  const body = { vector, limit: topK, with_payload: true, with_vectors: false, ...(SITE_VECTOR_NAME ? { using: SITE_VECTOR_NAME } : {}) };
  const results = await qdrant.search(QDRANT_COLL, body);
  return results || [];
}

// SSR site search
async function siteSearchHTML(query, limit = 8) {
  if (!SITE_SEARCH_BASE) return [];
  const url = `${SITE_SEARCH_BASE}/search?query=${encodeURIComponent(query)}`;
  try {
    const r = await fetch(url, { headers:{ "User-Agent":"site-search/1.0" } });
    if (!r.ok) return [];
    const html = await r.text();
    const $ = loadHTML(html);
    const items = [];
    $(".search-result, .result, .item").each((_, el) => {
      const a = $(el).find("a[href]").first();
      const href = a.attr("href") || "";
      const title = a.text().trim();
      const snip = $(el).text().replace(/\s+/g," ").trim();
      if (!href || !title) return;
      const abs = href.startsWith("http") ? href : new URL(href, SITE_SEARCH_BASE + "/").toString();
      items.push({ url: abs, title, snippet: snip.slice(0,300) });
    });
    if (!items.length) {
      $("main a[href]").slice(0, limit).each((_, a) => {
        const href=$(a).attr("href")||""; const title=$(a).text().trim();
        if (!href || !title) return;
        const abs = href.startsWith("http") ? href : new URL(href, SITE_SEARCH_BASE + "/").toString();
        items.push({ url: abs, title, snippet: title });
      });
    }
    // De-dup
    const seen = new Set(); const dedup = [];
    for (const it of items) {
      if (seen.has(it.url)) continue;
      seen.add(it.url); dedup.push(it);
      if (dedup.length >= limit) break;
    }
    return dedup;
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Chat endpoint (QUIZ + RAG)
app.post("/api/chat", async (req, res) => {
  try {
    const sid = getSid(req, res);
    const state = SESS.get(sid) || { sessionId:null, question:null, answers:{}, scores:{}, lastLinks:[] };
    const { messages = [] } = req.body || {};
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content?.trim() || "";
    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

    // Quick “links”
    if (/^(link|links|source|sources)\b/i.test(lastUser) && !state.question) {
      return res.json({ html: state.lastLinks.length ? state.lastLinks.map(u=>`• ${anchor(u)}`).join("<br/>") : REFUSAL });
    }

    // QUIZ: start (“start” or “start quiz”)
    if (/^(start|begin|go|let.?s\s*start)(?:\s+quiz)?$/i.test(lastUser)) {
      const r = await fetch(`${base}/api/chatbot/start`, {
        method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}"
      });
      const data = await r.json().catch(()=>null);
      if (!data || !data.sessionId || !data.question) {
        console.error("Quiz start failed or bad payload:", data);
        return res.json({ html:"Started a new quiz, but I couldn't fetch a question. Try again." });
      }
      state.sessionId = data.sessionId;
      state.question  = data.question || null;
      state.answers = {}; state.scores = {}; state.lastLinks = [];
      SESS.set(sid, state);

      const q = data.question;
      const lines = (q.options || []).map((o,i)=> `<li>${i}. ${o.emoji || ""} ${o.text}</li>`).join("");
      return res.json({ html:`<strong>Question ${data.questionNumber || 1}:</strong> ${q.text}<ul>${lines}</ul><div>Reply like: "pick 1" or just "1".</div>` });
    }

    // QUIZ: numeric pick while active
    const choiceMatch = lastUser.match(/^(?:pick|option)?\s*(\d+)\s*$/i);
    if (choiceMatch && state.sessionId && state.question?.id) {
      const idx = Number(choiceMatch[1]);
      const payload = { sessionId:state.sessionId, questionId:state.question.id, optionIndex:idx, currentAnswers:state.answers, currentScores:state.scores };
      const r = await fetch(`${base}/api/chatbot/answer`, {
        method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload)
      });
      const data = await r.json().catch(()=>null);
      if (!data) return res.json({ html:"Thanks! I couldn’t fetch the next question; try 'start quiz' again." });

      if (data.complete) {
        state.question = null;
        SESS.set(sid, state);
        const html = renderFinalProfileHTML(data.profile, data.scores, data.totalQuestions);
        return res.json({ html });
      }
      if (data.question) {
        state.question = data.question;
        state.answers  = data.currentAnswers || state.answers;
        state.scores   = data.currentScores  || state.scores;
        SESS.set(sid, state);
        const q = data.question;
        const lines = (q.options || []).map((o,i)=> `<li>${i}. ${o.emoji || ""} ${o.text}</li>`).join("");
        return res.json({ html:`<strong>Question ${data.questionNumber}:</strong> ${q.text}<ul>${lines}</ul><div>Reply like: "pick 1" or just "1".</div>` });
      }
      return res.json({ html:"Thanks! I couldn’t fetch the next question; try 'start quiz' again." });
    }

    // If a quiz is in progress, ignore RAG and remind the user to answer/pick
    if (state.sessionId && state.question) {
      const q = state.question;
      const lines = (q.options || []).map((o,i)=> `<li>${i}. ${o.emoji || ""} ${o.text}</li>`).join("");
      return res.json({ html:
        `<strong>Question ${Object.keys(state.answers||{}).length + 1}:</strong> ${q.text}` +
        `<ul>${lines}</ul><div>Reply like: "pick 1" or just "1".</div>`
      });
    }

    // ---------------- Site-search–assisted RAG ----------------
    // Two-pass: vector search + site search HTML
    const variants = [lastUser, lastUser.toLowerCase(), lastUser.replace(/[^\w\s]/g," ")]
      .filter((v,i,arr)=> normalizeText(v) && arr.indexOf(v) === i);

    let siteHits = [];
    for (const v of variants) {
      const hits = await retrieveSite(v, 12);
      siteHits = [...siteHits, ...(hits || [])];
      if (siteHits.length >= 12) break;
    }

    const searchItems = await siteSearchHTML(lastUser, 8);
    for (const rItem of searchItems) {
      siteHits.push({ score: 0.23, payload: { url: rItem.url, title: rItem.title, text: rItem.snippet } });
    }

    // de-dup by url#chunk
    const seen = new Set();
    siteHits = siteHits.filter(h => {
      const key = `${h.payload?.url}#${h.payload?.chunk_index ?? "html"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // dynamic threshold (short queries allowed)
    const minScore = pickMinScoreFor(lastUser);
    let goodSite = siteHits.filter(h => (h.score ?? 0) >= minScore || searchItems.some(s => s.url === h.payload?.url));
    if (DEBUG_RAG) {
      console.log("[RAG] minScore", minScore, "goodSite", goodSite.length);
      console.log(goodSite.slice(0,3).map(x => ({ score:x.score, url:x.payload?.url })));
    }
    if (!goodSite.length) return res.json({ html: REFUSAL });

    // lightweight lexical boost
    const tokens = (lastUser.toLowerCase().match(/[a-z]{3,}/g) || []);
    function lexBoost(hit) {
      const hay = (`${hit.payload?.title || ""} ${hit.payload?.text || ""} ${hit.payload?.url || ""}`).toLowerCase();
      let k = 0; for (const t of tokens) if (hay.includes(t)) k++;
      return k;
    }
    goodSite.sort((a,b)=> (b.score + 0.03*lexBoost(b)) - (a.score + 0.03*lexBoost(a)));

    // keep top-2 + host-balance
    const top2 = goodSite.slice(0,2);
    const byHost = new Map();
    for (const h of goodSite) {
      const url = h.payload?.url || ""; let host = "";
      try { host = new URL(url).hostname; } catch {}
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(h);
    }
    const balanced = [];
    for (const [,arr] of byHost) { balanced.push(...arr.slice(0,2)); if (balanced.length >= 6) break; }
    const keep = new Map();
    for (const h of [...top2, ...balanced]) {
      const key = h.payload?.url || "";
      if (!keep.has(key)) keep.set(key, h);
    }
    const finalHits = [...keep.values()].slice(0, 6);

    // Build context + link list
    const MAX_CHARS = 6000;
    let context = "";
    const links = [];
    for (let i=0;i<finalHits.length;i++){
      const h = finalHits[i];
      const url = h.payload?.url || "";
      const title = h.payload?.title || h.payload?.h1 || "";
      const txt = (h.payload?.text || "").slice(0, 1200);
      const block = `[${i+1}] ${url}\n${title ? (title + "\n") : ""}${txt}\n---\n`;
      if ((context.length + block.length) > MAX_CHARS) break;
      context += block;
      links.push(url);
    }

    // Summarization prompt (evidence-bound; no hype; show pros/cons as present)
    const systemContent = `You are a friendly golf buddy who knows course details from the site context.
    Your tone should be conversational, like talking golfer-to-golfer, but still accurate and evidence-bound.

    Rules:
    - Base everything ONLY on the Site Context. No guessing or outside knowledge.
    - If there are drawbacks, mention them clearly and casually (e.g., "you might want to watch out for...").
    - If info is mixed, mention both sides naturally ("some players liked X, but others noticed Y").
    - Keep answers short and chatty (2–4 sentences), not formal reports.
    - Always sprinkle in citations like [n] when you state facts.
    - If nothing relevant is in context, say: "I don’t have that in the site content."

    Example style:
    "Stow Acres has two courses. The South is classic and scenic [1], while the North gets praise for its design but some reviews mention spotty conditions [2]."

    # Site Context (cite with [n])
    ${context}`;

    // Use Responses API (SDK-compatible)
    let reply = "";
    try {
      const completion = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: systemContent },
          ...messages.filter(m => m.role === "user")
        ],
        temperature: 0.1,
        top_p: 1,
        max_output_tokens: 450
      });
      reply = (completion?.output_text || "").trim();
    } catch (e) {
      console.warn("OpenAI summarize failed:", e?.message || e);
      reply = "";
    }

    // Build HTML (always show Sources if we have any)
    const allLinks = [...new Set(links)];
    if (!reply && !allLinks.length) return res.json({ html: REFUSAL });

    const sections = [];
    if (reply && reply !== REFUSAL) sections.push(reply.replace(/\n/g,"<br/>"));
    else sections.push("Here are relevant pages on our site:");
    if (allLinks.length) {
      const sourcesHtml = allLinks.map(u => "• " + anchor(u)).join("<br/>");
      sections.push("<strong>Sources</strong><br/>" + sourcesHtml);
      SESS.set(sid, { ...state, lastLinks: allLinks.slice(0,10) });
    } else {
      SESS.set(sid, { ...state, lastLinks: [] });
    }

    return res.json({ html: sections.join("<br/><br/>") });

  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Sidecar: related info panel (weather)
app.get("/api/sidecar", async (req, res) => {
  try {
    const q = (req.query.q || "").toString();
    const loc = extractLocation(q);
    if (!loc) return res.json({ html: "" });

    const geo = await geocode(loc);
    if (!geo) return res.json({ html: "" });

    const wx = await fetchWeather(geo.lat, geo.lon);
    const html = renderWeatherCard(geo, wx);
    return res.json({ html });
  } catch (e) {
    console.warn("sidecar error:", e?.message || e);
    return res.json({ html: "" });
  }
});

// --- helpers for side panel ---
// --- helpers for side panel (REPLACE YOURS WITH THESE) ---
function extractLocation(text = "") {
  const t = text.trim();

  // common “in/near/around …” at any position
  let m = t.match(/\b(?:in|near|around)\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
  if (m) return m[1].replace(/[.,]+$/,'').trim();

  // phrases like “courses in Wayland”, “golf in Stow, MA”
  m = t.match(/\b(?:courses?|golf|weather)\s+in\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
  if (m) return m[1].replace(/[.,]+$/,'').trim();

  // simple fallback: last 1–3 words, e.g. “tell me weather stow”
  const words = t.replace(/[^A-Za-z\s-]/g, " ").trim().split(/\s+/);
  if (words.length <= 3 && words.length > 0) return words.join(" ");

  // final fallback: last “word-ish” chunk
  const tail = t.match(/([A-Za-z][A-Za-z\s-]{1,40})$/);
  return tail ? tail[1].trim() : "";
}

async function geocode(place) {
  // More tolerant free endpoint backed by Nominatim
  const url = "https://geocode.maps.co/search?q=" + encodeURIComponent(place) + "&format=json";
  const r = await fetch(url, { headers: { "User-Agent": "totalguide-chat/1.0" } });
  const j = await r.json().catch(() => []);
  if (!Array.isArray(j) || !j.length) return null;

  // If possible, bias toward US/MA results
  const best =
    j.find(x => /United States|USA|Massachusetts|MA/i.test(x.display_name)) || j[0];

  return {
    lat: Number(best.lat),
    lon: Number(best.lon),
    name: best.display_name
  };
}

async function fetchWeather(lat, lon) {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" + lat +
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

// ─────────────────────────── Quiz proxy router (unchanged) ───────────────────
app.use("/api/chatbot", chatbotRouter);

// Health
app.get("/api/ping", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server listening on", PORT));

// ─────────────────────────── Debug: top site hits ────────────────────────────
app.get("/api/debug/site-top", async (req, res) => {
  try {
    const EMB = "text-embedding-3-small";
    const q = req.query.q || "wayland";
    const { data } = await openai.embeddings.create({ model: EMB, input: q });
    const vector = data[0].embedding;

    const body = { vector, limit: 10, with_payload: true, with_vectors: false, ...(SITE_VECTOR_NAME ? { using: SITE_VECTOR_NAME } : {}) };
    const results = await qdrant.search(QDRANT_COLL, body);
    const out = (results || []).map(r => ({ score: r.score, url: r.payload?.url, title: r.payload?.title, preview: (r.payload?.text || "").slice(0,160) }));
    res.json({ q, collection: QDRANT_COLL, using: SITE_VECTOR_NAME || "(default)", out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
