// lib/openaiClient.js (ESM)
import OpenAI from "openai";

let _openai = null;
let _prefix = null;

/** Single OpenAI client, created on first use only. */
export function getOpenAI() {
  if (_openai) return _openai;
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY is missing. Put it in server.js/.env (OPENAI_API_KEY=sk-...).");
  }
  _prefix = key.slice(0, 6);
  console.log(`[openai] Using OPENAI_API_KEY prefix = ${_prefix}…`);
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

export const openai = getOpenAI();
