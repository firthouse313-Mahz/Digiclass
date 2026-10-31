/**
 * digiclass-ai -- the Cloudflare Worker behind the "DigiClass AI" chat
 * widget, rewritten as a retrieval-augmented generation (RAG) agent.
 *
 * Before this version, a student's question went straight to a language
 * model with no grounding, so it could answer from the model's general
 * training rather than from what was actually taught in class, and had no
 * way to say "that's not in our syllabus." This version adds a retrieval
 * step in front of generation:
 *
 *   1. Embed the student's question with a Workers AI embedding model.
 *   2. Look up the nearest chunks of DigiClass's own syllabus content
 *      (built by ../scripts/build_kb.js from the same data the learning
 *      site itself renders) in a Cloudflare Vectorize index.
 *   3. Hand those chunks to a Workers AI text-generation model as context,
 *      with an instruction to answer from them and say so plainly when a
 *      question falls outside the syllabus, instead of guessing.
 *
 * Models (Cloudflare Workers AI):
 *   - Embeddings: @cf/baai/bge-base-en-v1.5  (768-dim, cosine metric)
 *   - Generation: @cf/meta/llama-3.1-8b-instruct
 *
 * Two routes:
 *   POST /          the chat endpoint the widget calls: { question, history } -> { answer, sources }
 *   POST /reindex    (admin only, header x-admin-key) re-embeds kb.json and
 *                    upserts it into Vectorize -- run this after build_kb.js
 *                    whenever the syllabus content changes, or after adding
 *                    a new subject's content to src/app.js. This re-run is
 *                    the entire "customise DigiClass for another subject"
 *                    workflow for the AI tutor's side.
 */
import KB from "../kb.json";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const GEN_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const TOP_K = 4;
const EMBED_BATCH = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const question = String(body.question || "").trim().slice(0, 600);
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  if (!question) return json({ error: "empty question" }, 400);

  // 1. Embed the question.
  const qEmbed = await env.AI.run(EMBED_MODEL, { text: [question] });
  const vector = qEmbed.data[0];

  // 2. Retrieve the nearest syllabus chunks.
  const matches = await env.VECTORIZE.query(vector, {
    topK: TOP_K,
    returnMetadata: "all",
  });
  const hits = (matches.matches || []).filter((m) => m.score > 0.45);

  const context = hits
    .map((m, i) => `[${i + 1}] (${m.metadata.course} - ${m.metadata.chapterTitle} - ${m.metadata.sectionTitle})\n${m.metadata.text}`)
    .join("\n\n");

  const sources = hits.map((m) => ({
    course: m.metadata.course,
    chapter: m.metadata.chapterTitle,
    section: m.metadata.sectionTitle,
    score: Math.round(m.score * 100) / 100,
  }));

  // 3. Generate an answer grounded in the retrieved context.
  const systemPrompt = hits.length
    ? `You are the DigiClass AI Tutor, helping a CBSE Grade 11-12 Computer Science / Informatics Practices student. ` +
      `Answer using ONLY the syllabus material below -- do not use outside knowledge, and do not contradict it. ` +
      `If the material doesn't actually answer the question, say plainly that it isn't covered in the syllabus material you have, rather than guessing. ` +
      `Keep answers short, clear and encouraging, with a worked example where the material has one.\n\n` +
      `--- Syllabus material ---\n${context}\n--- end ---`
    : `You are the DigiClass AI Tutor for a CBSE Grade 11-12 Computer Science / Informatics Practices student. ` +
      `No matching syllabus material was found for this question. Say so plainly, and suggest the student ask their teacher or pick a more specific question, rather than guessing an answer.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) })),
    { role: "user", content: question },
  ];

  const result = await env.AI.run(GEN_MODEL, { messages, temperature: 0.3, max_tokens: 600 });

  return json({ answer: result.response, sources });
}

async function handleReindex(request, env) {
  const key = request.headers.get("x-admin-key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);

  let indexed = 0;
  for (let i = 0; i < KB.length; i += EMBED_BATCH) {
    const batch = KB.slice(i, i + EMBED_BATCH);
    const embed = await env.AI.run(EMBED_MODEL, { text: batch.map((c) => c.text) });
    const vectors = batch.map((c, j) => ({
      id: c.id,
      values: embed.data[j],
      metadata: {
        course: c.course,
        subjectId: c.subjectId,
        chapterId: c.chapterId,
        chapterTitle: c.chapterTitle,
        sectionTitle: c.sectionTitle,
        text: c.text.slice(0, 1500),
      },
    }));
    await env.VECTORIZE.upsert(vectors);
    indexed += vectors.length;
  }
  return json({ ok: true, indexed, total: KB.length });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    try {
      if (url.pathname === "/reindex") return await handleReindex(request, env);
      return await handleChat(request, env);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },
};
