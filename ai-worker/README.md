# DigiClass AI -- retrieval-augmented tutor

The Cloudflare Worker behind the "DigiClass AI" chat widget on the DigiClass
homepage. A student's question is answered using the same syllabus content
the site itself teaches from -- not the model's general knowledge -- by
retrieving the most relevant chapter sections first and handing them to the
model as context (retrieval-augmented generation, RAG).

## Architecture

```
student types a question in the widget
        |
        v
POST https://digiclass-ai.firthouse313.workers.dev/   { question, history }
        |
        v
1. Embed the question        -- @cf/baai/bge-base-en-v1.5  (768-dim, cosine)
2. Query Vectorize for the    -- index "digiclass-kb", top 4 matches
   nearest syllabus chunks
3. Generate an answer grounded -- @cf/meta/llama-3.1-8b-instruct
   in those chunks, saying
   plainly when nothing in the
   syllabus matches
        |
        v
{ answer, sources: [{ course, chapter, section, score }, ...] }
```

The knowledge base (`kb.json`) is built directly from `src/app.js`'s
`COURSES` data by `scripts/build_kb.js` -- the same content a teacher reads
in a chapter is exactly what the tutor can retrieve and quote. There is no
separate copy of the syllabus to go stale.

## One-time setup

```bash
npm install
npx wrangler login
npx wrangler vectorize create digiclass-kb --dimensions=768 --metric=cosine
npx wrangler secret put ADMIN_KEY     # pick any long random string
npx wrangler deploy
```

## Building and loading the knowledge base

Whenever the syllabus content in `src/app.js` changes -- a chapter is
edited, or a new subject is added -- rebuild and re-index:

```bash
node scripts/build_kb.js              # writes kb.json from src/app.js
npx wrangler deploy                   # ships the updated kb.json with the Worker
curl -X POST https://digiclass-ai.firthouse313.workers.dev/reindex \
  -H "x-admin-key: <the ADMIN_KEY you set above>"
```

`/reindex` embeds every chunk and upserts it into the Vectorize index. It is
the entire "customise DigiClass's AI tutor for another subject" workflow:
add the subject's chapters to `src/app.js` the same way `cs11`/`ip11` are
added, run `build_kb.js`, deploy, call `/reindex` -- the tutor can now answer
from that subject too, with no change to the retrieval or generation code.

## Why this design

- **Grounded, not guessed.** Before this, the widget sent the question
  straight to a language model with no syllabus context, so it could answer
  from the model's general training -- plausible-sounding but not
  necessarily what was taught, and with no way to say "that's not in our
  syllabus." Retrieval fixes both: the model only sees real chapter content,
  and the system prompt tells it to say so when nothing relevant was found.
- **Serverless end to end.** Workers AI and Vectorize are both usage-billed,
  no server to provision or patch -- consistent with the rest of DigiClass,
  which has to run on what a single teacher can maintain without a school
  IT budget.
- **Subject-agnostic by construction.** Retrieval and generation never
  mention Computer Science or Informatics Practices by name; everything
  subject-specific lives in `kb.json`. The Biology course already stubbed
  into `src/app.js` (`bio12`) demonstrates this: giving it real chapter
  content and re-running the steps above is enough to make the AI tutor
  answer Biology questions too.
