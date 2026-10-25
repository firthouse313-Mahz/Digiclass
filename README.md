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
