// Quiz is explicit opt-in ("start" / "start quiz"); cancel exits.
// RAG is the default for everything else. Robust fallback to QUIZ_BASE_URL.

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import fetch from "node-fetch";
import chatbotRouter from "./api/golfChatbotRouter.js";

// ──────────────────────────────────────────────────────────────────────────
// ENV
const REFUSAL = "I don't have that in the site content.";
const DEBUG_RAG = process.env.DEBUG_RAG === "1";

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const QDRANT_URL       = process.env.QDRANT_URL;
const QDRANT_API_KEY   = process.env.QDRANT_API_KEY || "";
const QDRANT_COLL      = process.env.QDRANT_COLLECTION || "site_docs";
const SITE_VECTOR_NAME = (process.env.SITE_VECTOR_NAME || "").trim();

const VOYAGE_API_KEY      = (process.env.VOYAGE_API_KEY || "").trim();
const VOYAGE_RERANK_MODEL = (process.env.VOYAGE_RERANK_MODEL || "rerank-2-lite").trim();

const PORT = process.env.PORT || 8080;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/,"");
const SELF_BASE = PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;

// Optional: Vercel quiz app fallback
const QUIZ_BASE_URL = (process.env.QUIZ_BASE_URL || "").replace(/\/+$/,"");

if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
if (!QDRANT_URL)     { console.error("Missing QDRANT_URL");     process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ──────────────────────────────────────────────────────────────────────────
// Helpers

function isListIntent(q) {
  if (!q) return false;
  const s = q.toLowerCase();
  return /(best|top|list|recommend|recommendation|near|close to|within|under\s*\$?\d+|courses?\s+(in|near|around)|bucket\s*list)/i.test(s);
}
function normalizeText(s) { return (s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function anchor(u) {
  const esc = (t) => t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  try { const url = new URL(u); return `<a href="${esc(url.toString())}" target="_blank" rel="noreferrer">${esc(url.toString())}</a>`; }
  catch { return esc(u); }
}
function extractLocation(text = "") {
  const t = (text || "").trim();
  let m = t.match(/\b(?:in|near|around|close to)\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
  if (m) return m[1].replace(/[.,]+$/,'').trim();
  m = t.match(/\b(?:courses?|golf|weather)\s+in\s+([A-Za-z][A-Za-z\s\.,-]{1,60})/i);
  if (m) return m[1].replace(/[.,]+$/,'').trim();
  const words = t.replace(/[^A-Za-z\s-]/g, " ").trim().split(/\s+/);
  if (words.length > 0 && words.length <= 3) return words.join(" ");
  const tail = t.match(/([A-Za-z][A-Za-z\s-]{1,40})$/);
  return tail ? tail[1].trim() : "";
}
function newChatState() {
  return {
    mode: null,           // "quiz" when in quiz flow; null = normal chat
    sessionId: null,
    question: null,
    answers: {},
    scores: {},
    lastLinks: []
  };
}

// Safely turn mixed shapes into strings (handles {label}, {primary}, etc.)
function pickStr(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (typeof v === "object") {
      if (typeof v.label   === "string") return v.label;     // { label: "..." }
      if (typeof v.primary === "string") return v.primary;   // { primary: "..." }
      if (typeof v.text    === "string") return v.text;
      if (typeof v.value   === "string") return v.value;
    }
  }
  return "-";
}

// FIXED fetch helper: properly handles response and error cases
async function tryFetchJson(urls, init) {
  for (const url of urls) {
    try {
      console.log(`Trying: ${url}`);
      const r = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers || {})
        }
      });

      const text = await r.text();

      // Log for debugging
      if (!r.ok) {
        console.error(`Quiz endpoint failed: ${r.status} at ${url}`);
        if (DEBUG_RAG) console.error(`Response: ${text.slice(0, 500)}`);
        continue; // Try next URL
      }

      try {
        const json = JSON.parse(text);
        console.log(`Success from ${url}`);
        return json;
      } catch (e) {
        console.error(`Quiz endpoint bad JSON from ${url}:`, text.slice(0, 200));
        continue; // Try next URL
      }
    } catch (e) {
      console.error(`Quiz endpoint exception for ${url}:`, e?.message || e);
      continue; // Try next URL
    }
  }

  console.error("All quiz endpoints failed");
  return null;
}

// URL generation functions with correct patterns
function startUrls() {
  const eps = [`${SELF_BASE}/api/chatbot/start`];
  if (QUIZ_BASE_URL) {
    // Try both hyphenated and slash patterns
    eps.push(`${QUIZ_BASE_URL}/api/chatbot-start`);
    eps.push(`${QUIZ_BASE_URL}/api/chatbot/start`);
  }
  return eps;
}

function answerUrls() {
  const eps = [`${SELF_BASE}/api/chatbot/answer`];
  if (QUIZ_BASE_URL) {
    eps.push(`${QUIZ_BASE_URL}/api/chatbot-answer`);
    eps.push(`${QUIZ_BASE_URL}/api/chatbot/answer`);
  }
  return eps;
}

function questionUrls(questionId) {
  const id = encodeURIComponent(questionId);
  const eps = [`${SELF_BASE}/api/chatbot/question/${id}`];
  if (QUIZ_BASE_URL) {
    // Vercel pattern uses query parameter
    eps.push(`${QUIZ_BASE_URL}/api/chatbot-question?questionId=${id}`);
    eps.push(`${QUIZ_BASE_URL}/api/chatbot/question/${id}`);
  }
  return eps;
}

function finishUrls() {
  const eps = [`${SELF_BASE}/api/chatbot/finish`];
  if (QUIZ_BASE_URL) {
    eps.push(`${QUIZ_BASE_URL}/api/chatbot-finish`);
    eps.push(`${QUIZ_BASE_URL}/api/chatbot/finish`);
  }
  return eps;
}

function feedbackUrls() {
  const eps = [`${SELF_BASE}/api/chatbot/feedback`];
  if (QUIZ_BASE_URL) {
    eps.push(`${QUIZ_BASE_URL}/api/chatbot-feedback`);
    eps.push(`${QUIZ_BASE_URL}/api/chatbot/feedback`);
  }
  return eps;
}

// "Examples" chips under questions
function buildAnswerChips(options = []) {
  const clean = (s = "") =>
    String(s)
      .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+/gu, "")
      .replace(/^[0-9.\)\-\s]+/, "")
      .replace(/\s{2,}/g, " ")
      .trim();

  const seen = new Set();
  const labels = [];
  for (const o of options) {
    const raw = o?.text ?? o?.option_text ?? "";
    const lbl = clean(raw);
    if (!lbl) continue;
    const key = lbl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(lbl);
    if (labels.length >= 3) break;
  }
  if (!labels.length) return "";

  return `<div style="margin-top:4px">
    <span style="font-size:13px;color:#666;margin-right:8px">Examples:</span>
    ${labels.map(lbl => {
      // Properly escape for HTML attribute and JavaScript
      const htmlEscaped = lbl
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // For the onclick, we need to escape for JavaScript string
      const jsEscaped = lbl
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');

      return `<button type="button"
        style="display:inline-block;margin:6px 8px 0 0;padding:6px 10px;border:1px solid #ddd;border-radius:14px;background:#fff;cursor:pointer;font-size:13px"
        onclick="(function(){var b=document.getElementById('box');if(b){b.value='${jsEscaped}';var btn=document.getElementById('btn');if(btn)btn.click();}})()"
      >${htmlEscaped}</button>`;
    }).join("")}
  </div>`;
}

// Render LLM markdown-ish as HTML
function renderReplyHTML(text = "") {
  const mdLink = (s) =>
    s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
      const safe = url.replace(/"/g, "%22");
      return `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`;
    });
  const lines = String(text).split(/\r?\n/);
  let html = [], listOpen = false, para = [];
  const flushPara = () => { if (para.length) { html.push(`<p>${mdLink(para.join(" "))}</p>`); para = []; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); if (listOpen) { html.push("</ul>"); listOpen = false; } continue; }
    if (/^([•\-\*]\s+)/.test(line)) {
      flushPara(); if (!listOpen) { html.push("<ul>"); listOpen = true; }
      html.push(`<li>${mdLink(line.replace(/^([•\-\*]\s+)/, "").trim())}</li>`);
    } else para.push(line);
  }
  flushPara(); if (listOpen) html.push("</ul>");
  return html.join("");
}

// QUIZ – conversational question (no numbered options; show chips)
function renderQuestionHTML(q) {
  const headline = (q.conversational_text || q.text || "").trim();
  const chips = buildAnswerChips(q.options || []);
  return `<div style="font-size:16px;margin:0 0 10px">${headline}</div>${chips}`;
}

// QUIZ – final profile (left)
function renderFinalProfileHTML(profile = {}, scores = {}, total = 0) {
  const rec   = profile.recommendations || {};

  const skill   = pickStr(profile.skillLevel, profile.skill);
  const persona = pickStr(profile.personality, profile.personality?.primary);

  const style   = pickStr(rec.courseStyle);
  const budget  = pickStr(rec.budgetLevel);
  const amenities = Array.isArray(rec.amenities)
    ? rec.amenities
    : Array.isArray(rec.amenities?.essential) ? rec.amenities.essential : [];

  const courses = Array.isArray(profile.matchedCourses) ? profile.matchedCourses : [];
  const whyArr  = Array.isArray(rec.why) ? rec.why : (Array.isArray(profile.why) ? profile.why : []);
  const prefs   = Array.isArray(profile.preferences?.core) ? profile.preferences.core : [];
  const ml      = rec.mlInsights || profile.mlInsights || null;

  const lines = [];
  lines.push(`You've completed the quiz! Here's your profile:\n`);
  lines.push(`Skill Level: ${skill}`);
  lines.push(`Personality: ${persona}\n`);
  lines.push(`Recommendations`);
  lines.push(`• Style: ${style}`);
  lines.push(`• Budget: ${budget}`);
  if (amenities.length) { lines.push(`• Amenities:`); amenities.forEach(a => lines.push(`  • ${a}`)); }
  if (whyArr.length)    { lines.push(`\nWhy`);        whyArr.forEach(w => lines.push(`• ${w}`)); }
  if (ml) {
    lines.push(`\nML Insights`);
    if (ml.similarUserCount != null) lines.push(`• Based on ${ml.similarUserCount} similar golfers`);
    if (ml.confidence)               lines.push(`• Model confidence: ${ml.confidence}`);
    if (ml.dataQuality)              lines.push(`• Data quality: ${ml.dataQuality}`);
  }
  if (courses.length) {
    lines.push(`\nMatched Courses`);
    courses.slice(0,6).forEach(c => {
      const name = pickStr(c.name, c.title, c.payload?.course_name, "Course");
      const score = (typeof c.score === "number") ? ` – ${c.score.toFixed(3)}` : "";
      lines.push(`• ${name}${score}`);
    });
  }
  if (prefs.length) { lines.push(`\nYour Preferences`); prefs.forEach(p => lines.push(`• ${p}`)); }
  return lines.join("\n");
}

function renderProfileSideCard(profile = {}, scores = {}) {
  const rec     = profile.recommendations || {};
  const skill   = pickStr(profile.skillLevel, profile.skill);
  const persona = pickStr(profile.personality, profile.personality?.primary);

  const prefs = Array.isArray(profile.preferences?.core) ? profile.preferences.core : [];

  const matches = Array.isArray(profile.matchedCourses)
    ? profile.matchedCourses.slice(0, 5)
    : [];

  const matchItems = matches.length
    ? matches.map((m) => {
        const name  = pickStr(m.name, m.title, m.payload?.course_name, "Course");
        const href  = m.url || m.link || m.payload?.website || m.payload?.course_url || "";
        const score = (typeof m.score === "number") ? ` – ${m.score.toFixed(3)}` : "";
        return href
          ? `• <a href="${href.replace(/"/g,"%22")}" target="_blank" rel="noreferrer">${name}</a>${score}`
          : `• ${name}${score}`;
      }).join("<br/>")
    : "<span class='muted'>No matches yet.</span>";

  const prefItems = prefs.length
    ? prefs.slice(0, 6).map(p => `• ${p}`).join("<br/>")
    : "<span class='muted'>No preferences yet.</span>";

  return `
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px">Your Golf Profile</div>
      <div><strong>Skill</strong>: ${skill}</div>
      <div><strong>Personality</strong>: ${persona}</div>
      <div style="margin-top:10px"><strong>Top matches</strong><br/>${matchItems}</div>
      <div style="margin-top:10px"><strong>Your Preferences</strong><br/>${prefItems}</div>
    </div>
  `;
}

// Rephrase question (only if API didn't provide conversational_text)
async function rephraseQuestionLLM(q) {
  try {
    const opts = (q.options || []).map(o => o.text || o.option_text).filter(Boolean).slice(0, 8);
    const sys = `You are a friendly golf buddy. Rephrase the question as ONE short, natural line. Do NOT list options or numbers.`;
    const user = `Question: "${q.text || q.question_text || ""}"\nOptions (do not show): ${opts.join(" | ")}`;
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0.4, max_tokens: 60
    });
    return (r.choices[0]?.message?.content || "").trim() || q.text || q.question_text || "";
  } catch { return q.text || q.question_text || ""; }
}

// Classify free-text → optionIndex
async function classifyFreeTextToIndexLLM(q, freeText) {
  try {
    const options = (q.options || []).map((o, i) => ({
      index: (o.index ?? o.option_index ?? i),
      text: (o.text ?? o.option_text ?? "").toLowerCase().trim(),
      emoji: o.emoji || ""
    }));

    // Clean the user's input
    const userInput = freeText.toLowerCase().trim();

    // Direct number match
    const numberMatch = userInput.match(/^\d+$/);
    if (numberMatch && options.some(o => o.index === Number(numberMatch[0]))) {
      console.log(`Direct number match: ${numberMatch[0]}`);
      return Number(numberMatch[0]);
    }

    // Check for exact or close text matches first
    for (const opt of options) {
      // Remove emoji and clean the option text
      const cleanOption = opt.text.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+/gu, "").trim();

      // Exact match
      if (userInput === cleanOption) {
        console.log(`Exact match found: option ${opt.index}`);
        return opt.index;
      }

      // Check if user input contains most of the option text
      if (cleanOption && userInput.includes(cleanOption)) {
        console.log(`Partial match found: option ${opt.index}`);
        return opt.index;
      }

      // Check if option contains the user input (for abbreviated responses)
      if (cleanOption && cleanOption.includes(userInput) && userInput.length > 3) {
        console.log(`Abbreviated match found: option ${opt.index}`);
        return opt.index;
      }
    }

    // Use GPT for classification
    const sys = `You are classifying a golfer's response to a multiple choice question.
Match their response to the BEST fitting option index.
Return ONLY a JSON object: {"optionIndex": <number>}`;

    const user = `Question: ${q.conversational_text || q.text || q.question_text || ""}
Options:
${options.map(o => `${o.index}: ${o.text}`).join("\n")}

User's response: "${freeText}"

Which option index best matches their response?`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.1,
      max_tokens: 40
    });

    const out = (r.choices[0]?.message?.content || "").trim();
    console.log(`GPT classification response: ${out}`);

    const m = out.match(/"optionIndex"\s*:\s*(\d+)/i);
    if (m) {
      const idx = Number(m[1]);
      if (options.some(o => o.index === idx)) {
        console.log(`GPT matched to option ${idx}`);
        return idx;
      }
    }

    // Fallback: pick first option
    console.log(`Classification failed, defaulting to first option`);
    return options[0]?.index ?? 0;

  } catch (error) {
    console.error("Classification error:", error);
    return 0;
  }
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

// Embeddings + site retrieval
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
function isCourseURL(h) { return ((h?.payload?.url || "").toLowerCase()).includes("/courses/"); }

// ──────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenAI Chatbot</title>
    <style>
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #fafafa;
            color: #222;
            margin: 0;
        }
        .container {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 24px;
            max-width: 1200px;
            margin: 24px auto;
            padding: 0 16px;
        }
        .card {
            background: #fff;
            border: 1px solid #e5e5e5;
            border-radius: 12px;
            padding: 16px;
        }
        .row {
            display: flex;
            gap: 8px;
        }
        textarea {
            width: 100%;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 10px;
        }
        button {
            padding: 10px 14px;
            border-radius: 10px;
            border: 1px solid #0a7;
            cursor: pointer;
        }
        .msg {
            padding: 10px 12px;
            border-radius: 10px;
            margin: 8px 0;
        }
        .me {
            background: #e9f7ff;
        }
        .bot {
            background: #f7f7f7;
        }
        .muted {
            color: #777;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <h1>OpenAI Chatbot</h1>
            <div class="muted">Try: best courses near boston or start for quiz</div>
            <div id="log"></div>
            <div class="row">
                <textarea id="box" rows="2" placeholder="Type a message"></textarea>
                <button id="btn">Send</button>
            </div>
        </div>
        <div class="card">
            <h2>Related</h2>
            <div id="side" class="muted">No related info.</div>
        </div>
    </div>
    <script>
        const log = document.getElementById("log");
        const box = document.getElementById("box");
        const btn = document.getElementById("btn");
        const side = document.getElementById("side");

        function render(html, isMe) {
            const d = document.createElement("div");
            d.className = "msg " + (isMe ? "me" : "bot");
            d.innerHTML = html;
            log.appendChild(d);
            log.scrollTop = log.scrollHeight;
        }

        async function sendMessage() {
            const text = box.value.trim();
            if (!text) return;

            render("<strong>You:</strong><br>" + text, true);
            box.value = "";

            let j = null;
            try {
                const r = await fetch("/api/chat", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({messages: [{role: "user", content: text}]})
                });
                j = await r.json();
                const defaultMsg = "I do not have that in the site content.";
                render(j.html || defaultMsg, false);
            } catch(e) {
                render("Error: " + (e.message || e), false);
            }

            if (j && typeof j.sideHtml === "string" && j.sideHtml.length) {
                side.innerHTML = j.sideHtml;
            } else if (!j || !j.suppressSidecar) {
                try {
                    const r2 = await fetch("/api/sidecar?q=" + encodeURIComponent(text));
                    const p = await r2.json();
                    const defaultSide = "<div class=\\"card\\">No related info.</div>";
                    side.innerHTML = p.html || defaultSide;
                } catch(e) {
                    side.innerHTML = "<div class=\\"card\\">No related info.</div>";
                }
            }
        }

        btn.addEventListener("click", sendMessage);
        box.addEventListener("keydown", function(e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        window.addEventListener("load", function() {
            box.focus();
        });
    </script>
</body>
</html>`;

  res.send(html);
});

// ──────────────────────────────────────────────────────────────────────────
// Sessions + proxy router (to your remote quiz app)
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

// ──────────────────────────────────────────────────────────────────────────
// Chat endpoint (quiz is explicit opt-in; RAG is default)
// Chat endpoint (quiz is explicit opt-in; RAG is default)
app.post("/api/chat", async (req, res) => {
  try {
    const sid = getSid(req, res);
    const state = SESS.get(sid) || newChatState();
    const { messages = [] } = req.body || {};
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content?.trim() || "";
    const intent = lastUser.trim().toLowerCase();
    const isStartCmd = (intent === "start" || intent === "start quiz");

    // cancel/exit quiz
    if (/^\s*(cancel|stop|exit|end)\s*(quiz)?\s*$/i.test(lastUser)) {
      SESS.set(sid, newChatState());
      return res.json({ html: "Got it – I've exited the quiz. Ask anything or type 'start' to begin again." });
    }

    // ── RAG BY DEFAULT: if we're NOT in quiz mode and it's NOT an explicit start, do search and return
    if (state.mode !== "quiz" && !isStartCmd) {
      // -------- RAG path (unchanged logic) --------
      const locForQuery = extractLocation(lastUser);
      const variants = [
        lastUser, lastUser.toLowerCase(), lastUser.replace(/[^\w\s]/g, " "),
        ...(locForQuery ? [`golf courses in ${locForQuery}`, `${locForQuery} golf courses`, `courses near ${locForQuery}`] : [])
      ].filter(Boolean);

      let siteHits = [];
      for (const v of variants) {
        const hits = await retrieveSite(v, 120);
        siteHits = [...siteHits, ...(hits || [])];
        if (siteHits.length >= 120) break;
      }
      siteHits = await voyageRerank(lastUser, siteHits, 40);

      // De-dup by url#chunk
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
        .map(h => ({ ...h, _lex: lexBoost(h) }))
        .sort((a,b)=> (b.score + 0.03*b._lex) - (a.score + 0.03*a._lex));

      // De-dupe by URL and assemble final
      const keep = new Map();
      for (const h of goodSite.slice(0, 20)) {
        const key = h.payload?.url || ""; if (!keep.has(key)) keep.set(key, h);
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
      - Base everything ONLY on the Site Context. No guessing.
      - Keep answers short (2–4 sentences).
      - Use citations like [n] for facts.
      - If nothing relevant is in context, say: "${REFUSAL}".
      # Site Context (cite with [n])
      ${context}`;
      if (isListIntent(lastUser)) {
        systemContent = `You are a friendly golf buddy. The user wants a LIST of course recommendations.
        - Use ONLY items in the Site Context; prefer course pages over articles.
        - Bullet 5–10 courses: • [Course Name](URL) – 1 short reason [n]
        - If fewer than 5, show what you have.
        # Site Context
        ${context}`;
      }

      // LLM
      let reply = "";
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: systemContent }, ...messages.filter(m => m.role === "user")],
          temperature: 0.3, max_tokens: 450,
        });
        reply = completion.choices[0]?.message?.content || "";
        reply = (reply || "").trim();
      } catch (e) { console.warn("OpenAI summarize failed:", e?.message || e); reply = ""; }

      const allLinks = [...new Set(links)];
      if (!reply && !allLinks.length) return res.json({ html: REFUSAL });

      const sections = [];
      if (reply && reply !== REFUSAL) sections.push(renderReplyHTML(reply));
      else sections.push("Here are relevant pages on our site:");
      if (allLinks.length) {
        sections.push("<strong>Sources</strong><br/>" + allLinks.map(u => "• " + anchor(u)).join("<br/>"));
        SESS.set(sid, { ...state, lastLinks: allLinks.slice(0,12) });
      } else {
        SESS.set(sid, { ...state, lastLinks: [] });
      }
      return res.json({ html: sections.join("<br/><br/>") });
      // -------- end RAG path --------
    }

    // ── QUIZ: start (only if explicitly asked)
    if (isStartCmd) {
      const urls = startUrls();
      console.log("Starting quiz with URLs:", urls);

      const data = await tryFetchJson(urls, {
        method: "POST",
        body: JSON.stringify({})
      });

      if (!data) {
        SESS.set(sid, newChatState());
        console.error("Quiz start failed - no data returned");
        return res.json({
          html: "Sorry, I couldn't start the quiz right now. Please try again or ask me about golf courses directly."
        });
      }

      if (!data.sessionId || !data.question) {
        SESS.set(sid, newChatState());
        console.error("Quiz start returned invalid data:", data);
        return res.json({
          html: "The quiz didn't start properly. Try again or ask me about specific golf courses."
        });
      }

      state.mode = "quiz";
      state.sessionId = data.sessionId;
      state.question  = data.question || null;
      state.answers   = {};
      state.scores    = {};
      state.lastLinks = [];

      // ensure options for chips
      if (!Array.isArray(state.question.options) || !state.question.options.length) {
        const urls = questionUrls(state.question.id);
        const qd = await tryFetchJson(urls, { method: "GET" });
        if (qd && qd.options) state.question.options = qd.options;
      }

      // Always use conversational_text if available, otherwise rephrase
      if (!state.question.conversational_text) {
        console.log("No conversational_text, rephrasing question");
        state.question.conversational_text = await rephraseQuestionLLM(state.question);
      } else {
        console.log("Using provided conversational_text");
      }

      SESS.set(sid, state);
      return res.json({ html: renderQuestionHTML(state.question), suppressSidecar: true });
    }

    // ── QUIZ: numeric pick (only in quiz mode)
    const pickOnly = lastUser.match(/^(?:pick|answer|option)?\s*(\d+)\s*$/i);
    if (pickOnly && state.mode === "quiz" && state.sessionId && state.question?.id) {
      const idx = Number(pickOnly[1]);
      console.log(`Numeric answer selected: ${idx}`);

      const urls = answerUrls();
      const data = await tryFetchJson(urls, {
        method: "POST",
        body: JSON.stringify({
          sessionId:      state.sessionId,
          questionId:     state.question.id,
          optionIndex:    idx,
          currentAnswers: state.answers,
          currentScores:  state.scores
        })
      });

      if (!data) return res.json({ html:"Thanks! I couldn't fetch the next question; try 'start' again." });

      if (data.complete) {
        state.mode = null; state.question = null; SESS.set(sid, state);
        const html = renderFinalProfileHTML(data.profile, data.scores, data.totalQuestions).replace(/\n/g,"<br/>");
        const sideHtml = renderProfileSideCard(data.profile, data.scores);
        return res.json({ html, sideHtml });
      }

      if (data.question) {
        state.answers = data.currentAnswers || state.answers;
        state.scores  = data.currentScores  || state.scores;
        state.question = data.question;

        // Always use conversational_text if available
        if (!state.question.conversational_text) {
          console.log("No conversational_text for next question, rephrasing");
          state.question.conversational_text = await rephraseQuestionLLM(state.question);
        } else {
          console.log("Using provided conversational_text for next question");
        }

        SESS.set(sid, state);
        return res.json({ html: renderQuestionHTML(state.question), suppressSidecar: true });
      }
      return res.json({ html:"Thanks! I couldn't fetch the next question; try 'start' again." });
    }

    // ── QUIZ: free-text → classify → full payload (only in quiz mode)
    if (state.mode === "quiz" && state.sessionId && state.question?.id) {
      console.log(`Processing free text answer: "${lastUser}"`);
      console.log(`Current question: ${state.question.conversational_text || state.question.text}`);

      // Ensure we have options
      if (!Array.isArray(state.question.options) || !state.question.options.length) {
        const urls = questionUrls(state.question.id);
        const qd = await tryFetchJson(urls, { method: "GET" });
        if (qd && qd.options) state.question.options = qd.options;
      }

      console.log(`Available options:`, state.question.options?.map(o => `${o.index}: ${o.text}`));

      const idx = await classifyFreeTextToIndexLLM(state.question, lastUser);
      console.log(`Classified to option index: ${idx}`);

      if (Number.isNaN(idx)) {
        return res.json({ html: `Hmm, I didn't catch that – try a phrase like "well-maintained", or type "pick 1".` });
      }

      const urls = answerUrls();
      const data = await tryFetchJson(urls, {
        method: "POST",
        body: JSON.stringify({
          sessionId:      state.sessionId,
          questionId:     state.question.id,
          optionIndex:    idx,
          currentAnswers: state.answers,
          currentScores:  state.scores
        })
      });

      if (!data) return res.json({ html:"Thanks! I couldn't fetch the next question; try 'start' again." });

      if (data.complete) {
        state.mode = null; state.question = null; SESS.set(sid, state);
        const html = renderFinalProfileHTML(data.profile, data.scores, data.totalQuestions).replace(/\n/g,"<br/>");
        const sideHtml = renderProfileSideCard(data.profile, data.scores);
        return res.json({ html, sideHtml });
      }

      if (data.question) {
        state.answers = data.currentAnswers || state.answers;
        state.scores  = data.currentScores  || state.scores;
        state.question = data.question;

        // Always use conversational_text if available
        if (!state.question.conversational_text) {
          console.log("No conversational_text for next question, rephrasing");
          state.question.conversational_text = await rephraseQuestionLLM(state.question);
        } else {
          console.log("Using provided conversational_text for next question");
        }

        SESS.set(sid, state);
        return res.json({ html: renderQuestionHTML(state.question), suppressSidecar: true });
      }
      return res.json({ html:"Thanks! I couldn't fetch the next question; try 'start' again." });
    }

    // If we got here, we weren't in quiz mode and it wasn't "start" → just do RAG next time
    return res.json({ html: "Tell me what you're looking for – try \"courses in Wayland\" or type \"start\" to begin the quiz." });

  } catch (e) {
    console.error("chat error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Sidecar GET/POST
app.get("/api/sidecar", async (req, res) => {
  try {
    const q = (req.query.q || req.query.text || "").toString();
    const html = await buildSidecar(q); return res.json({ html });
  } catch (e) { return res.json({ html: "" }); }
});
app.post("/api/sidecar", async (req, res) => {
  try {
    const q = (req.body?.q || req.body?.text || "").toString();
    const html = await buildSidecar(q); return res.json({ html });
  } catch (e) { return res.json({ html: "" }); }
});

async function buildSidecar(q) {
  try {
    const loc = extractLocation(q || "");
    if (!loc) return "";
    const geo = await (await fetch(`https://geocode.maps.co/search?q=${encodeURIComponent(loc)}&format=json`, { headers: { "User-Agent": "totalguide-chat/1.0" } })).json().catch(()=>[]);
    if (!Array.isArray(geo) || !geo.length) return "";
    const best = geo.find(x => /United States|USA|Massachusetts|MA/i.test(x.display_name)) || geo[0];
    const lat = Number(best.lat), lon = Number(best.lon);
    const wx = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`)).json().catch(()=>null);
    if (!wx || !wx.current_weather) return "";
    const d = wx.daily || {}, time = d.time || [], tmax = d.temperature_2m_max || [], tmin = d.temperature_2m_min || [], prec = d.precipitation_sum || [];
    let rows = ""; for (let i=0;i<Math.min(time.length,3);i++) rows += `<div style="display:flex;justify-content:space-between;border-top:1px solid #eee;padding:6px 0"><span>${time[i]??""}</span><span>${tmin[i]??""}–${tmax[i]??""}°</span><span>${prec[i]??0}mm</span></div>`;
    return `<div class="card"><div style="font-weight:600;margin-bottom:6px">Weather – ${best.display_name}</div><div>Now: ${wx.current_weather.temperature ?? "–"}°C, wind ${wx.current_weather.windspeed ?? "–"} km/h</div><div style="margin-top:8px;font-weight:600">Next days</div>${rows || '<div>No forecast.</div>'}<div style="margin-top:10px;font-size:12px;color:#666">Source: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a></div></div>`;
  } catch { return ""; }
}

// ──────────────────────────────────────────────────────────────────────────
// Health & debug
app.get("/api/ping", (_, res) => res.json({ ok: true }));
app.get("/api/debug/site-top", async (req, res) => {
  try {
    const q = (req.query.q || "wayland").toString();
    const { data } = await openai.embeddings.create({ model: "text-embedding-3-small", input: q });
    const vector = data[0].embedding;
    const body = { vector, limit: 10, with_payload: true, with_vectors: false,
                   ...(SITE_VECTOR_NAME ? { using: SITE_VECTOR_NAME } : {}) };
    const results = await qdrant.search(QDRANT_COLL, body);
    const out = (results || []).map(r => ({
      score: r.score, url: r.payload?.url, title: r.payload?.title,
      preview: (r.payload?.text || "").slice(0,160)
    }));
    res.json({ q, collection: QDRANT_COLL, using: SITE_VECTOR_NAME || "(default)", out });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log("Server listening on", PORT));
