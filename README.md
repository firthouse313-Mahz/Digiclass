# DigiClass

A single-page web app for running CS lessons: encrypted lesson content,
live teacher tools (unlock lesson, call groups, see results come in), a
student-facing game layer (DigiGame), and a Google Apps Script backend
for activity/feedback logging.

The deployed site is just `index.html`, served statically (e.g. GitHub
Pages). Everything the app does lives inside one encrypted blob in that
file; a small unencrypted "gate" script decrypts it at load time.

## How it's built (source of truth)

```
src/app.js      the entire app, in plain readable JavaScript
src/shell.html  everything else: <head>, CSS, the gate script,
                and a single {{DCDATA}} placeholder
build.py        compresses + encrypts src/app.js and splices the
                result into src/shell.html to produce index.html
```

**Edit `src/app.js` directly** for any change to app logic, views, or
behaviour. Don't hand-edit `index.html` — it's a generated file.

To rebuild and deploy:

```bash
python3 build.py --verify
```

`--verify` decrypts the freshly built `index.html` straight back and
checks it matches `src/app.js` byte-for-byte, and `build.py` always
runs `node --check` on `src/app.js` first, so a syntax error or a bad
encryption never reaches the live site silently.

Commit `src/app.js` and the regenerated `index.html` together. Because
the blob is encrypted with a fresh random IV every build, `index.html`
will always show as changed even for a one-line edit — that's expected;
only `src/app.js`'s diff tells you what actually changed.

### Why this exists

Before this script existed, every change was made by decrypting the
*live* `index.html`, editing the decrypted text in a scratch file, and
splicing a freshly-encrypted blob back in by hand. That workflow had no
real diff history (git only ever saw ciphertext change) and directly
caused production bugs this project has already hit: a JS closure-scope
bug that silently broke a button's click handler, and a stale check
that showed teacher-only UI to students. `build.py` adds the syntax
check and round-trip verification as a safety net, and `src/app.js`
gives every future change a real, reviewable diff.

### Pre-commit safety check

`scripts/check_integrity.py` runs four checks before any commit --
JS syntax, that `TEACH_ENC`'s 283 entries are all intact and
well-formed, that `COURSES`/`SUBJECTS` are present with balanced
braces, and the full `build.py --verify` round-trip. It's wired up as
a git pre-commit hook, so it runs automatically and blocks the commit
if anything's broken, with a message pointing at the cause.

Git doesn't version `.git/hooks/`, so after a **fresh clone** run this
once:

```bash
sh scripts/install_hooks.sh
```

## What must never be committed

This repo is **public**. These files contain real secrets and must stay
out of git entirely (and are already covered by `.gitignore`):

- `learn_key.json` — the AES key that encrypts/decrypts the app bundle.
  `build.py` reads it from `/home/claude/dc/learn_key.json` by default
  (override with the `DC_LEARN_KEY_PATH` environment variable). Losing
  control of this key means anyone could decrypt or re-sign the app
  bundle.
- `teach_keys.json` — the real per-lesson key pairs used to fill in the
  `KEYS` map in the deployed Apps Script.
- **Any filled-in copy of the Apps Script** with real values for
  `CLASS_CODE`, `TEACHER_PIN`, `LEARN_KEY`, or `KEYS`. The file in this
  repo, `sheet-script-template.gs`, is a *template* — those four spots
  are placeholders (`/*__CODE__*/`, `/*__LEARN__*/`, `/*__KEYS__*/`, and
  a `'CHANGE-ME'` PIN). The real, filled-in script lives only inside the
  teacher's own Google Sheet (Extensions → Apps Script), never in git.

If any of these ever do get committed by mistake, treat them as
compromised: rotate the key / PIN / class code and redeploy, don't just
delete the commit (history still has it until the key itself changes).

## Apps Script backend

`sheet-script-template.gs` is the whole backend: it logs student
activity and feedback into a Google Sheet, issues per-lesson keys only
once a teacher "starts" that lesson, and gates access behind a class
code (students) or PIN (teacher). To deploy your own:

1. Create a Google Sheet, open Extensions → Apps Script.
2. Paste in `sheet-script-template.gs`.
3. Fill in `TEACHER_PIN`, `CLASS_CODE`, `LEARN_KEY`, and `KEYS` with your
   own real values — then **never commit that filled-in copy anywhere**.
4. Deploy → New deployment → Web app → Execute as: Me, Who has access:
   Anyone → Deploy, and copy the Web app URL into the app's config.

**Python Legends (the "Digi Game" link) uses this same script and Sheet**,
through its own `plclaim` (name+PIN login), `plload`, and `plsave`
actions — a separate "PL Students" roster and "PL Progress" sheet, with
no connection to a student's DigiClass identity or PIN. If you already
have this script deployed, you only need to: paste the updated
`sheet-script-template.gs` over your real (secrets-filled) copy in
Extensions → Apps Script, keeping your real `TEACHER_PIN`/`CLASS_CODE`/
`LEARN_KEY`/`KEYS` values in place, then Deploy → Manage deployments →
✏️ Edit → Version: New version → Deploy. The Web app URL stays the same,
so nothing else needs updating.

## Weekly performance digest (email agent)

A small rule-based agent, also in `sheet-script-template.gs`, that reads
the same Activity log the in-app "My Class (live)" dashboard reads, works
out who's doing well, who needs support, and which topics to re-teach —
the same 60%-understood bar and suggested-action text the dashboard
already uses — and emails that summary to the teacher automatically, on
a weekly schedule, with no one needing to open the dashboard.

Each email has these sections: **top performers**, **ready for a
challenge** (students the mastery model below now rates "Strong" on a
topic — see "Weekly parent update"), **students who need support** (with
the chapter they're struggling on most), **topics to re-teach**
(class-wide, with a one-line suggested next step), and **students gone
quiet** (no activity in the last 7 days). A student or chapter needs at
least `DIGEST_MIN_QUIZZES` (2) quiz attempts that week before being
judged at all — not enough data yet, rather than a shaky verdict. ("Ready
for a challenge" only ever covers Computer Science — see `BKT_SUBJECT`
below — so a subject teacher's own digest only shows it if her subject
is Computer Science.)

Setup, after you've already deployed the script above:

1. In your real (secrets-filled) copy of the script, set `TEACHER_EMAIL`
   to your own address (and/or add `email: '...'` to any `SUBJECT_TEACHERS`
   entry — that subject teacher then gets her own digest, filtered to
   just her subject, same as her PIN already filters everything else).
2. Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.
3. In the Apps Script editor: Triggers (clock icon, left sidebar) → **+
   Add Trigger** → Function: `sendWeeklyPerformanceReport` → Event
   source: Time-driven → Week timer → pick a day and hour → Save. The
   first run will ask you to approve Gmail/MailApp access — approve it.

To test it immediately instead of waiting for the trigger: open
`<your Web app URL>?action=senddigest&pin=<TEACHER_PIN>` once in a
browser, or run `sendWeeklyPerformanceReport` from the Apps Script
editor's function picker. Either way it sends right away using
whatever's in the Activity log so far.

`DIGEST_WINDOW_DAYS`, `DIGEST_OK`, `DIGEST_HIGH`, `DIGEST_TOP_N`, and
`DIGEST_MIN_QUIZZES` near the top of the script tune the thresholds —
e.g. raise `DIGEST_HIGH` if "top performer" should mean 90%+, not 85%+.

## Adaptive mastery model + weekly parent update

A step up from the plain weekly average above: a small **Bayesian
Knowledge Tracing (BKT)** model, also in `sheet-script-template.gs`,
that tracks a probability of mastery **per student, per chapter**,
updated after every Computer Science **quiz attempt AND individual
practice-bank "Try it yourself" code question** across that student's
*whole* history — not just the current week. A student who aced a topic
a month ago and hasn't touched it since still reads as "mastered"; one
who guessed right on a single quiz doesn't. Both those attempt types are
auto-marked right/wrong with no human judgement, so BKT can trust them
the same way; self- or peer-rated activity (group-work slider ratings,
exit tickets) and whole mock-paper scores are deliberately left out of
the model, since those aren't a clean per-question correct/incorrect
signal. Including individual code questions matters in practice, not
just in theory: a full chapter quiz is a relatively rare event, while
students answer practice-bank questions constantly, so a class that's
only logged a couple of dozen full quizzes may already have hundreds of
these finer-grained attempts for the model to learn from.

This feeds two things:

1. **The teacher digest's "Ready for a challenge" section** above — any
   student the model now rates "Strong" (≥75% estimated mastery, with
   enough attempts to trust it) on a chapter.
2. **A weekly email per student, sent to that student's parent** — what
   the model estimates they currently understand well, what needs more
   practice, and the one topic to focus on this week. The address comes
   from a **"Parent Contacts"** sheet (`Student ID | Student Name |
   Parent Email`, created automatically), filled in two ways:
   - **Automatically**, from the "Join your class" screen itself: every
     student now sees an optional "Email (yours or a parent's)" field.
     If they fill it in, `doPost` saves it straight into "Parent
     Contacts" by their Student ID the moment they join — once, ever;
     re-joining later with the field left blank never erases what was
     saved. A garbled value (missing `@`, no `.`) is rejected rather
     than saved. This covers every *new* join from here on.
   - **Manually**, for everyone who joined before this existed, or any
     student who skipped the field: add their row yourself, matching the
     Student ID already in the "Students" sheet.
   Either way, a student with no row there yet, or too little Computer
   Science activity yet, is skipped that week rather than sent a shaky or empty
   email.

Setup, after you've already deployed the script above:

1. Fill in the "Parent Contacts" sheet (see above).
2. Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.
3. Triggers → **+ Add Trigger** → Function: `sendWeeklyParentReports` →
   Event source: Time-driven → Week timer → pick a day and hour → Save.

To test immediately: open `<your Web app URL>?action=sendparentdigest&pin=<TEACHER_PIN>`
once, or run `sendWeeklyParentReports` from the Apps Script editor's
function picker.

`BKT_SUBJECT`, `BKT_P_INIT`, `BKT_P_TRANSIT`, `BKT_P_GUESS`,
`BKT_P_SLIP`, `BKT_STRONG`, `BKT_NEEDS_PRACTICE`, and `BKT_MIN_ATTEMPTS`
near the top of the script tune the model — the four `BKT_P_*` values
are the standard BKT parameters (prior, learning rate, guess rate, slip
rate); a dissertation methodology chapter can cite these directly, and
`research/bkt_eval.py` (below) fits and evaluates them properly against
a real exported Activity log instead of the reasonable defaults shipped
here.

### Automatic in-app challenge questions

Separately, the student-facing app itself (`src/app.js`) reacts to
mastery in the moment: finishing a chapter quiz with a strong score
(≥80% on that attempt), on a chapter that already has real board-pattern
"Challenge"-level questions in its practice bank, now shows a **"🧠 Try
the Challenge round"** button right on the score screen — one tap opens
a 20-minute Study Sprint pulling only that chapter's hardest tagged
questions. No new question content was written for this: DigiClass
already tags practice-bank questions by difficulty (`src/app.js`'s
`bankOf`/`pickBank`, used by the existing Study Sprint); this just
decides *when* to surface the hard ones, instead of waiting for a
student to find Study Sprint on their own. This immediate nudge uses
the quiz's own current-attempt score, which is a lighter, instant signal
than the full BKT model above — the two are complementary: one reacts
inside the app right away, the other builds the longer-term picture the
teacher and parents see.

### Unit practice papers feed the mastery model too

Every unit listing (`unitBlock()` in `src/app.js`) now links straight to
that unit's practice paper(s) — found automatically from the paper id
convention `<courseId>-u<unitNumber>`, `-2`, `-3` (see `unitPapers()`),
so a new paper needs no separate unit→paper map kept in sync by hand.
On submission, every auto-marked MCQ in the paper (not just the overall
score) is sent as its own "code" event, keyed by that paper's id — the
same clean right/wrong signal a chapter quiz or practice-bank question
already gives `bktMastery_()` in `sheet-script-template.gs`. That means
finishing a unit's practice paper now actually moves its estimated
mastery, the same way finishing its chapter quizzes does, rather than
only producing a one-off aggregate score. (A unit paper spans several
chapters, so its mastery estimate is keyed by the paper's own id, not
folded into one specific chapter's number.)

### For the dissertation: `research/bkt_eval.py` and `research/early_predict.py`

`research/bkt_eval.py` is a standalone Python script (no Apps Script, no
Google Sheet needed to run it) that fits BKT parameters properly via EM
(Baum–Welch) against real quiz-attempt sequences and evaluates the fit —
held-out prediction accuracy, log-loss, and a calibration check —
instead of just asserting the hand-picked constants above are
reasonable. Run it with no arguments to see it work on a built-in
synthetic dataset; point it at a CSV exported from an "Activity -
Computer Science" sheet to fit and evaluate against real student data.
See the comment at the top of the file for the exact CSV columns
expected and how to export one.

`research/early_predict.py` is the companion script for the
dissertation's *early-prediction* half (the BKT model above is the
*adaptive-feedback* half): it asks whether a student's first 3 attempts
on a chapter (or now, a unit paper) can predict whether they'll
eventually need practice on it — using the live BKT model's own
eventual verdict as the label, so the "ground truth" is literally what
the deployed model would eventually say, not a separately invented
target. It cross-validates a small from-scratch logistic regression
against two honest baselines (always guess the majority label; just
threshold BKT's own early-window estimate) — same zero-dependency,
synthetic-self-test style as `bkt_eval.py`. Run with no arguments for
the self-test, or point it at the same Activity CSV `bkt_eval.py` uses.
See the file's own docstring for the exact feature/label definitions
and why `EARLY_K=3` was chosen (and why that choice should be reported,
not assumed).
