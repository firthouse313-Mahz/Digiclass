// =====================================================================
// DigiClass – class sheet script (with DigiClass Teach lesson keys)
// Paste ALL of this into: Google Sheet → Extensions → Apps Script
// Then: Deploy → Manage deployments → Edit → Version: New version → Deploy
// (first time: Deploy → New deployment → Web app → Execute as: Me,
//  Who has access: Anyone → Deploy → copy the Web app URL.)
//
// TEMPLATE NOTE: this is the committed, secrets-free version of the script.
// The real deployed copy of this file lives only in the teacher's own Google
// Sheet and has three placeholders below filled in with real values that
// must NEVER be committed to this (public) repo:
//   CLASS_CODE  - the real code students use to open DigiClass
//   LEARN_KEY   - the AES key that unlocks the encrypted app bundle
//   KEYS        - the real per-lesson [student key, teacher key] pairs
// See README.md -> "What must never be committed" before touching this file.
// =====================================================================

// 1) CHANGE THIS to your own secret PIN (numbers or letters).
//    You type it on DigiClass's teacher pages.
const TEACHER_PIN = 'CHANGE-ME';

// 1b) OPTIONAL, ERP-style: hand out a SEPARATE PIN per subject teacher. Each one
//     can run DigiClass Teach, see live results and download CSV for ONLY their
//     own subject's topics (any topic whose id starts with subjectId) -- they
//     never see your other subjects' classes or student data, and can't touch
//     archive or class-wide settings. You (TEACHER_PIN) keep full access to
//     everything, and can add or remove rows here any time (no new deploy
//     needed for students -- just Deploy a new version so the new PIN works).
//     subjectId must match the start of that subject's topic ids (see KEYS
//     below), e.g. Informatics Practices topics are "ip11-...", so subjectId is 'ip'.
const SUBJECT_TEACHERS = [
  // { pin: 'IP-DEMO-2026', subjectId: 'ip', subjectName: 'Informatics Practices', email: 'ip-teacher@school.example' },
];

// 1c) OPTIONAL: your own email, to receive the weekly performance digest
//     (see "Weekly performance digest" below) covering every subject. Leave
//     blank to skip the digest entirely. A SUBJECT_TEACHERS entry with its
//     own "email" above also gets its own digest, filtered to that subject
//     only -- she never sees another subject's students.
const TEACHER_EMAIL = '';

// 2) CLASS CODE: give this to your students so they can open DigiClass.
//    You can change it any time (then Deploy a new version). Students who
//    already opened DigiClass on their device stay in.
//    Use something hard to guess, at least 8 letters/numbers.
const CLASS_CODE = /*__CODE__*/'';

// Unlocks the DigiClass pages. Do not share this script.
const LEARN_KEY = /*__LEARN__*/'';

// Weekly performance digest settings -- see "Weekly performance digest" below.
const DIGEST_WINDOW_DAYS = 7;     // how far back "this week" looks
const DIGEST_OK = 0.6;            // same 60% bar "My Class (live)" uses for "understood"
const DIGEST_HIGH = 0.85;         // average quiz score at/above this = "top performer"
const DIGEST_TOP_N = 5;           // how many names to list in each section at most
const DIGEST_MIN_QUIZZES = 2;     // ignore a student/chapter with fewer quiz attempts than this -- too little data to judge

// Adaptive mastery model (Bayesian Knowledge Tracing) -- see "Weekly parent
// update" below. Unlike the plain-average digest above, this tracks a
// per-student, per-chapter *probability of mastery* that updates after every
// quiz attempt across the student's whole history, not just this week --
// so a strong topic stays "mastered" even in a quiet week, and a shaky one
// doesn't look fine just because of one lucky guess.
const BKT_SUBJECT = 'Computer Science'; // which subject this model covers
const BKT_P_INIT = 0.3;          // starting mastery estimate before any attempt
const BKT_P_TRANSIT = 0.15;      // chance of moving from "not yet" to "mastered" after one attempt
const BKT_P_GUESS = 0.25;        // chance of answering correctly while NOT yet mastered (a guess)
const BKT_P_SLIP = 0.1;          // chance of answering wrong despite having mastered it (a slip)
const BKT_STRONG = 0.75;         // mastery at/above this = "Strong" / ready for harder questions
const BKT_NEEDS_PRACTICE = 0.4;  // mastery below this = "Needs practice"
const BKT_MIN_ATTEMPTS = 2;      // ignore a chapter with fewer quiz attempts than this -- too little data to judge

const ACTIVITY_HEADERS = ['Time', 'Name', 'Class', 'Event', 'Course', 'Chapter', 'Score', 'Total', 'Student ID', 'Boy/Girl', 'Subject', 'Answer', 'Class ID'];
const FEEDBACK_HEADERS = ['Time', 'Name', 'Class', 'Type', 'Reason', 'Message', 'Page', 'About', 'Student ID', 'Boy/Girl', 'Subject', 'Class ID'];
// Each student picks their own PIN the first time they log in. Only a salted hash is stored here —
// never the PIN itself — so a classmate can't log in as someone else just by typing their name.
const STUDENT_HEADERS = ['Name', 'Salt', 'Hash', 'Student ID', 'Class', 'Subject', 'Boy/Girl', 'First seen'];

// Python Legends (the "Digi Game" link) is a SEPARATE account system from DigiClass itself —
// a student's DigiClass login does not carry over, and a Python Legends PIN does not unlock
// DigiClass. Same salted-hash pattern as STUDENT_HEADERS above, in their own sheet, so the two
// rosters never mix.
const PL_STUDENT_HEADERS = ['Name', 'Salt', 'Hash', 'Student ID', 'First seen'];
// One row per student (by Student ID); Progress is a single JSON blob (XP, coins, completed
// level/bonus ids, pathway) — small enough that one cell per student is simplest, and the whole
// game state is always written and read as one piece anyway.
const PL_PROGRESS_HEADERS = ['Student ID', 'Progress JSON', 'Updated'];

// SQL Legends (the "Digi Game" selector's second game) — same idea as Python
// Legends above: its own separate account roster and progress store, in its
// own sheets, so a student playing both games under the same name never has
// one game's progress collide with or overwrite the other's.
const SQL_STUDENT_HEADERS = ['Name', 'Salt', 'Hash', 'Student ID', 'First seen'];
const SQL_PROGRESS_HEADERS = ['Student ID', 'Progress JSON', 'Updated'];

// DigiClass Teach: one pair of keys per lesson topic [student key, teacher key].
// Students only receive a lesson's student key after you press "Start lesson".
// Do not share this script or these keys.
const KEYS = /*__KEYS__*/{};

// Activity and Feedback are split into one sheet per subject (e.g. "Activity - Computer Science"),
// so each subject's results are easy to open and analyse on their own. The Students roster stays as
// one sheet, since the same student may take more than one subject and should only need one PIN.
function subjSheet_(base, sub) {
  const s = clean_(sub, 30).trim();
  return s ? (base + ' - ' + s) : (base + ' - Other');
}

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  if (sh.getLastColumn() < headers.length) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  return sh;
}

// Keeps text short and stops spreadsheet formulas from being injected.
function clean_(v, n) {
  return String(v == null ? '' : v).replace(/^[=+\-@]/, "'").slice(0, n || 300);
}
function num_(v) {
  return (v === undefined || v === null || v === '') ? '' : Number(v);
}
function pinOk_(p) {
  return String(p.pin || '').trim() === String(TEACHER_PIN).trim();
}
function subjectTeacherFor_(p) {
  const v = String(p.pin || '').trim();
  if (!v) return null;
  for (let i = 0; i < SUBJECT_TEACHERS.length; i++) {
    if (v === String(SUBJECT_TEACHERS[i].pin).trim()) return SUBJECT_TEACHERS[i];
  }
  return null;
}
function topicInSubject_(topic, subjectId) {
  return String(topic || '').indexOf(String(subjectId || '\u0000')) === 0;
}
// DigiClass Live: one live multiplayer quiz game at a time, held in the cache (not a sheet --
// it's a short-lived, single-class-period thing, and cache gives far more headroom than
// PropertiesService for a whole class's worth of players and answers). Launching a new game
// simply replaces whatever game was running before.
function canHostGame_(p) {
  return pinOk_(p) || !!subjectTeacherFor_(p);
}
function getGame_() {
  const raw = CacheService.getScriptCache().get('GAME');
  return raw ? JSON.parse(raw) : null;
}
function setGame_(g) {
  CacheService.getScriptCache().put('GAME', JSON.stringify(g), 21600); // 6 hours, the cache's own max
}
function genCode_() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I/L/O -- easy to misread off a board
  let s = '';
  for (let i = 0; i < 4; i++) s += letters.charAt(Math.floor(Math.random() * letters.length));
  return s;
}
function norm_(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function hashPin_(pin, salt) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pin + ':' + salt, Utilities.Charset.UTF_8);
  return raw.map(function (b) { const v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
}
function findStudentRow_(sh, nameNorm) {
  if (sh.getLastRow() < 2) return -1;
  const names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < names.length; i++) { if (norm_(names[i][0]) === nameNorm) return i + 2; }
  return -1;
}
// Generic version of findStudentRow_ for sheets keyed by a column other than 1 (e.g. "PL Progress",
// keyed by Student ID in column 1 too, but kept separate since the two rosters must never cross).
function findRowByCol_(sh, col, value) {
  if (sh.getLastRow() < 2) return -1;
  const vals = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) { if (String(vals[i][0]) === value) return i + 2; }
  return -1;
}
// Loose on purpose (catches obvious typos without rejecting real but
// unusual addresses) -- this only decides whether to save what a student
// typed, never whether an email can receive mail.
function looksLikeEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}
// Upserts one row of the "Parent Contacts" sheet (see PARENT_HEADERS and
// "Weekly parent update" below) by Student ID -- called from doPost when
// a student types an email into "Join your class".
function upsertParentContact_(sid, name, email) {
  const sh = sheet_('Parent Contacts', PARENT_HEADERS);
  const row = findRowByCol_(sh, 1, sid);
  if (row < 0) sh.appendRow([sid, name, email]);
  else sh.getRange(row, 1, 1, PARENT_HEADERS.length).setValues([[sid, name, email]]);
}

// Lessons the teacher has started (stored in the script's own settings).
function groups_() {
  return Number(PropertiesService.getScriptProperties().getProperty('GROUPS') || 6);
}
function openTopics_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('OPEN') || '[]'); } catch (e) { return []; }
}
function setOpenTopics_(list) {
  PropertiesService.getScriptProperties().setProperty('OPEN', JSON.stringify(list));
}

// Students' devices send activity and feedback here.
function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    // Each answer has a unique id; if the device sends it again (retry), it is saved only once.
    const cache = CacheService.getScriptCache();
    const uid = String(d.uid || '').slice(0, 40);
    if (uid && cache.get('u_' + uid)) return out_({ ok: true, dup: true });
    const lock = LockService.getScriptLock();
    lock.waitLock(25000);
    let resp = { ok: true };
    if (d.kind === 'glaunch') {
      // Launching a live quiz game. The question set itself lives only in the teacher's own
      // (already-decrypted) browser -- this script has no other way to know question content --
      // so the client sends it here as part of starting the game; the server just holds it for
      // the game's lifetime and relays it to players.
      const dIsTeacher = pinOk_(d);
      const dSt = !dIsTeacher ? subjectTeacherFor_(d) : null;
      const dCanLaunch = dIsTeacher || (dSt && dSt.subjectName === d.subject);
      if (!dCanLaunch) {
        resp = { error: 'pin' };
      } else {
        const qset = Array.isArray(d.qset) ? d.qset.slice(0, 20).map(function (x) {
          return { q: clean_(x.q, 220), o: (x.o || []).slice(0, 4).map(function (s) { return clean_(s, 100); }), a: Number(x.a) || 0 };
        }).filter(function (x) { return x.q && x.o.length >= 2; }) : [];
        if (!qset.length) {
          resp = { error: 'empty' };
        } else {
          const code = genCode_();
          setGame_({
            code: code, subject: clean_(d.subject, 30), title: clean_(d.title, 80), qset: qset,
            qSeconds: Math.max(5, Math.min(60, Number(d.qSeconds) || 20)), status: 'lobby', qi: -1, qStart: 0,
            players: {}, createdAt: Date.now()
          });
          resp = { ok: true, code: code };
        }
      }
    } else if (d.kind === 'plsave') {
      // Python Legends pushing its current progress snapshot after a level/boss completion.
      // The whole state is sent each time (it's tiny — a handful of ids and numbers), so this
      // is a plain upsert, never a partial merge that could drift from the client's real state.
      const sid = String(d.sid || '').trim();
      const json = JSON.stringify(d.progress || {});
      if (!sid || json.length > 8000) {
        resp = { error: sid ? 'toolarge' : 'sid' };
      } else {
        const sh = sheet_('PL Progress', PL_PROGRESS_HEADERS);
        const row = findRowByCol_(sh, 1, sid);
        if (row < 0) sh.appendRow([sid, json, new Date()]);
        else sh.getRange(row, 1, 1, PL_PROGRESS_HEADERS.length).setValues([[sid, json, new Date()]]);
      }
    } else if (d.kind === 'sqlsave') {
      // SQL Legends pushing its current progress snapshot — same upsert pattern as plsave above.
      const sid = String(d.sid || '').trim();
      const json = JSON.stringify(d.progress || {});
      if (!sid || json.length > 8000) {
        resp = { error: sid ? 'toolarge' : 'sid' };
      } else {
        const sh = sheet_('SQL Progress', SQL_PROGRESS_HEADERS);
        const row = findRowByCol_(sh, 1, sid);
        if (row < 0) sh.appendRow([sid, json, new Date()]);
        else sh.getRange(row, 1, 1, SQL_PROGRESS_HEADERS.length).setValues([[sid, json, new Date()]]);
      }
    } else if (d.kind === 'feedback') {
      sheet_(subjSheet_('Feedback', d.sub), FEEDBACK_HEADERS).appendRow([
        new Date(), clean_(d.name, 40), clean_(d.cls, 5), clean_(d.type, 20), clean_(d.reason, 40),
        clean_(d.message, 800), clean_(d.page, 100), clean_(d.ref, 60), clean_(d.sid, 12), clean_(d.g, 5), clean_(d.sub, 25), clean_(d.classId, 12)
      ]);
    } else {
      sheet_(subjSheet_('Activity', d.sub), ACTIVITY_HEADERS).appendRow([
        new Date(), clean_(d.name, 40), clean_(d.cls, 5), clean_(d.event, 10), clean_(d.course, 8),
        clean_(d.chapter, 40), num_(d.score), num_(d.total), clean_(d.sid, 12), clean_(d.g, 5), clean_(d.sub, 25), clean_(d.ans, 10), clean_(d.classId, 12)
      ]);
      // A student who typed an email into "Join your class" (optional --
      // their own, or a parent's) gets saved straight into "Parent
      // Contacts", the same sheet the weekly parent update reads from --
      // so it's entered once, ever, not re-typed by hand for every
      // student. Only runs on 'join' with a real-looking email; re-joining
      // with the field left blank never erases an email saved earlier.
      if (d.event === 'join' && looksLikeEmail_(d.email) && d.sid) {
        upsertParentContact_(clean_(d.sid, 12), clean_(d.name, 40), clean_(d.email, 80).toLowerCase());
      }
    }
    if (uid) cache.put('u_' + uid, '1', 21600);
    lock.releaseLock();
    return out_(resp);
  } catch (err) {
    return out_({ error: String(err) });
  }
}

function doGet(e) {
  const p = e.parameter || {};
  const a = p.action || '';
  // Public: student keys of lessons the teacher has started.
  if (a === 'open') {
    const open = {};
    openTopics_().forEach(function (t) { if (KEYS[t]) open[t] = KEYS[t][0]; });
    let call = null; try { call = JSON.parse(PropertiesService.getScriptProperties().getProperty('CALL') || 'null'); } catch (err) {}
    return out_({ ok: true, open: open, groups: groups_(), call: call });
  }
  // Public, only for a lesson that is live: the answers groups posted (group name + answer, no student names).
  if (a === 'board') {
    const t = String(p.topic || '');
    const cid = String(p.classId || '');
    if (openTopics_().indexOf(t) < 0) return out_({ error: 'locked' });
    const posts = rows_('Feedback', ['ts', 'name', 'cls', 'type', 'reason', 'message', 'page', 'ref', 'classId'], 4000)
      .filter(function (r) { return r.type === 'group' && String(r.ref).indexOf(t + '#') === 0 && (!cid || !r.classId || r.classId === cid); })
      .map(function (r) { return { ts: r.ts, g: r.reason, a: String(r.ref).split('#')[1], msg: r.message }; });
    return out_({ ok: true, posts: posts, groups: groups_() });
  }
  // Class code (or the teacher PIN) unlocks the site. Too many wrong tries = 10-minute wait.
  if (a === 'learn') {
    const cache = CacheService.getScriptCache();
    const fails = Number(cache.get('learnFails') || 0);
    if (fails >= 30) return out_({ error: 'busy' });
    const c = String(p.code || '').trim().toUpperCase();
    if (c && pinOk_({ pin: p.code })) return out_({ ok: true, key: LEARN_KEY, teacher: true });
    if (c) {
      const st = subjectTeacherFor_({ pin: p.code });
      if (st) return out_({ ok: true, key: LEARN_KEY, teacher: true, demoSubject: st.subjectId });
    }
    if (c && c === String(CLASS_CODE).trim().toUpperCase()) return out_({ ok: true, key: LEARN_KEY });
    cache.put('learnFails', String(fails + 1), 600);
    return out_({ error: 'code' });
  }
  // A student's own PIN: first time, it's set; every time after, it must match.
  // Stops anyone who just knows the class code from logging in as a classmate by typing their name.
  if (a === 'claim') {
    const nameRaw = String(p.name || '').slice(0, 40), pin = String(p.pin || '').trim();
    const nameNorm = norm_(nameRaw);
    if (!nameNorm || pin.length < 4) return out_({ error: 'short' });
    const cache = CacheService.getScriptCache();
    const failKey = 'pf_' + nameNorm;
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= 8) return out_({ error: 'busy' });
    const lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      const sh = sheet_('Students', STUDENT_HEADERS);
      const row = findStudentRow_(sh, nameNorm);
      if (row < 0) {
        const salt = Utilities.getUuid();
        const hash = hashPin_(pin, salt);
        const sid = Utilities.getUuid().slice(0, 8);
        sh.appendRow([nameRaw, salt, hash, sid, clean_(p.cls, 5), clean_(p.sub, 25), clean_(p.g, 5), new Date()]);
        lock.releaseLock();
        return out_({ ok: true, sid: sid, created: true });
      }
      const vals = sh.getRange(row, 1, 1, STUDENT_HEADERS.length).getValues()[0];
      const salt = vals[1], hash = vals[2], sid = vals[3];
      if (hashPin_(pin, salt) === hash) {
        cache.remove(failKey);
        lock.releaseLock();
        return out_({ ok: true, sid: sid, created: false });
      }
      cache.put(failKey, String(fails + 1), 600);
      lock.releaseLock();
      return out_({ error: 'pin' });
    } catch (err) {
      try { lock.releaseLock(); } catch (e2) {}
      return out_({ error: String(err) });
    }
  }
  // Python Legends' own login — same first-time-sets-it, every-time-after-must-match PIN pattern
  // as 'claim' above, but in the separate "PL Students" roster so this account has nothing to do
  // with the student's DigiClass identity.
  if (a === 'plclaim') {
    const nameRaw = String(p.name || '').slice(0, 40), pin = String(p.pin || '').trim();
    const nameNorm = norm_(nameRaw);
    if (!nameNorm || pin.length < 4) return out_({ error: 'short' });
    const cache = CacheService.getScriptCache();
    const failKey = 'plpf_' + nameNorm;
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= 8) return out_({ error: 'busy' });
    const lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      const sh = sheet_('PL Students', PL_STUDENT_HEADERS);
      const row = findStudentRow_(sh, nameNorm);
      if (row < 0) {
        const salt = Utilities.getUuid();
        const hash = hashPin_(pin, salt);
        const sid = Utilities.getUuid().slice(0, 8);
        sh.appendRow([nameRaw, salt, hash, sid, new Date()]);
        lock.releaseLock();
        return out_({ ok: true, sid: sid, created: true });
      }
      const vals = sh.getRange(row, 1, 1, PL_STUDENT_HEADERS.length).getValues()[0];
      const salt = vals[1], hash = vals[2], sid = vals[3];
      if (hashPin_(pin, salt) === hash) {
        cache.remove(failKey);
        lock.releaseLock();
        return out_({ ok: true, sid: sid, created: false });
      }
      cache.put(failKey, String(fails + 1), 600);
      lock.releaseLock();
      return out_({ error: 'pin' });
    } catch (err) {
      try { lock.releaseLock(); } catch (e2) {}
      return out_({ error: String(err) });
    }
  }
  // A logged-in Python Legends session asking for its saved progress (XP, coins, completed
  // levels/bonuses, pathway) so it can resume on whatever device this is, not just this browser.
  // No progress saved yet (brand-new account) is a normal, non-error case: progress: null.
  if (a === 'plload') {
    const sid = String(p.sid || '').trim();
    if (!sid) return out_({ error: 'sid' });
    const sh = sheet_('PL Progress', PL_PROGRESS_HEADERS);
    const row = findRowByCol_(sh, 1, sid);
    if (row < 0) return out_({ ok: true, progress: null });
    const json = sh.getRange(row, 2, 1, 1).getValues()[0][0];
    let progress = null;
    try { progress = JSON.parse(json); } catch (e) { progress = null; }
    return out_({ ok: true, progress: progress });
  }
  // SQL Legends' own login — same pattern as plclaim above, its own "SQL Students" roster.
  if (a === 'sqlclaim') {
    const nameRaw = String(p.name || '').slice(0, 40), pin = String(p.pin || '').trim();
    const nameNorm = norm_(nameRaw);
    if (!nameNorm || pin.length < 4) return out_({ error: 'short' });
    const cache = CacheService.getScriptCache();
    const failKey = 'sqlpf_' + nameNorm;
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= 8) return out_({ error: 'busy' });
    const lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      const sh = sheet_('SQL Students', SQL_STUDENT_HEADERS);
      const row = findStudentRow_(sh, nameNorm);
      if (row < 0) {
        const salt = Utilities.getUuid();
        const hash = hashPin_(pin, salt);
        const sid = Utilities.getUuid().slice(0, 8);
        sh.appendRow([nameRaw, salt, hash, sid, new Date()]);
        lock.releaseLock();
        return out_({ ok: true, sid: sid, created: true });
      }
      const vals = sh.getRange(row, 1, 1, SQL_STUDENT_HEADERS.length).getValues()[0];
      const salt = vals[1], hash = vals[2], sid = vals[3];
      if (hashPin_(pin, salt) === hash) {
        cache.remove(failKey);
        lock.releaseLock();
        return out_({ ok: true, sid: sid, created: false });
      }
      cache.put(failKey, String(fails + 1), 600);
      lock.releaseLock();
      return out_({ error: 'pin' });
    } catch (err) {
      try { lock.releaseLock(); } catch (e2) {}
      return out_({ error: String(err) });
    }
  }
  // A logged-in SQL Legends session asking for its saved progress — same pattern as plload above.
  if (a === 'sqlload') {
    const sid = String(p.sid || '').trim();
    if (!sid) return out_({ error: 'sid' });
    const sh = sheet_('SQL Progress', SQL_PROGRESS_HEADERS);
    const row = findRowByCol_(sh, 1, sid);
    if (row < 0) return out_({ ok: true, progress: null });
    const json = sh.getRange(row, 2, 1, 1).getValues()[0][0];
    let progress = null;
    try { progress = JSON.parse(json); } catch (e) { progress = null; }
    return out_({ ok: true, progress: progress });
  }
  // Teacher-only: a student mistyped their PIN too many times and is locked out for up to
  // 10 minutes ("too many tries"), or has genuinely forgotten their PIN. &name= is the student's
  // display name exactly as they type it (matched the same case-insensitive way 'claim' does).
  // mode=unlock (default) just clears the lockout so they can try their PIN again right away.
  // mode=forgot also deletes their Students row, so their next login sets a brand-new PIN --
  // use this when they truly don't remember it (their chapter/quiz history is kept; only the
  // PIN itself is reset, since that history is tracked by name, not by this row).
  if (a === 'resetpin') {
    const isTeacher = pinOk_(p);
    const st = !isTeacher ? subjectTeacherFor_(p) : null;
    if (!isTeacher && !st) return out_({ error: 'pin' });
    const nameNorm = norm_(p.name || '');
    if (!nameNorm) return out_({ error: 'name' });
    CacheService.getScriptCache().remove('pf_' + nameNorm);
    if (String(p.mode || '') === 'forgot') {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        const sh = sheet_('Students', STUDENT_HEADERS);
        const row = findStudentRow_(sh, nameNorm);
        if (row > 0) sh.deleteRow(row);
        return out_({ ok: true, cleared: true, forgot: true, found: row > 0 });
      } finally {
        lock.releaseLock();
      }
    }
    return out_({ ok: true, cleared: true });
  }
  // DigiClass Live (a Kahoot/Gimkit-style live quiz): join and play are public, like the class
  // code itself -- there's nothing sensitive in a join code or a game's live scoreboard.
  if (a === 'gjoin') {
    const code = String(p.code || '').trim().toUpperCase();
    const name = clean_(p.name, 24).trim();
    if (!name) return out_({ error: 'name' });
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const g = getGame_();
      if (!g || g.code !== code) return out_({ error: 'notfound' });
      if (g.status !== 'lobby') return out_({ error: 'started' });
      if (Object.keys(g.players).length >= 80) return out_({ error: 'full' });
      const pid = Utilities.getUuid().slice(0, 8);
      g.players[pid] = { name: name, score: 0, streak: 0, answered: {} };
      setGame_(g);
      return out_({ ok: true, pid: pid, title: g.title });
    } finally {
      lock.releaseLock();
    }
  }
  if (a === 'gpoll') {
    const g = getGame_();
    if (!g || g.code !== String(p.code || '').trim().toUpperCase()) return out_({ error: 'notfound' });
    const pid = String(p.pid || '');
    const me = g.players[pid] || null;
    const ranked = Object.keys(g.players).map(function (k) { return { pid: k, name: g.players[k].name, score: g.players[k].score }; });
    ranked.sort(function (x, y) { return y.score - x.score; });
    const rank = me ? (ranked.findIndex(function (x) { return x.pid === pid; }) + 1) : 0;
    let q = null;
    if (g.qi >= 0 && g.qi < g.qset.length) {
      const qq = g.qset[g.qi];
      q = { qi: g.qi, q: qq.q, o: qq.o, total: g.qset.length };
      if (g.status === 'reveal') q.a = qq.a;
    }
    return out_({
      ok: true, status: g.status, title: g.title, qSeconds: g.qSeconds, qStart: g.qStart,
      question: q, leaderboard: ranked.slice(0, 10), playerCount: ranked.length,
      me: me ? { name: me.name, score: me.score, streak: me.streak, rank: rank, answeredThis: g.qi >= 0 && me.answered[g.qi] !== undefined } : null
    });
  }
  if (a === 'ganswer') {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const g = getGame_();
      if (!g || g.code !== String(p.code || '').trim().toUpperCase()) return out_({ error: 'notfound' });
      if (g.status !== 'question') return out_({ error: 'closed' });
      const pid = String(p.pid || ''), qi = Number(p.qi);
      const pl = g.players[pid];
      if (!pl) return out_({ error: 'unknown player' });
      if (qi !== g.qi) return out_({ error: 'stale' });
      if (pl.answered[qi] !== undefined) return out_({ error: 'already' });
      const choice = Number(p.choice);
      const correct = choice === g.qset[qi].a;
      const elapsed = Date.now() - g.qStart;
      let pts = 0;
      if (correct) {
        pl.streak = (pl.streak || 0) + 1;
        const speedBonus = Math.max(0, Math.round(500 * (1 - Math.min(elapsed, g.qSeconds * 1000) / (g.qSeconds * 1000))));
        pts = 500 + speedBonus + Math.min(pl.streak - 1, 5) * 50;
      } else {
        pl.streak = 0;
      }
      pl.score = (pl.score || 0) + pts;
      pl.answered[qi] = { c: choice, ok: correct, pts: pts };
      setGame_(g);
      return out_({ ok: true, correct: correct, points: pts, score: pl.score, streak: pl.streak });
    } finally {
      lock.releaseLock();
    }
  }
  // Host controls: any valid teacher PIN (full or subject-scoped) can run the game -- there's
  // only one at a time, so this mirrors the trust level the randomiser/open-topic actions use.
  if (a === 'gnext' || a === 'greveal' || a === 'gend') {
    if (!canHostGame_(p)) return out_({ error: 'pin' });
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const g = getGame_();
      if (!g) return out_({ error: 'notfound' });
      if (a === 'greveal') {
        g.status = 'reveal';
      } else if (a === 'gend') {
        g.status = 'ended';
      } else {
        g.qi += 1;
        if (g.qi >= g.qset.length) { g.status = 'ended'; }
        else { g.status = 'question'; g.qStart = Date.now(); }
      }
      setGame_(g);
      return out_({ ok: true, status: g.status, qi: g.qi });
    } finally {
      lock.releaseLock();
    }
  }

  if (a === '') return out_({ ok: true, app: 'DigiClass' });

  const isTeacher = pinOk_(p);
  const st = !isTeacher ? subjectTeacherFor_(p) : null;
  if (!isTeacher && !st) return out_({ error: 'pin' });

  // Subject-scoped teacher PIN: full working access -- Teach, live results, CSV download,
  // locking her own lessons -- but only for topics whose id starts with her subjectId, and
  // never the whole-sheet operations (archive, the shared group-size setting).
  if (st) {
    if (a === 'keys') {
      const keys = {};
      Object.keys(KEYS).forEach(function (t) { if (topicInSubject_(t, st.subjectId)) keys[t] = KEYS[t]; });
      return out_({ ok: true, keys: keys, open: openTopics_().filter(function (t) { return topicInSubject_(t, st.subjectId); }) });
    }
    if (a === 'unlock' || a === 'lock') {
      const t = String(p.topic || '');
      if (!topicInSubject_(t, st.subjectId) || !KEYS[t]) return out_({ error: 'not allowed for this PIN' });
      let list = openTopics_().filter(function (x) { return x !== t; });
      if (a === 'unlock') list.push(t);
      setOpenTopics_(list);
      if (p.g) PropertiesService.getScriptProperties().setProperty('GROUPS', String(Math.max(2, Math.min(9, Number(p.g) || 6))));
      return out_({ ok: true, open: list.filter(function (x) { return topicInSubject_(x, st.subjectId); }) });
    }
    if (a === 'call') {
      const t = String(p.topic || '');
      if (!topicInSubject_(t, st.subjectId)) return out_({ error: 'not allowed for this PIN' });
      const c = { topic: t.slice(0, 60), num: Number(p.num) || 0, g: String(p.g || '').slice(0, 30), ts: Date.now() };
      PropertiesService.getScriptProperties().setProperty('CALL', JSON.stringify(c));
      return out_({ ok: true, call: c });
    }
    if (a === 'lockall') {
      // Only close HER subject's open topics -- other subjects' live lessons keep running.
      const list = openTopics_().filter(function (t) { return !topicInSubject_(t, st.subjectId); });
      setOpenTopics_(list);
      return out_({ ok: true, open: list });
    }
    if (a === 'summary') {
      const t = String(p.topic || '');
      const cid = String(p.classId || '');
      if (t) {
        if (!topicInSubject_(t, st.subjectId)) return out_({ error: 'not allowed for this PIN' });
        const act = rows_('Activity', ['ts', 'name', 'cls', 'event', 'course', 'chapter', 'score', 'total', 'sid', 'g', 'sub', 'ans', 'classId'], 4000)
          .filter(function (r) { return String(r.chapter) === t && (!cid || !r.classId || r.classId === cid); });
        const fb = rows_('Feedback', ['ts', 'name', 'cls', 'type', 'reason', 'message', 'page', 'ref', 'sid', 'g', 'sub', 'classId'], 4000)
          .filter(function (f) { const r = String(f.ref); return (r === t || r.indexOf(t + '#') === 0) && (!cid || !f.classId || f.classId === cid); });
        return out_({ activity: act, feedback: fb });
      }
      // No &topic=: the whole-class "My Class (live)" view -- filtered to her Subject column,
      // so it covers every topic she's ever taught, past and future, without a fixed list.
      const act = rows_('Activity', ['ts', 'name', 'cls', 'event', 'course', 'chapter', 'score', 'total', 'sid', 'g', 'sub', 'ans', 'classId'], 0)
        .filter(function (r) { return r.sub === st.subjectName; });
      const fb = rows_('Feedback', ['ts', 'name', 'cls', 'type', 'reason', 'message', 'page', 'ref', 'sid', 'g', 'sub', 'classId'], 0)
        .filter(function (f) { return f.sub === st.subjectName; });
      return out_({ activity: act, feedback: fb });
    }
    // archive, and the shared class-size ("groups" alone) setting, stay with you -- blocked.
    return out_({ error: 'not allowed for this PIN' });
  }

  // Full teacher PIN: unchanged, full access.
  if (a === 'keys') return out_({ ok: true, keys: KEYS, open: openTopics_() });
  if (a === 'unlock' || a === 'lock') {
    const t = String(p.topic || '');
    if (!KEYS[t]) return out_({ error: 'unknown lesson' });
    let list = openTopics_().filter(function (x) { return x !== t; });
    if (a === 'unlock') list.push(t);
    setOpenTopics_(list);
    if (p.g) PropertiesService.getScriptProperties().setProperty('GROUPS', String(Math.max(2, Math.min(9, Number(p.g) || 6))));
    return out_({ ok: true, open: list });
  }
  // Teacher's randomiser: "Number 3s, present!" shown on students' screens.
  if (a === 'call') {
    const c = { topic: String(p.topic || '').slice(0, 60), num: Number(p.num) || 0, g: String(p.g || '').slice(0, 30), ts: Date.now() };
    PropertiesService.getScriptProperties().setProperty('CALL', JSON.stringify(c));
    return out_({ ok: true, call: c });
  }
  if (a === 'groups') { PropertiesService.getScriptProperties().setProperty('GROUPS', String(Math.max(2, Math.min(9, Number(p.g) || 6)))); return out_({ ok: true, groups: groups_() }); }
  if (a === 'lockall') { setOpenTopics_([]); return out_({ ok: true, open: [] }); }
  // Send the weekly performance digest right now instead of waiting for the
  // time-driven trigger -- useful to test it once after setting TEACHER_EMAIL,
  // or any time you want an up-to-the-minute summary.
  if (a === 'senddigest') { return out_({ ok: true, sentTo: sendWeeklyPerformanceReport() }); }
  // Same idea, but one email PER STUDENT sent to their parent, built from
  // that student's own Computer Science mastery model -- see "Weekly parent
  // update" below. Useful to test right after filling in "Parent Contacts".
  if (a === 'sendparentdigest') { return out_({ ok: true, sentTo: sendWeeklyParentReports() }); }
  if (a === 'summary') {
    // With &topic=… only that lesson's rows (from the most recent 4000) are sent, so live results stay fast all year.
    const t = String(p.topic || '');
    const cid = String(p.classId || '');
    const act = rows_('Activity', ['ts', 'name', 'cls', 'event', 'course', 'chapter', 'score', 'total', 'sid', 'g', 'sub', 'ans', 'classId'], t ? 4000 : 0);
    const fb = rows_('Feedback', ['ts', 'name', 'cls', 'type', 'reason', 'message', 'page', 'ref', 'sid', 'g', 'sub', 'classId'], t ? 4000 : 0);
    if (!t) return out_({ activity: act, feedback: fb });
    return out_({
      activity: act.filter(function (r) { return String(r.chapter) === t && (!cid || !r.classId || r.classId === cid); }),
      feedback: fb.filter(function (f) { const r = String(f.ref); return (r === t || r.indexOf(t + '#') === 0) && (!cid || !f.classId || f.classId === cid); })
    });
  }
  // Teacher-only: moves rows older than &before=YYYY-MM-DD out of the live Activity/Feedback
  // sheets into matching "Archive - …" sheets in this same spreadsheet. Nothing is ever deleted —
  // it's moved, so old results stay available (open or download the Archive sheets any time) but
  // stop slowing down "My Class (live)" and stop mixing into every CSV download. Leave &before= off
  // to archive everything older than 12 months.
  if (a === 'archive') {
    if (p.confirm !== 'yes') return out_({ error: 'confirm' });
    return out_({ ok: true, moved: archiveOldRows_(p.before || '') });
  }
  return out_({ error: 'unknown action' });
}

function archiveOldRows_(beforeIso) {
  const cutoff = beforeIso ? new Date(beforeIso + 'T00:00:00') : new Date(Date.now() - 365 * 864e5);
  if (isNaN(cutoff)) return 0;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const bases = ['Activity', 'Feedback'];
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  let moved = 0;
  try {
    ss.getSheets().forEach(function (sh) {
      const name = sh.getName();
      if (name.indexOf('Archive - ') === 0) return; // never archive an archive
      if (!bases.some(function (b) { return name === b || name.indexOf(b + ' - ') === 0; })) return;
      const last = sh.getLastRow(), cols = sh.getLastColumn();
      if (last < 2) return;
      const vals = sh.getRange(2, 1, last - 1, cols).getValues();
      const keep = [], move = [];
      vals.forEach(function (r) {
        const t = r[0] instanceof Date ? r[0] : new Date(r[0]);
        (!isNaN(t) && t < cutoff ? move : keep).push(r);
      });
      if (!move.length) return;
      const headers = sh.getRange(1, 1, 1, cols).getValues()[0];
      const ar = sheet_('Archive - ' + name, headers);
      ar.getRange(ar.getLastRow() + 1, 1, move.length, cols).setValues(move);
      sh.getRange(2, 1, last - 1, cols).clearContent();
      if (keep.length) sh.getRange(2, 1, keep.length, cols).setValues(keep);
      moved += move.length;
    });
  } finally {
    lock.releaseLock();
  }
  return moved;
}

// Reads and merges every sheet for this base name (the unsplit sheet, if any still exists from
// before subjects were split out, plus every "Base - Subject" sheet), sorted back into time order.
function rows_(base, keys, lastN) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets().filter(function (sh) {
    const n = sh.getName();
    return n === base || n.indexOf(base + ' - ') === 0;
  });
  let out = [];
  sheets.forEach(function (sh) {
    if (sh.getLastRow() < 2) return;
    const cols = Math.min(keys.length, sh.getLastColumn());
    const last = sh.getLastRow(), first = lastN ? Math.max(2, last - lastN + 1) : 2;
    sh.getRange(first, 1, last - first + 1, cols).getValues().forEach(function (r) {
      const o = {};
      keys.forEach(function (k, i) { o[k] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
      out.push(o);
    });
  });
  out.sort(function (a, b) { return String(a.ts || '').localeCompare(String(b.ts || '')); });
  return lastN ? out.slice(-lastN) : out;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================
// Weekly performance digest -- an "agent" in the dissertation sense: it
// reads the same Activity log the live dashboard reads, runs a small
// rule-based model over it (per-student and per-chapter averages against
// a fixed "understood" threshold, the same 60% bar "My Class (live)"
// already uses), decides who's doing well, who needs support, and which
// topics to re-teach, and acts on that by emailing the teacher -- without
// her having to open the dashboard at all.
//
// One-time setup (after filling in TEACHER_EMAIL and/or a SUBJECT_TEACHERS
// email above, then Deploy -> New version):
//   1. In the Apps Script editor: Triggers (clock icon, left sidebar).
//   2. + Add Trigger -> Function: sendWeeklyPerformanceReport
//      -> Event source: Time-driven -> Week timer -> pick a day + hour.
//   3. Save, and approve the Gmail/MailApp permission the first time it asks.
// To test it immediately instead of waiting for the trigger: run
// sendWeeklyPerformanceReport from the Apps Script editor's function
// picker, or call ?action=senddigest&pin=<TEACHER_PIN> once (see doGet).
//
// Quota note: MailApp gives a personal Google account ~100 emails/day
// (Workspace accounts get more) -- a once-a-week digest to one or two
// teachers is nowhere near that, so this never needs watching.
// =====================================================================

function prettyChapter_(id) {
  const base = String(id || '').split('@')[0].split('#')[0];
  const rest = base.replace(/^[a-z]+\d*-/, '');
  return (rest || base).replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function keyOfRow_(r) {
  return r.sid || ((r.name || '') + '|' + (r.cls || ''));
}

// Builds one subject's (or, with subjectName='', every subject's) digest
// from the Activity log: top performers, students who need support, weak
// chapters with a suggested next step, and students who've gone quiet.
function buildDigest_(subjectName) {
  const now = Date.now();
  const sinceMs = now - DIGEST_WINDOW_DAYS * 864e5;
  const all = rows_('Activity', ['ts', 'name', 'cls', 'event', 'course', 'chapter', 'score', 'total', 'sid', 'g', 'sub', 'ans', 'classId'], 0)
    .filter(function (r) { return !subjectName || r.sub === subjectName; });
  const windowRows = all.filter(function (r) { return new Date(r.ts).getTime() >= sinceMs; });

  // per-student: quiz scores this week, plus last-seen across ALL activity
  // (not just the window) so "gone quiet" means genuinely inactive, not
  // just a student who happened not to take a quiz this week.
  const studs = {};
  const touch = function (r) {
    const k = keyOfRow_(r);
    let s = studs[k];
    if (!s) s = studs[k] = { k: k, name: r.name, cls: r.cls, sub: r.sub, last: r.ts, quiz: [] };
    if (r.ts > s.last) s.last = r.ts;
    return s;
  };
  all.forEach(touch);
  windowRows.forEach(function (r) {
    if (r.event !== 'quiz') return;
    const s = touch(r);
    s.quiz.push({ chapter: r.chapter, v: (+r.score) / (+r.total || 1) });
  });
  const avg = function (s) { return s.quiz.length ? s.quiz.reduce(function (n, q) { return n + q.v; }, 0) / s.quiz.length : null; };
  const weakest = function (s) {
    if (!s.quiz.length) return null;
    return s.quiz.slice().sort(function (a, b) { return a.v - b.v; })[0];
  };

  const withQuizzes = Object.values(studs).filter(function (s) { return s.quiz.length >= DIGEST_MIN_QUIZZES; });
  const top = withQuizzes.filter(function (s) { return avg(s) >= DIGEST_HIGH; })
    .sort(function (a, b) { return avg(b) - avg(a); }).slice(0, DIGEST_TOP_N)
    .map(function (s) { return { name: s.name, cls: s.cls, pct: Math.round(avg(s) * 100) }; });
  const needHelp = withQuizzes.filter(function (s) { return avg(s) < DIGEST_OK; })
    .sort(function (a, b) { return avg(a) - avg(b); }).slice(0, DIGEST_TOP_N)
    .map(function (s) { const w = weakest(s); return { name: s.name, cls: s.cls, pct: Math.round(avg(s) * 100), weakChapter: w ? prettyChapter_(w.chapter) : null }; });
  const quiet = Object.values(studs).filter(function (s) { return now - new Date(s.last).getTime() >= DIGEST_WINDOW_DAYS * 864e5; })
    .sort(function (a, b) { return new Date(a.last) - new Date(b.last); }).slice(0, DIGEST_TOP_N)
    .map(function (s) { return { name: s.name, cls: s.cls, lastSeen: s.last }; });

  // per-chapter: this week's quiz average, to flag what to re-teach --
  // same two-tier suggestion text the in-app Teacher Action Centre uses.
  const chapters = {};
  windowRows.forEach(function (r) {
    if (r.event !== 'quiz') return;
    const c = chapters[r.chapter] || (chapters[r.chapter] = { vals: [] });
    c.vals.push((+r.score) / (+r.total || 1));
  });
  const weak = Object.keys(chapters).map(function (id) {
    const vals = chapters[id].vals;
    const pct = Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length * 100);
    return { id: id, label: prettyChapter_(id), n: vals.length, pct: pct };
  }).filter(function (c) { return c.n >= DIGEST_MIN_QUIZZES && c.pct < DIGEST_OK * 100; })
    .sort(function (a, b) { return a.pct - b.pct; }).slice(0, DIGEST_TOP_N)
    .map(function (c) {
      c.action = c.pct < 40
        ? 'Re-teach this topic from the start, then use the chapter’s tip cards and a short pair activity.'
        : 'Quick recap at the start of the next lesson, then 2–3 solved questions in pairs.';
      return c;
    });

  return {
    subjectName: subjectName || '',
    windowDays: DIGEST_WINDOW_DAYS,
    quizzesThisWeek: windowRows.filter(function (r) { return r.event === 'quiz'; }).length,
    activeThisWeek: Object.keys(studs).filter(function (k) { return windowRows.some(function (r) { return keyOfRow_(r) === k; }); }).length,
    top: top, needHelp: needHelp, weak: weak, quiet: quiet,
    // Only meaningful for the Computer Science subject (see BKT_SUBJECT) --
    // the full, every-subject digest (subjectName === '') still gets it,
    // but another subject teacher's own digest won't.
    ready: (subjectName === '' || subjectName === BKT_SUBJECT) ? readyForChallenge_() : []
  };
}

// =====================================================================
// Adaptive mastery model (Bayesian Knowledge Tracing) -- the model behind
// both the teacher digest's "Ready for a challenge" section above and the
// weekly parent update below. One BKT instance per (student, chapter):
// a probability of mastery that starts at BKT_P_INIT and updates after
// every attempt, across the student's WHOLE history (not just this
// week), using two standard BKT steps:
//   1. a Bayesian correction for each question answered this attempt,
//      given that even a student who knows the material can slip
//      (BKT_P_SLIP) and one who doesn't can guess right (BKT_P_GUESS);
//   2. one "chance to learn from the result" (BKT_P_TRANSIT), applied
//      once per attempt rather than once per question -- there's no time
//      to actually learn something new between questions in the same quiz.
//
// "Every attempt" means every chapter QUIZ *and* every individual
// practice-bank "Try it yourself" code question ('code' events, logged
// one per question, score 0 or 1 out of 1) -- not quiz attempts alone.
// A real class logs far more of the latter: a first run of this model
// against one teacher's real export found only ~26 full quiz attempts in
// the whole Computer Science log but hundreds of individual 'code'
// attempts, nowhere near enough of the former alone to fit or trust a
// per-chapter model. 'code' attempts are graded the same way quizzes
// are -- auto-marked right/wrong, no human judgement -- so they're a
// valid BKT observation, just a smaller, more frequent one (total=1
// instead of total=10). Other logged event types ('self', 'gmark',
// 'hdyd', 'peer', 'sc', 'exit', 'rate', 'paper') are deliberately left
// out: those are self- or peer-rated on a 0-3 scale, or a whole mock
// paper's combined score, not the clean per-question right/wrong signal
// BKT is built on.
// =====================================================================

function bktStep_(p, correct) {
  const num = correct ? p * (1 - BKT_P_SLIP) : p * BKT_P_SLIP;
  const den = correct ? (num + (1 - p) * BKT_P_GUESS) : (num + (1 - p) * (1 - BKT_P_GUESS));
  return den > 0 ? num / den : p;
}

// One attempt's worth of BKT update -- a chapter quiz (several questions
// at once, total > 1) or a single practice-bank code question (total=1).
// Works identically either way: a Bayesian correction per question
// answered this attempt, then one "chance to learn" applied once for the
// whole attempt (not once per question -- there's no time to learn
// something new mid-quiz, or between one code question and the next
// click of "Check").
function bktUpdateAttempt_(p, score, total) {
  const t = Math.max(1, Math.round(+total) || 1);
  const correct = Math.max(0, Math.min(t, Math.round(+score) || 0));
  for (let i = 0; i < correct; i++) p = bktStep_(p, true);
  for (let i = 0; i < (t - correct); i++) p = bktStep_(p, false);
  p = p + (1 - p) * BKT_P_TRANSIT;
  return Math.min(0.995, Math.max(0.005, p));
}

function masteryTier_(p) {
  if (p >= BKT_STRONG) return 'Strong';
  if (p >= BKT_NEEDS_PRACTICE) return 'Developing';
  return 'Needs practice';
}

// Runs BKT over every Computer Science quiz AND practice-code row (rows_
// already returns them time-sorted, which BKT depends on), grouped by
// student x chapter.
function bktMastery_() {
  const rows = rows_('Activity', ['ts', 'name', 'cls', 'event', 'course', 'chapter', 'score', 'total', 'sid', 'g', 'sub', 'ans', 'classId'], 0)
    .filter(function (r) { return (r.event === 'quiz' || r.event === 'code') && r.sub === BKT_SUBJECT; });
  const byStudent = {};
  rows.forEach(function (r) {
    const k = keyOfRow_(r);
    const s = byStudent[k] || (byStudent[k] = { sid: r.sid, name: r.name, cls: r.cls, chapters: {} });
    const c = s.chapters[r.chapter] || (s.chapters[r.chapter] = { p: BKT_P_INIT, n: 0 });
    c.p = bktUpdateAttempt_(c.p, r.score, r.total);
    c.n++;
  });
  return byStudent;
}

// Students the model now rates "Strong" on at least one chapter -- the
// trigger for DigiClass to start offering that chapter's harder
// Challenge-level questions (see the Study Sprint's 20-minute "Challenge"
// round in src/app.js, which already exists and already carries real
// board-pattern harder questions -- this just decides WHEN to surface it).
function readyForChallenge_() {
  const byStudent = bktMastery_();
  const out = [];
  Object.values(byStudent).forEach(function (s) {
    Object.keys(s.chapters).forEach(function (id) {
      const c = s.chapters[id];
      if (c.n >= BKT_MIN_ATTEMPTS && c.p >= BKT_STRONG) out.push({ name: s.name, cls: s.cls, chapter: prettyChapter_(id), pct: Math.round(c.p * 100) });
    });
  });
  return out.sort(function (a, b) { return b.pct - a.pct; }).slice(0, DIGEST_TOP_N);
}

function digestSection_(title, rows, renderRow, emptyMsg) {
  if (!rows.length) return '<p style="color:#667;margin:4px 0 16px">' + emptyMsg + '</p>';
  return '<h3 style="margin:18px 0 6px">' + title + '</h3><ul style="margin:0 0 16px;padding-left:20px">' + rows.map(renderRow).join('') + '</ul>';
}

function digestHtml_(label, d) {
  const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); };
  const header = '<h2 style="margin:0 0 4px">DigiClass weekly digest' + (label ? ' · ' + esc(label) : '') + '</h2>'
    + '<p style="color:#667;margin:0 0 18px">Last ' + d.windowDays + ' days · ' + d.quizzesThisWeek + ' quiz attempt' + (d.quizzesThisWeek === 1 ? '' : 's') + ' from ' + d.activeThisWeek + ' active student' + (d.activeThisWeek === 1 ? '' : 's') + '.</p>';
  const topHtml = digestSection_('Top performers', d.top,
    function (s) { return '<li><b>' + esc(s.name) + '</b> (Grade ' + esc(s.cls) + ') — averaging ' + s.pct + '%</li>'; },
    'No student averaged 85%+ this week yet.');
  const helpHtml = digestSection_('⚠️ Students who need support', d.needHelp,
    function (s) { return '<li><b>' + esc(s.name) + '</b> (Grade ' + esc(s.cls) + ') — averaging ' + s.pct + '%' + (s.weakChapter ? ', weakest on <i>' + esc(s.weakChapter) + '</i>' : '') + '</li>'; },
    '✅ No student is averaging below 60% this week.');
  const weakHtml = digestSection_('Topics to re-teach', d.weak,
    function (c) { return '<li><b>' + esc(c.label) + '</b> — ' + c.pct + '% understood (' + c.n + ' attempt' + (c.n === 1 ? '' : 's') + ')<br><small style="color:#667">' + esc(c.action) + '</small></li>'; },
    '✅ No topic is below 60% understood this week.');
  // "Ready" is from the mastery model (whole history, not just this week), so
  // it's only shown when there's something to say -- no "nobody's ready yet"
  // noise on a normal week.
  const readyHtml = (d.ready && d.ready.length) ? digestSection_('Ready for a challenge', d.ready,
    function (r) { return '<li><b>' + esc(r.name) + '</b> (Grade ' + esc(r.cls) + ') — mastered <i>' + esc(r.chapter) + '</i> (' + r.pct + '% estimated) · DigiClass will start offering harder Challenge-level questions on this topic.</li>'; },
    '') : '';
  const quietHtml = digestSection_('Gone quiet (' + d.windowDays + '+ days inactive)', d.quiet,
    function (s) { return '<li>' + esc(s.name) + ' (Grade ' + esc(s.cls) + ')</li>'; },
    'Everyone’s been active in the last ' + d.windowDays + ' days.');
  const footer = '<p style="color:#99a;font-size:12px;margin-top:20px">Sent automatically by DigiClass. Open “My Class (live)” in DigiClass Teach for the full picture, filters, and comments.</p>';
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">' + header + topHtml + readyHtml + helpHtml + weakHtml + quietHtml + footer + '</div>';
}

// The trigger's entry point -- wire this up under Triggers (see the setup
// note above). Sends one digest to TEACHER_EMAIL covering every subject,
// plus one more (filtered to just her subject) to each SUBJECT_TEACHERS
// entry that has its own "email" set.
function sendWeeklyPerformanceReport() {
  const sent = [];
  if (TEACHER_EMAIL) {
    const d = buildDigest_('');
    MailApp.sendEmail({ to: TEACHER_EMAIL, subject: 'DigiClass weekly digest', htmlBody: digestHtml_('', d) });
    sent.push(TEACHER_EMAIL);
  }
  SUBJECT_TEACHERS.forEach(function (st) {
    if (!st.email) return;
    const d = buildDigest_(st.subjectName);
    MailApp.sendEmail({ to: st.email, subject: 'DigiClass weekly digest · ' + st.subjectName, htmlBody: digestHtml_(st.subjectName, d) });
    sent.push(st.email);
  });
  return sent;
}

// =====================================================================
// Weekly parent update -- one email PER STUDENT, sent to that student's
// parent, built from the same mastery model (see "Adaptive mastery model"
// above): what the model currently estimates they understand well, what
// needs more practice, and which one topic to focus on this week.
//
// DigiClass has no parent sign-up flow, so there's one extra manual step:
// a small "Parent Contacts" sheet (created automatically the first time
// this runs) mapping each Student ID to a parent email address.
//
// One-time setup:
//   1. Open the "Students" sheet and note each student's Student ID.
//   2. Open (or let this create) the "Parent Contacts" sheet and fill in
//      one row per student: Student ID | Student Name | Parent Email.
//   3. In the Apps Script editor: Triggers -> + Add Trigger -> Function:
//      sendWeeklyParentReports -> Time-driven -> Week timer -> day + hour.
//   4. Save, and approve the Gmail/MailApp permission if it asks again.
// To test it immediately: run sendWeeklyParentReports from the Apps
// Script editor's function picker, or call
// ?action=sendparentdigest&pin=<TEACHER_PIN> once (see doGet).
//
// A student with fewer than BKT_MIN_ATTEMPTS Computer Science quiz
// attempts on every chapter, or with no "Parent Contacts" row at all,
// is skipped that week rather than sent an empty/unreliable email.
// =====================================================================

const PARENT_HEADERS = ['Student ID', 'Student Name', 'Parent Email'];

function parentRows_() {
  const sh = sheet_('Parent Contacts', PARENT_HEADERS);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, PARENT_HEADERS.length).getValues()
    .map(function (r) { return { sid: String(r[0] || '').trim(), name: String(r[1] || '').trim(), email: String(r[2] || '').trim() }; })
    .filter(function (r) { return r.sid && r.email; });
}

function parentDigestHtml_(studentName, chapters) {
  const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); };
  const rows = chapters.map(function (c) {
    return '<li><b>' + esc(c.label) + '</b> — ' + c.tier + ' (' + c.pct + '% estimated mastery, ' + c.n + ' attempt' + (c.n === 1 ? '' : 's') + ')</li>';
  }).join('');
  const weakest = chapters[0]; // sorted ascending by mastery
  const strongest = chapters[chapters.length - 1];
  const focus = (weakest && weakest.tier !== 'Strong')
    ? '<p><b>This week, it would help most to focus on:</b> ' + esc(weakest.label) + '.</p>' : '';
  const challenge = (strongest && strongest.tier === 'Strong')
    ? '<p>' + esc(studentName) + ' has mastered <b>' + esc(strongest.label) + '</b> — DigiClass will start offering ' + esc(studentName) + ' harder Challenge-level questions on this topic.</p>' : '';
  const header = '<h2 style="margin:0 0 4px">' + esc(studentName) + '’s Computer Science update</h2>'
    + '<p style="color:#667;margin:0 0 18px">Estimated topic-by-topic understanding from DigiClass’s learning model, which updates as ' + esc(studentName) + ' answers more quiz questions.</p>';
  const list = '<ul style="margin:0 0 16px;padding-left:20px">' + rows + '</ul>';
  const footer = '<p style="color:#99a;font-size:12px;margin-top:20px">These are estimates from practice-quiz answers, not exam grades, and improve with more practice. Sent automatically, weekly, by DigiClass.</p>';
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">' + header + list + focus + challenge + footer + '</div>';
}

function sendWeeklyParentReports() {
  const byStudent = bktMastery_();
  const sent = [];
  parentRows_().forEach(function (pc) {
    const s = byStudent[pc.sid];
    if (!s) return; // no Computer Science quiz activity logged for this student yet
    const chapters = Object.keys(s.chapters).map(function (id) {
      const c = s.chapters[id];
      return { id: id, label: prettyChapter_(id), pct: Math.round(c.p * 100), tier: masteryTier_(c.p), n: c.n };
    }).filter(function (c) { return c.n >= BKT_MIN_ATTEMPTS; }).sort(function (a, b) { return a.pct - b.pct; });
    if (!chapters.length) return;
    const studentName = pc.name || s.name || 'Your child';
    const html = parentDigestHtml_(studentName, chapters);
    MailApp.sendEmail({ to: pc.email, subject: studentName + '’s weekly Computer Science update · DigiClass', htmlBody: html });
    sent.push(pc.email);
  });
  return sent;
}
