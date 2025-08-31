// tools/index-site.mjs — improved chunking & metadata
import "dotenv/config";
import fetch from "node-fetch";
import { load as loadHTML } from "cheerio";
import { htmlToText } from "html-to-text";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import crypto from "node:crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QDRANT_URL     = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION     = process.env.QDRANT_COLLECTION || "site_docs";
const SITE_BASE      = (process.env.SITE_BASE || "").replace(/\/+$/, "");
const EMB_MODEL      = "text-embedding-3-small"; // switch to text-embedding-3-large if desired
const VEC_SIZE       = 1536;                      // 3072 if you switch to -large
const TIMEOUT_MS     = Number(process.env.CRAWL_TIMEOUT_MS || 12000);
const MAX_BATCH      = 150;

if (!OPENAI_API_KEY || !QDRANT_URL || !SITE_BASE) {
  console.error("Missing env. Need OPENAI_API_KEY, QDRANT_URL, SITE_BASE.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

async function ensureCollection() {
  try { await qdrant.getCollection(COLLECTION); }
  catch {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VEC_SIZE, distance: "Cosine" }
    });
  }
}

function normalizeUrl(url) { try { return new URL(url).toString().split("#")[0]; } catch { return url; } }
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fetch(url, { headers:{ "User-Agent":"site-indexer/2.0" }, signal: controller.signal }); }
  finally { clearTimeout(t); }
}

function extractDom(html) {
  const $ = loadHTML(html);
  $("script,style,svg,noscript,iframe,template").remove();
  const title = ($("title").text() || "").trim();
  const h1 = ($("h1").first().text() || "").trim();
  const h2s = $("h2").map((_,el)=>$(el).text().trim()).get();
  const mainText = htmlToText($.html(), {
    wordwrap:false,
    selectors:[{ selector:"a", options:{ ignoreHref:true } }]
  }).trim();
  return { $, title, h1, h2s, mainText };
}

// Split by H2 sections; inside each section chunk with overlap
function semanticChunks($, title, h1) {
  const sections = [];
  const nodes = $("h2, h3, p, li").toArray();
  let current = { heading:"", text:"" };
  for (const el of nodes) {
    const tag = el.tagName?.toLowerCase?.() || "";
    const txt = $(el).text().replace(/\s+/g," ").trim();
    if (!txt) continue;
    if (tag === "h2" || tag === "h3") {
      if (current.text) sections.push(current);
      current = { heading: txt, text:"" };
    } else {
      current.text += (current.text ? " " : "") + txt;
    }
  }
  if (current.text) sections.push(current);

  // chunk within each section
  const CHUNK_WORDS = 450;
  const OVERLAP = 80;
  const out = [];
  for (const s of sections) {
    const words = s.text.split(/\s+/);
    for (let i=0;i<words.length;i+= (CHUNK_WORDS-OVERLAP)) {
      const slice = words.slice(i, i+CHUNK_WORDS).join(" ");
      if (slice.length > 180) {
        out.push({
          prefix: [title, h1, s.heading].filter(Boolean).join(" > "),
          text: slice
        });
      }
    }
  }
  return out.length ? out : [{ prefix:[title, h1].filter(Boolean).join(" > "), text:$("main").text().trim() || "" }];
}

function guessCourseMeta(url) {
  // very simple: /courses/:slug  => name from slug
  const m = url.match(/\/courses\/([^/?#]+)/i);
  if (!m) return {};
  const slug = m[1];
  const name = slug.replace(/-/g," ").replace(/\b\w/g,c=>c.toUpperCase());
  // light town/state guess from url segments (customize as needed)
  const town = ""; const state = "";
  return { course_name:name, town, state };
}

function keywordsFrom(prefix, text) {
  const base = (prefix + " " + text).toLowerCase();
  const tokens = [...new Set(base.match(/[a-z]{3,}/g) || [])];
  return tokens.slice(0, 50);
}

async function embedBatch(texts) {
  if (!texts.length) return [];
  const resp = await openai.embeddings.create({ model: EMB_MODEL, input: texts });
  return resp.data.map(d => d.embedding);
}

async function upsertBatch(points) {
  if (!points.length) return;
  await qdrant.upsert(COLLECTION, {
    points: points.map(p => ({
      id: crypto.randomUUID(),
      vector: p.vector,
      payload: p.payload
    }))
  });
}

const seeds = process.argv.slice(2);
if (!seeds.length) {
  console.log("Usage: SITE_BASE=https://your-site.com node tools/index-site.mjs https://your-site.com");
  process.exit(1);
}

(async () => {
  await ensureCollection();

  const toVisit = [...new Set(seeds.map(normalizeUrl))];
  const visited = new Set();
  const batch = [];

  while (toVisit.length) {
    const url = toVisit.shift();
    if (!url.startsWith(SITE_BASE)) continue;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const r = await fetchWithTimeout(url);
      if (!r.ok) { console.log("skip", r.status, url); continue; }
      const html = await r.text();
      const { $, title, h1 } = extractDom(html);

      // discover internal links lightly
      $("a[href]").each((_, a) => {
        const href = ($(a).attr("href") || "").trim();
        if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) return;
        const abs = href.startsWith("http") ? href : new URL(href, SITE_BASE + "/").toString();
        const normalized = normalizeUrl(abs);
        if (normalized.startsWith(SITE_BASE)) toVisit.push(normalized);
      });

      const blocks = semanticChunks($, title, h1);
      if (!blocks.length) continue;

      // build prefixed text for embedding
      const texts = blocks.map(b => `${b.prefix ? b.prefix + "\n\n" : ""}${b.text}`);
      const embs = await embedBatch(texts);

      const { course_name, town, state } = guessCourseMeta(url);

      for (let i=0;i<blocks.length;i++) {
        const prefix = blocks[i].prefix || title || h1 || "";
        const text = blocks[i].text;
        batch.push({
          vector: embs[i],
          payload: {
            url,
            title,
            h1,
            prefix,
            text,
            course_name,
            town,
            state,
            keywords: keywordsFrom(prefix, text)
          }
        });
      }

      if (batch.length >= MAX_BATCH) {
        await upsertBatch(batch.splice(0, batch.length));
        console.log("Upserted", MAX_BATCH, "points; continuing…");
      }
    } catch (e) {
      console.log("error indexing", url, e.name === "AbortError" ? "timeout" : e.message);
    }
  }

  if (batch.length) {
    await upsertBatch(batch);
    console.log("Upserted remaining", batch.length, "points");
  }

  console.log("Index complete. Pages visited:", visited.size);
})().catch(e => {
  console.error("Indexer failed:", e);
  process.exit(1);
});
