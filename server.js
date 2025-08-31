// server.js (ESM, single app)
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import chatbotRouter from "./api/golfChatbotRouter.js";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Home page (fixes "Cannot GET /") ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Chatbot + Quiz</title>
        <style>
          body { font-family: sans-serif; padding:2rem; max-width: 800px; margin:auto; }
          #log { white-space: pre-wrap; background:#f7f7f7; border:1px solid #ddd; border-radius:6px; padding:10px; min-height:80px; }
          input { width:70%; padding:8px; }
          button { padding:8px 12px; margin-left:8px; }
          small { color:#666; }
        </style>
      </head>
      <body>
        <h1>OpenAI Chatbot</h1>
        <div>
          <input id="msg" placeholder="Say hello or 'start quiz'..." />
          <button onclick="send()">Send</button>
        </div>
        <pre id="log"></pre>
        <small>Quiz endpoints proxied: POST <code>/api/chatbot/start</code> • POST <code>/api/chatbot/answer</code></small>
        <script>
          async function send(){
            const box = document.getElementById('msg');
            const m = box.value.trim();
            if(!m) return;
            box.value = '';
            const r = await fetch('/api/chat', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ messages:[{ role:'user', content: m }] })
            });
            const d = await r.json().catch(()=>({}));
            document.getElementById('log').textContent += "You: " + m + "\\nBot: " + (d.reply || "(no reply)") + "\\n\\n";
          }
        </script>
      </body>
    </html>
  `);
});

// simple per-browser session using a cookie
const SESS = new Map(); // sid -> { sessionId, question, answers, scores }
function getSid(req, res) {
  const raw = req.headers.cookie || "";
  const found = raw.split(";").map(s => s.trim()).find(s => s.startsWith("chat_sid="));
  if (found) return found.split("=")[1];
  const sid = Date.now().toString(36) + Math.random().toString(36).slice(2);
  res.setHeader("Set-Cookie", `chat_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}

app.post("/api/chat", async (req, res) => {
  try {
    const sid = getSid(req, res);
    const state = SESS.get(sid) || { sessionId: null, question: null, answers: {}, scores: {} };

    const { messages = [] } = req.body;
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content?.trim() || "";
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

    // ----------------------------
    // 0) Fast path: START QUIZ
    // ----------------------------
    if (/^(start|begin|let.?s\s*start).*quiz/i.test(lastUser)) {
      const r = await fetch(`${base}/api/chatbot/start`, {
        method: "POST", headers: { "Content-Type":"application/json" }, body: "{}"
      });
      const data = await r.json();
      state.sessionId = data.sessionId;
      state.question  = data.question || null;
      state.answers   = {};
      state.scores    = {};
      SESS.set(sid, state);

      if (data?.question) {
        const q = data.question;
        const lines = (q.options || []).map((o, i) => `${i}. ${o.emoji || ""} ${o.text}`);
        return res.json({
          reply: `Question ${data.questionNumber}: ${q.text}\n${lines.join("\n")}\n\nReply like: "pick 1" or just "1".`
        });
      }
      return res.json({ reply: "Started a new quiz, but I couldn't fetch a question. Try again." });
    }

    // ---------------------------------------------------------
    // 1) Fast path: NUMERIC / "pick N" / "option N" answer
    // ---------------------------------------------------------
    // If we already have a question in state and user typed a choice, answer it directly.
    const choiceMatch = lastUser.match(/^(?:pick|option)?\s*(\d+)\s*$/i);
    if (choiceMatch && state.sessionId && state.question?.id) {
      const idx = Number(choiceMatch[1]);
      const payload = {
        sessionId: state.sessionId,
        questionId: state.question.id,
        optionIndex: idx,
        currentAnswers: state.answers,
        currentScores: state.scores
      };
      const r = await fetch(`${base}/api/chatbot/answer`, {
        method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload)
      });
      const data = await r.json();

      if (data.complete) {
        state.question = null;
        SESS.set(sid, state);
        return res.json({
          reply: "Quiz complete! Profile:\n```\n" + JSON.stringify(data.profile, null, 2) + "\n```"
        });
      } else if (data.question) {
        state.question = data.question;
        state.answers  = data.currentAnswers || state.answers;
        state.scores   = data.currentScores  || state.scores;
        SESS.set(sid, state);
        const q = data.question;
        const lines = (q.options || []).map((o, i) => `${i}. ${o.emoji || ""} ${o.text}`);
        return res.json({
          reply: `Question ${data.questionNumber}: ${q.text}\n${lines.join("\n")}\n\nReply like: "pick 1" or just "1".`
        });
      } else {
        return res.json({ reply: "Thanks! I couldn’t fetch the next question; try 'start quiz' again." });
      }
    }

    // ---------------------------------------------------------
    // 2) Otherwise: fall back to OpenAI function-calling flow
    // ---------------------------------------------------------
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const sys = {
      role: "system",
      content:
        "You are a friendly golf assistant that can run a short quiz.\n" +
        "- If the user asks to start or begin the quiz, call start_quiz.\n" +
        "- If the user answers like 'pick 2' / 'option 1' OR gives a bare number like '1', call submit_quiz_answer with that index.\n" +
        "- After each tool call, present the next question with numbered options.\n" +
        "- When complete, summarize the profile."
    };

    const tools = [
      {
        type: "function",
        function: {
          name: "start_quiz",
          description: "Start a new golf quiz session and fetch the first question",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "submit_quiz_answer",
          description: "Submit answer to the current quiz question",
          parameters: {
            type: "object",
            properties: {
              optionIndex: { type: "integer", description: "Chosen option index (0..N-1)" }
            },
            required: ["optionIndex"]
          }
        }
      }
    ];

    // 2a) Ask the model (tool choice)
    const first = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [sys, ...messages],
      tools,
      tool_choice: "auto"
    });

    const assistantMsg = first.choices?.[0]?.message;
    const toolCalls = assistantMsg?.tool_calls || [];
    if (!toolCalls.length) {
      return res.json({ reply: assistantMsg?.content || "(no reply)" });
    }

    // 2b) Execute the tool
    const call = toolCalls[0];
    let toolResult = null;

    if (call.function.name === "start_quiz") {
      const r = await fetch(`${base}/api/chatbot/start`, {
        method: "POST", headers: { "Content-Type":"application/json" }, body: "{}"
      });
      const data = await r.json();
      state.sessionId = data.sessionId;
      state.question  = data.question || null;
      state.answers   = {};
      state.scores    = {};
      SESS.set(sid, state);
      toolResult = data;
    }

    if (call.function.name === "submit_quiz_answer") {
      const args = JSON.parse(call.function.arguments || "{}");

      if (!state.sessionId || !state.question) {
        const r0 = await fetch(`${base}/api/chatbot/start`, {
          method: "POST", headers: { "Content-Type":"application/json" }, body: "{}"
        });
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
        method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload)
      });
      const data = await r.json();

      if (data.complete) {
        state.question = null;
      } else {
        state.question = data.question || null;
        state.answers  = data.currentAnswers || state.answers;
        state.scores   = data.currentScores  || state.scores;
      }
      SESS.set(sid, state);
      toolResult = data;
    }

    // 2c) Continue convo: include assistantMsg (with tool_calls), then a tool message with tool_call_id
    const follow = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        sys,
        ...messages,
        assistantMsg, // required to reply to tool_calls
        {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult)
        }
      ]
    });

    // UX: format question clearly
    let reply = follow.choices?.[0]?.message?.content || "(no reply)";
    if (toolResult?.question) {
      const q = toolResult.question;
      const lines = (q.options || []).map((o, i) => `${i}. ${o.emoji || ""} ${o.text}`);
      reply = `Question ${toolResult.questionNumber}: ${q.text}\n${lines.join("\n")}\n\nReply like: "pick 1" or just "1".`;
    } else if (toolResult?.complete) {
      reply = "Quiz complete! Profile:\n```\n" + JSON.stringify(toolResult.profile, null, 2) + "\n```";
    }

    return res.json({ reply, tool: toolResult });

  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({ error: String(err) });
  }
});
// ── Mount quiz router (proxies to your Vercel quiz API) ───────────────────────
app.use("/api/chatbot", chatbotRouter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/ping", (_, res) => res.json({ ok: true }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server listening on", PORT));
