// server.js — Chatbot with Quiz tools in chat: start, answer, finish (recommendations), feedback
// - Uses OpenAI Chat Completions + function calling
// - Proxies quiz Q&A to your existing endpoints: /api/chatbot/start, /api/chatbot/answer
// - Calls your finish & feedback endpoints: /api/quiz/finish, /api/quiz/feedback
// Drop-in: update PUBLIC_BASE_URL if needed.

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

// Routers you already have
import chatbotRouter from "./api/golfChatbotRouter.js"; // exposes /start and /answer
import quizRouter from "./api/quizRouter.js";           // exposes /finish and /feedback (from previous step)

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ---- Config ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. http://localhost:8080

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- Minimal UI ----
app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html><html><head><meta charset="utf-8"/>
      <title>Quiz Chatbot</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:2rem;max-width:900px;margin:auto}
        #log{white-space:pre-wrap;background:#f7f7f7;border:1px solid #ddd;border-radius:6px;padding:10px;min-height:120px}
        input{width:70%;padding:8px} button{padding:8px 12px;margin-left:8px} small{color:#666}
      </style>
    </head><body>
      <h1>Quiz Chatbot</h1>
      <div><input id="msg" placeholder="Say 'start quiz', answer with 'pick 1', then 'finish', or 'feedback 5 great fit'"/>
           <button onclick="send()">Send</button></div>
      <div id="log"></div>
      <small>Proxied quiz endpoints: POST <code>/api/chatbot/start</code> • POST <code>/api/chatbot/answer</code> • POST <code>/api/quiz/finish</code> • POST <code>/api/quiz/feedback</code></small>
      <script>
        function add(w, t){ const d=document.createElement('div'); d.textContent=w+": "+t; document.getElementById('log').appendChild(d); }
        async function send(){
          const box=document.getElementById('msg'); const m=box.value.trim(); if(!m) return; box.value='';
          add('You', m);
          const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
             body:JSON.stringify({messages:[{role:'user',content:m}]})});
          const d=await r.json().catch(()=>({reply:'(no reply)'}));
          add('Bot', d.html || d.reply || '(no reply)');
        }
      </script>
    </body></html>
  `);
});

// ---- Session store (per-browser via cookie) ----
const SESS = new Map(); // sid -> { sessionId, question, answers, scores, finalProfile, finalRecommendations }
function getSid(req, res) {
  const raw = req.headers.cookie || "";
  const found = raw.split(";").map(s=>s.trim()).find(s=>s.startsWith("chat_sid="));
  if (found) return found.split("=")[1];
  const sid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  res.setHeader("Set-Cookie", `chat_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}

// ---- Chat with function calling ----
app.post("/api/chat", async (req, res) => {
  try {
    const sid = getSid(req, res);
    const state = SESS.get(sid) || {
      sessionId: null,
      question: null,
      answers: {},       // filled from /api/chatbot/answer responses
      scores: {},        // filled from /api/chatbot/answer responses
      finalProfile: null,
      finalRecommendations: null
    };

    const { messages = [] } = req.body;
    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

    // ---- Fast-path intents (optional, nice UX) ----
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content?.trim() || "";

    // Finish (user-typed)
    if (!state.question && /\b(finish|results|recommend(ation)?s)\b/i.test(lastUser)) {
      const rf = await fetch(`${base}/api/quiz/finish`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, answers: state.answers })
      });
      const fin = await rf.json();
      state.finalProfile = fin.profile;
      state.finalRecommendations = fin.recommendations;
      SESS.set(sid, state);

      const rec = fin.recommendations || {};
      const html =
        `<strong>Your Recommendations</strong>\n` +
        `• Style: ${rec.courseStyle}\n` +
        `• Budget: ${rec.budgetLevel}\n` +
        (Array.isArray(rec.why) && rec.why.length ? `• Why: ${rec.why.join("; ")}` : "") +
        `\n\nReply “feedback 5 great fit” or “feedback 2 too expensive”.`;
      return res.json({ html });
    }

    // Feedback (user-typed): "feedback 5 great fit"
    const fb = lastUser.match(/\bfeedback\s+([1-5])(?:\s+(.*))?$/i);
    if (!state.question && fb) {
      const rating = Number(fb[1]); const comment = fb[2] || "";
      await fetch(`${base}/api/quiz/feedback`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          rating, helpful: rating >= 4, comment,
          profile: state.finalProfile || null,
          recommendations: state.finalRecommendations || null
        })
      });
      return res.json({ html: `Thanks! Recorded your feedback (${rating}★).` });
    }

    // ---- Define tools for the model ----
    const tools = [
      {
        type: "function",
        function: {
          name: "start_quiz",
          description: "Start a new quiz session and return the first question",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "submit_quiz_answer",
          description: "Submit the current answer (option index 0..N-1) and get the next question",
          parameters: {
            type: "object",
            properties: { optionIndex: { type: "integer", minimum: 0 } },
            required: ["optionIndex"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "finish_quiz",
          description: "Generate final profile + recommendations based on current session answers",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "submit_feedback",
          description: "Submit user feedback on the final recommendations",
          parameters: {
            type: "object",
            properties: {
              rating:  { type: "integer", minimum: 1, maximum: 5, description: "1–5 stars" },
              helpful: { type: "boolean" },
              comment: { type: "string" }
            },
            required: ["rating"]
          }
        }
      }
    ];

    // ---- First call: let the model decide to call a tool ----
    const sys = {
      role: "system",
      content:
        "You are a helpful golf quiz assistant.\n" +
        "- If the user says 'start quiz', call start_quiz.\n" +
        "- If they answer with 'pick 1' / 'option 2' / a bare number, call submit_quiz_answer.\n" +
        "- If they ask to 'finish' / 'show results' / 'recommendations', call finish_quiz.\n" +
        "- If they say 'feedback 5 ...' call submit_feedback with that rating and comment.\n" +
        "After each tool call, present the result clearly and concisely."
    };

    const first = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [sys, ...messages],
      tools,
      tool_choice: "auto"
    });

    const assistantMsg = first.choices?.[0]?.message;
    const toolCalls = assistantMsg?.tool_calls || [];

    // If no tool call, just return the assistant's content
    if (!toolCalls.length) {
      return res.json({ reply: assistantMsg?.content || "(no reply)" });
    }

    // ---- Handle the first (and only) tool call ----
    const call = toolCalls[0];
    let toolResult = null;

    if (call.function.name === "start_quiz") {
      const r = await fetch(`${base}/api/chatbot/start`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" });
      const data = await r.json();

      // set session state
      state.sessionId = data.sessionId;
      state.question  = data.question || null;
      state.answers   = {};
      state.scores    = {};
      state.finalProfile = null;
      state.finalRecommendations = null;
      SESS.set(sid, state);

      toolResult = {
        type: "start_quiz_result",
        data
      };
    }

    if (call.function.name === "submit_quiz_answer") {
      const args = JSON.parse(call.function.arguments || "{}");
      // if session not started, start it implicitly
      if (!state.sessionId || !state.question) {
        const r0 = await fetch(`${base}/api/chatbot/start`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" });
        const d0 = await r0.json();
        state.sessionId = d0.sessionId;
        state.question  = d0.question || null;
        state.answers   = {};
        state.scores    = {};
      }

      const payload = {
        sessionId: state.sessionId,
        questionId: state.question?.id,
        optionIndex: Number(args.optionIndex),
        currentAnswers: state.answers,
        currentScores: state.scores
      };

      const r = await fetch(`${base}/api/chatbot/answer`, {
        method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload)
      });
      const data = await r.json();

      // update state from answer response
      if (data.currentAnswers) state.answers = data.currentAnswers;
      if (data.currentScores)  state.scores  = data.currentScores;
      if (data.question) {
        state.question = data.question;  // next question
      } else {
        state.question = null;           // maybe finished by control flow
      }
      SESS.set(sid, state);

      toolResult = {
        type: "submit_quiz_answer_result",
        data
      };
    }

    if (call.function.name === "finish_quiz") {
      const r = await fetch(`${base}/api/quiz/finish`, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, answers: state.answers })
      });
      const data = await r.json();

      state.finalProfile         = data.profile || null;
      state.finalRecommendations = data.recommendations || null;
      SESS.set(sid, state);

      toolResult = {
        type: "finish_quiz_result",
        data: {
          summary: data.insights?.summary || "",
          recommendations: data.recommendations || {},
          profile: data.profile || {}
        }
      };
    }

    if (call.function.name === "submit_feedback") {
      const args = JSON.parse(call.function.arguments || "{}");
      const r = await fetch(`${base}/api/quiz/feedback`, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          rating: args.rating,
          helpful: !!args.helpful,
          comment: args.comment || "",
          profile: state.finalProfile || null,
          recommendations: state.finalRecommendations || null
        })
      });
      const data = await r.json();

      toolResult = {
        type: "submit_feedback_result",
        data
      };
    }

    // ---- Option A: format certain tool results ourselves (clear UX) ----
    if (toolResult?.type === "finish_quiz_result") {
      const rec = toolResult.data.recommendations || {};
      const html =
        `<strong>Your Recommendations</strong>\n` +
        `• Style: ${rec.courseStyle}\n` +
        `• Budget: ${rec.budgetLevel}\n` +
        (Array.isArray(rec.why) && rec.why.length ? `• Why: ${rec.why.join("; ")}` : "") +
        `\n\nReply “feedback 5 great fit” or “feedback 2 too expensive”.`;
      return res.json({ html, tool: toolResult });
    }

    if (toolResult?.type === "submit_quiz_answer_result") {
      // Show next question (if any)
      const q = toolResult.data?.question;
      if (q) {
        const lines = (q.options || []).map((o,i)=> `${i}. ${o.emoji || ""} ${o.text}`).join("\n");
        return res.json({ reply: `Question ${toolResult.data?.questionNumber || ""}: ${q.text}\n${lines}\n\nReply like: "pick 1" or "option 1".` });
      }
    }

    if (toolResult?.type === "submit_feedback_result") {
      return res.json({ reply: "Thanks for your feedback! 🙏" });
    }

    // ---- Option B: continue conversation via model (include assistantMsg and our tool output) ----
    const follow = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        sys,
        ...messages,
        assistantMsg, // the one with tool_calls
        {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult || {})
        }
      ]
    });

    return res.json({ reply: follow.choices?.[0]?.message?.content || "(no reply)" });

  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ---- Mount your existing routers ----
app.use("/api/chatbot", chatbotRouter); // /start, /answer
app.use("/api/quiz", quizRouter);       // /finish, /feedback

// ---- Health ----
app.get("/api/ping", (_, res) => res.json({ ok: true }));

// ---- Start ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server listening on", PORT));
