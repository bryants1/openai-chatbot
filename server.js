import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// Home page with a super simple chat UI
app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html>
      <head>
        <title>Chatbot Demo</title>
        <style>
          body { font-family: sans-serif; padding: 2rem; max-width: 700px; margin: auto; }
          #log { white-space: pre-wrap; background:#f9f9f9; border:1px solid #ccc; padding:1rem; margin-top:1rem; }
          input { width:80%; padding:0.5rem; }
          button { padding:0.5rem 1rem; }
        </style>
      </head>
      <body>
        <h1>OpenAI Chatbot</h1>
        <p>Type a message below to talk to the chatbot:</p>
        <input id="msg" placeholder="Say hello..." />
        <button onclick="send()">Send</button>
        <div id="log"></div>
        <script>
          async function send(){
            const m = document.getElementById('msg').value;
            document.getElementById('msg').value = '';
            document.getElementById('log').innerText += "You: " + m + "\\n";
            const r = await fetch('/api/chat', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ messages:[{ role:'user', content: m }] })
            });
            const d = await r.json();
            document.getElementById('log').innerText += "Bot: " + (d.reply || "(no reply)") + "\\n\\n";
          }
        </script>
      </body>
    </html>
  `);
});

// Chat API endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { messages = [] } = req.body;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: messages.map(m => ({ role: m.role, content: m.content }))
    });

    res.json({ reply: response.output_text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Health check
app.get("/api/ping", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Chatbot API running on", PORT));
