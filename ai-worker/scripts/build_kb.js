#!/usr/bin/env node
/**
 * Builds ai-worker/kb.json -- the RAG knowledge base for the DigiClass AI
 * tutor -- straight from the same syllabus content that drives the learning
 * site (src/app.js's COURSES array). There is deliberately no separate copy
 * of the syllabus for the AI tutor to go stale against: whatever a teacher
 * can read in a chapter is exactly what the tutor can retrieve and quote.
 *
 * How it works: src/app.js is one big module, not JSON, so this script
 * slices out just the `const COURSES = [...]` declaration (everything from
 * its own `const COURSES = [];` line up to the next top-level `const EXTRA`
 * declaration that follows it), evaluates that slice in an isolated Node
 * module (no DOM, no other app.js globals in scope), and then flattens each
 * chapter's content blocks (paragraphs, tables, code, tips, lists) into
 * plain-text chunks, one per named section -- a natural chunk boundary,
 * since each section is already a self-contained teaching unit.
 *
 * Run it again (and then ai-worker/scripts/README's /reindex step) whenever
 * app.js's syllabus content changes, or when a new subject/course is added --
 * that re-run is the whole "customise DigiClass for another subject" story.
 *
 * Usage: node scripts/build_kb.js
 */
const fs = require("fs");
const path = require("path");

const APP_JS = path.join(__dirname, "..", "..", "src", "app.js");
const OUT = path.join(__dirname, "..", "kb.json");
const TMP = path.join(__dirname, "..", ".courses_extract.tmp.js");

const src = fs.readFileSync(APP_JS, "utf-8");
const lines = src.split("\n");

const startIdx = lines.findIndex((l) => /^const COURSES\s*=\s*\[\]\s*;/.test(l));
if (startIdx === -1) throw new Error("Could not find 'const COURSES = [];' in src/app.js");
const endIdx = lines.findIndex((l, i) => i > startIdx && /^const EXTRA\s*=\s*\{\}\s*;/.test(l));
if (endIdx === -1) throw new Error("Could not find the 'const EXTRA = {};' line that follows COURSES in src/app.js");

const slice = lines.slice(startIdx, endIdx).join("\n") + "\nmodule.exports = COURSES;\n";
fs.writeFileSync(TMP, slice, "utf-8");

let COURSES;
try {
  COURSES = require(TMP);
} finally {
  fs.unlinkSync(TMP);
}

function flattenBlock(block) {
  const [kind, ...rest] = block;
  if (kind === "p") return rest[0];
  if (kind === "code") return rest[0];
  if (kind === "ul") return (rest[0] || []).map((s) => "- " + s).join("\n");
  if (kind === "tip") return rest[0] + ": " + rest[1];
  if (kind === "table") {
    const headers = rest[0] || [];
    const rows = rest[1] || [];
    return headers.join(" | ") + "\n" + rows.map((r) => r.join(" | ")).join("\n");
  }
  if (kind === "f") return (rest[0] || []).join("; ");
  return "";
}
function stripMd(s) {
  return String(s).replace(/\*\*/g, "");
}

const chunks = [];
for (const course of COURSES) {
  for (const ch of course.chapters || []) {
    for (const section of ch.sec || []) {
      const [title, blocks] = section;
      const text = (blocks || []).map(flattenBlock).filter(Boolean).join("\n\n");
      if (!text.trim()) continue;
      chunks.push({
        id: `${course.id}::${ch.id}::${title.slice(0, 40).replace(/\s+/g, "_")}`,
        course: `${course.short} ${course.grade}`,
        subjectId: course.subjectId,
        chapterId: ch.id,
        chapterTitle: ch.title,
        sectionTitle: title,
        text: stripMd(`${title}\n${text}`),
      });
    }
  }
}

fs.writeFileSync(OUT, JSON.stringify(chunks));
console.log(`Wrote ${OUT}: ${chunks.length} chunks from ${COURSES.length} courses (${COURSES.map((c) => c.id).join(", ")}).`);
