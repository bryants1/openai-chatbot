// quiz/engine.js  (ESM, pure logic—no Express here)

import { createClient } from "@supabase/supabase-js";

/* =========================================================================
   Env / clients
   ========================================================================= */
// Lazy Supabase client creation
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;

  const SUPABASE_URL = process.env.SUPABASE_URL || "";
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[engine] Supabase URL/key missing — reads may fail and writes will be skipped.");
    return null;
  }

  _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log("[engine] Supabase client created successfully");
  return _supabase;
}

// Import OpenAI client from server.js
import { openai } from "../server.js";

async function getOpenAI() {
  return openai; // already configured with the correct key
}

/* =========================================================================
   10-D vector model (snake_case dims)
   ========================================================================= */
export const DIMS10 = [
  "overall_difficulty","strategic_variety","penal_vs_playable","physical_demands",
  "weather_adaptability","conditions_quality","facilities_amenities",
  "service_operations","value_proposition","aesthetic_appeal"
];

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function isNum(n){ return typeof n === "number" && Number.isFinite(n); }

export function scoresTo10D(scores = {}) {
  return DIMS10.map(k => {
    const n = Number(scores?.[k]);
    return Number.isFinite(n) ? clamp01(n / 10) : null;
  });
}
function progressToConf(progress = {}) {
  return DIMS10.map(k => {
    const c = progress?.[k]?.confidence;
    return isNum(c) ? c : null;
  });
}

// Aggregation fallback: average rawScores (0..1) per dim, convert to 0..10
function aggregateScoresFromAnswers(answers = {}) {
  const acc = Object.create(null); // {dim:{sum,count}}
  for (const a of Object.values(answers)) {
    const raw = a?.rawScores || {};
    for (const [dim, w] of Object.entries(raw)) {
      const v = Number(w);
      if (!Number.isFinite(v)) continue;
      acc[dim] = acc[dim] ? { sum: acc[dim].sum + v, count: acc[dim].count + 1 } : { sum: v, count: 1 };
    }
  }
  const out = {};
  for (const dim of DIMS10) {
    const b = acc[dim];
    out[dim] = b ? (b.sum / b.count) * 10 : 0;
  }
  return out;
}

/* =========================================================================
   Question bank + formatting (reads from Supabase)
   ========================================================================= */
function safeJSON(x){ try { return JSON.parse(x); } catch { return {}; } }

function normKeys(obj = {}) {
  // allow camelCase coming from DB; normalize to snake_case model
  const map = {
    overallDifficulty: "overall_difficulty",
    strategicVariety: "strategic_variety",
    penalVsPlayable: "penal_vs_playable",
    physicalDemands: "physical_demands",
    weatherAdaptability: "weather_adaptability",
    conditionsQuality: "conditions_quality",
    facilitiesAmenities: "facilities_amenities",
    serviceOperations: "service_operations",
    valueProposition: "value_proposition",
    aestheticAppeal: "aesthetic_appeal",
  };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = map[k] || k;
    const n   = typeof v === "string" ? Number(v) : v;
    if (Number.isFinite(n)) out[key] = n; // 0..1 weight as stored per option
  }
  return out;
}

async function loadQuestionBank() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase client not configured");

  const { data, error } = await supabase
    .from("questions")
    .select(`
      id,
      question_id,
      type,
      priority,
      question_text,
      question_options (
        option_text,
        option_emoji,
        option_index,
        scores
      )
    `)
    .order("priority", { ascending: false });

  if (error) throw error;

  return (Array.isArray(data) ? data : []).map(q => ({
    id: q.question_id,                 // label id like Q1_...
    type: q.type,
    priority: q.priority ?? 0,
    question: q.question_text,
    options: (Array.isArray(q.question_options) ? q.question_options : [])
      .slice()
      .sort((a,b)=> a.option_index - b.option_index)
      .map(opt => ({
        index: opt.option_index,
        text:  opt.option_text,
        emoji: opt.option_emoji,
        // per-option scores are 0..1 weights per dim; normalize keys to snake_case
        scores: normKeys(typeof opt.scores === "string" ? safeJSON(opt.scores) : (opt.scores || {}))
      }))
  }));
}

async function conversationalize(question_text, options) {
  const openai = await getOpenAI();
  if (!openai) return question_text || "";
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role:"system", content:"Rephrase this quiz question to ONE casual conversational line. No numbers or options." },
        { role:"user",   content:`Question: "${question_text || ""}"\nOptions (do not show): ${(options || []).join(" | ")}` }
      ],
      temperature: 0.5,
      max_tokens: 60
    });
    return r.choices[0]?.message?.content?.trim() || question_text || "";
  } catch { return question_text || ""; }
}

async function formatForChat(q) {
  const opts = q.options || [];
  const conv = await conversationalize(q.question, opts.map(o=>o.text));
  return {
    id: q.id,
    text: q.question,
    conversational_text: conv,
    options: opts.map(o => ({ index: o.index, text: o.text, emoji: o.emoji }))
  };
}

/* =========================================================================
   ML service (with robust fallback)
   ========================================================================= */
let __ml, __mlInit;
async function getMLService() {
  if (__ml) return __ml;
  if (__mlInit) { await __mlInit; return __ml; }
  __mlInit = (async () => {
    try {
      const { default: MLService } = await import("./ml/MLService.js");
      const supabase = getSupabase();
      __ml = new MLService({ supabase });
      if (typeof __ml.initialize === "function") await __ml.initialize();
    } catch (e) {
      console.warn("[engine] MLService failed, using fallback:", e?.message || e);
      __ml = {
        isInitialized: false,
        async selectNextQuestion(answers, _scores, bank) {
          const answered = new Set(Object.keys(answers || {}));
          const avail = (bank || []).filter(q => !answered.has(q.id));
          if (!avail.length) return null;
          return avail.sort((a,b)=>(b.priority||0)-(a.priority||0))[0];
        },
        async calculateScores(answers) {
          return aggregateScoresFromAnswers(answers);
        },
        async generateProfile(answers, scores) {
          return basicProfileFrom10D(scores);
        },
        async getCourseMatchesBy5D() { return []; }
      };
    }
  })();
  await __mlInit;
  return __ml;
}

/* =========================================================================
   Basic profile from 10-D (fallback)
   ========================================================================= */
function basicProfileFrom10D(s = {}) {
  const prefs = [];
  if ((s.strategic_variety ?? 0) >= 7) prefs.push("Enjoys strategic/varied layouts");
  if ((s.penal_vs_playable ?? 0) <= 3) prefs.push("Prefers forgiving over penal setups");
  if ((s.physical_demands ?? 0) >= 7) prefs.push("Comfortable with higher physical demands");
  if ((s.conditions_quality ?? 0) >= 7) prefs.push("Values top turf conditions");
  if ((s.facilities_amenities ?? 0) >= 7) prefs.push("Cares about facilities & amenities");
  if ((s.service_operations ?? 0) >= 7) prefs.push("Appreciates strong operations/service");
  if ((s.value_proposition ?? 0) >= 7) prefs.push("Value-conscious");
  if ((s.aesthetic_appeal ?? 0) >= 7) prefs.push("Loves scenic courses");

  const od = s.overall_difficulty ?? 0;
  const pd = s.physical_demands ?? 0;
  const skillAvg = (od + pd) / 2;
  const skill =
    skillAvg <= 2 ? "New to Golf" :
    skillAvg <= 4 ? "Recreational Player" :
    skillAvg <= 6 ? "Regular Golfer" :
    skillAvg <= 8 ? "Serious Player" : "Advanced Golfer";

  let courseStyle = "balanced parkland";
  if (od >= 7 && (s.strategic_variety ?? 0) >= 6) courseStyle = "championship";
  else if ((s.aesthetic_appeal ?? 0) >= 7 && (s.strategic_variety ?? 0) >= 5) courseStyle = "resort/parkland";
  else if ((s.strategic_variety ?? 0) >= 7) courseStyle = "strategic/links-inspired";
  else if (od <= 4) courseStyle = "playable/forgiving";

  return {
    skillLevel: { label: skill },
    preferences: { core: prefs },
    recommendations: {
      courseStyle,
      budgetLevel:
        (s.conditions_quality ?? 0) >= 8 ? "Premium ($100+)" :
        (s.value_proposition ?? 0) >= 7 ? "Value ($25–50)" : "Mid-range ($50–100)",
      amenities: (s.facilities_amenities ?? 0) >= 6
        ? ["Driving range","Short-game area","Practice greens"]
        : ["Basic facilities"]
    },
    scores10d: s
  };
}

/* =========================================================================
   Persistence helpers (user_session / user_profile)
   ========================================================================= */
async function upsertSession({ sessionId, userId, answers, scores, questionSequence }) {
  const supabase = getSupabase();
  if (!supabase) return;

  const payload = {
    session_id: sessionId,
    user_id: userId || null,
    answers: answers || {},
    scores:  scores  || {},
    question_sequence: Array.isArray(questionSequence) ? questionSequence : [],
    last_seen_at: new Date().toISOString()
  };
  // Started_at on first insert is fine (won't override existing)
  if (!payload.started_at) payload.started_at = new Date().toISOString();
  const { error } = await supabase.from("user_session").upsert(payload, { onConflict: "session_id" });
  if (error) console.warn("[engine] user_session upsert error:", error.message || error);
}

async function patchProfile({ userId, scores }) {
  const supabase = getSupabase();
  if (!supabase || !userId) return;

  const vec  = scoresTo10D(scores || {});
  const conf = null; // you can pass confidence array if you track progress separately
  const { error } = await supabase.from("user_profile").upsert({
    user_id: userId,
    user_10d: vec,
    user_10d_confidence: conf,
    profile_updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });
  if (error) console.warn("[engine] user_profile upsert error:", error.message || error);
}

/* =========================================================================
   Finish predicate
   ========================================================================= */
function shouldFinish(scores = {}, count = 0) {
  // simple coverage + cap
  const covered = DIMS10.some(k => (scores?.[k] ?? 0) > 0);
  if (count >= 10) return true;
  if (count >= 5 && covered) return true;
  return false;
}

/* =========================================================================
   Public API (pure functions)
   ========================================================================= */

export async function startSession({ sessionId, skipLocation, location, availability }) {
  const ml = await getMLService();
  const bank = await loadQuestionBank();

  if (skipLocation) {
    const mcBank = bank.filter(q => Array.isArray(q.options) && q.options.length > 0 && !/^Q0_/i.test(q.id));
    const first  = await ml.selectNextQuestion({}, {}, mcBank, 0, { sessionId, location, availability }) || mcBank[0];
    const question = await formatForChat(first);
    return { sessionId, questionNumber: 1, question, location };
  }

  return {
    sessionId,
    questionNumber: 0,
    totalQuestions: "5–10",
    needsLocation: true,
    mlEnabled: ml.isInitialized !== false
  };
}

export async function getQuestion({ questionId }) {
  const bank = await loadQuestionBank();
  const q    = bank.find(x => x.id === questionId);
  if (!q) throw new Error("Question not found");
  return await formatForChat(q);
}

export async function submitAnswer({
  sessionId,
  questionId,
  optionIndex,       // number for MC
  capture,           // object for capture questions
  currentAnswers = {},
  currentScores  = {},
  location,
  userId
}) {
  const ml   = await getMLService();
  const bank = await loadQuestionBank();
  const q    = bank.find(x => x.id === questionId);
  if (!q) throw new Error("Invalid questionId");

  let answers = { ...currentAnswers };

  // Capture (WHERE/WHEN) or MC
  const isCapture =
    !!capture ||
    (Array.isArray(q.options) && q.options.length === 0) ||
    /^Q0_(WHERE|WHEN)$/i.test(q.id) ||
    /^capture/i.test(q.type || "");

  if (isCapture) {
    answers[q.id] = {
      questionText: q.question || q.id,
      answer: "[captured]",
      optionIndex: null,
      capture: capture || {}
    };
  } else {
    if (!Number.isFinite(optionIndex)) throw new Error("Missing optionIndex for MC question");
    const idx = Number(optionIndex);
    const opt = (q.options || []).find(o => Number(o.index) === idx);
    if (!opt) throw new Error("Invalid optionIndex for this question");
    answers[q.id] = {
      questionText: q.question || q.id,
      answer: opt.text,
      optionIndex: idx,
      rawScores: opt.scores || {}   // 0..1 weights by dim
    };
  }

  // Updated scores: prefer ML; fallback to aggregates
  let scores;
  try {
    scores = await ml.calculateScores(answers, bank);
  } catch {
    scores = aggregateScoresFromAnswers(answers);
  }

  // Done?
  const count = Object.keys(answers).length;
  if (shouldFinish(scores, count)) {
    const profile = await buildProfileWithMatches(answers, scores, sessionId, ml, location);

    // Build question sequence and persist
    const questionSequence = [...Object.keys(currentAnswers), questionId];
    await Promise.allSettled([
      upsertSession({ sessionId, userId, answers, scores, questionSequence }),
      patchProfile({ userId, scores })
    ]);

    return { complete: true, profile, scores, totalQuestions: count, currentAnswers: answers, currentScores: scores };
  }

  // Next question (exclude Q0_* from MC flow)
  const mcBank = bank.filter(qq => Array.isArray(qq.options) && qq.options.length > 0 && !/^Q0_/i.test(qq.id));
  const next   = await ml.selectNextQuestion(answers, scores, mcBank, count, { sessionId, location });

  if (!next) {
    const profile = await buildProfileWithMatches(answers, scores, sessionId, ml, location);

    // Build question sequence and persist
    const questionSequence = [...Object.keys(answers)];
    await Promise.allSettled([
      upsertSession({ sessionId, userId, answers, scores, questionSequence }),
      patchProfile({ userId, scores })
    ]);

    return { complete: true, profile, scores, totalQuestions: count, currentAnswers: answers, currentScores: scores };
  }

  const question = await formatForChat(next);

  // Persist snapshot with question sequence
  const questionSequence = [...Object.keys(answers)];
  await Promise.allSettled([
    upsertSession({ sessionId, userId, answers, scores, questionSequence })
  ]);

  return {
    complete: false,
    questionNumber: count + 1,
    question,
    currentAnswers: answers,
    currentScores: scores,
    location
  };
}

export async function finishSession({ sessionId, currentAnswers = {}, currentScores = {}, location, userId }) {
  const ml   = await getMLService();
  const bank = await loadQuestionBank();

  let scores = currentScores;
  if (!scores || Object.keys(scores).length === 0) {
    try { scores = await ml.calculateScores(currentAnswers, bank); }
    catch { scores = aggregateScoresFromAnswers(currentAnswers); }
  }

  const profile = await buildProfileWithMatches(currentAnswers, scores, sessionId, ml, location);

  // Build question sequence and persist
  const questionSequence = [...Object.keys(currentAnswers)];
  await Promise.allSettled([
    upsertSession({ sessionId, userId, answers: currentAnswers, scores, questionSequence }),
    patchProfile({ userId, scores })
  ]);

  return {
    complete: true,
    profile,
    scores,
    totalQuestions: Object.keys(currentAnswers || {}).length
  };
}

export async function searchCourses({ scores, limit = 20, location, filters = {} }) {
  const ml = await getMLService();
  if (!ml || typeof ml.getCourseMatchesBy5D !== "function") {
    return { courses: [], mlEnhanced: false, message: "ML service not available" };
  }
  let courses = await ml.getCourseMatchesBy5D(scores || {}, { ...filters, topK: limit, location });
  courses = (courses || []).map(c => ({ ...c, url: c.url || c.payload?.course_url || c.payload?.website || null }));
  return { courses, mlEnhanced: true };
}

export async function getMLStats() {
  const ml = await getMLService();
  if (ml && typeof ml.getMLStatistics === "function") return await ml.getMLStatistics();
  return { model: { version: "fallback", initialized: false }, data: { totalProfiles: 0, totalFeedbacks: 0 } };
}

/* =========================================================================
   Helpers
   ========================================================================= */
async function buildProfileWithMatches(answers, scores, sessionId, ml, location) {
  let profile = null;
  try {
    if (ml && typeof ml.generateProfile === "function") profile = await ml.generateProfile(answers, scores, sessionId, { location });
  } catch (e) {
    console.warn("[engine] ml.generateProfile failed:", e?.message || e);
  }
  if (!profile) profile = basicProfileFrom10D(scores);

  // attach matches if available
  try {
    if (ml && typeof ml.getCourseMatchesBy5D === "function") {
      const matches = await ml.getCourseMatchesBy5D(scores, { topK: 8, location });
      if (Array.isArray(matches) && matches.length) {
        profile.matchedCourses = matches.map(m => ({
          name: m.name || m.payload?.course_name || "Course",
          url: m.url || m.payload?.course_url || m.payload?.website || null,
          score: m.score,
          distance: m.distance
        }));
      }
    }
  } catch (e) {
    console.warn("[engine] attach matches failed:", e?.message || e);
  }
  return profile;
}
