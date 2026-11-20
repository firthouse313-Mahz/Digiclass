// =====================================================================
// DigiClass – class sheet script (with DigiClass Teach lesson keys)
// Paste ALL of this into: Google Sheet → Extensions → Apps Script
// Then: Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy
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
    top: top, needHelp: needHelp, weak: weak, quiet: quiet
  };
}

function digestSection_(title, rows, renderRow, emptyMsg) {
  if (!rows.length) return '<p style="color:#667;margin:4px 0 16px">' + emptyMsg + '</p>';
  return '<h3 style="margin:18px 0 6px">' + title + '</h3><ul style="margin:0 0 16px;padding-left:20px">' + rows.map(renderRow).join('') + '</ul>';
}

function digestHtml_(label, d) {
  const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); };
  const header = '<h2 style="margin:0 0 4px">📊 DigiClass weekly digest' + (label ? ' · ' + esc(label) : '') + '</h2>'
    + '<p style="color:#667;margin:0 0 18px">Last ' + d.windowDays + ' days · ' + d.quizzesThisWeek + ' quiz attempt' + (d.quizzesThisWeek === 1 ? '' : 's') + ' from ' + d.activeThisWeek + ' active student' + (d.activeThisWeek === 1 ? '' : 's') + '.</p>';
  const topHtml = digestSection_('🏆 Top performers', d.top,
    function (s) { return '<li><b>' + esc(s.name) + '</b> (Grade ' + esc(s.cls) + ') — averaging ' + s.pct + '%</li>'; },
    'No student averaged 85%+ this week yet.');
  const helpHtml = digestSection_('⚠️ Students who need support', d.needHelp,
    function (s) { return '<li><b>' + esc(s.name) + '</b> (Grade ' + esc(s.cls) + ') — averaging ' + s.pct + '%' + (s.weakChapter ? ', weakest on <i>' + esc(s.weakChapter) + '</i>' : '') + '</li>'; },
    '✅ No student is averaging below 60% this week.');
  const weakHtml = digestSection_('📌 Topics to re-teach', d.weak,
    function (c) { return '<li><b>' + esc(c.label) + '</b> — ' + c.pct + '% understood (' + c.n + ' attempt' + (c.n === 1 ? '' : 's') + ')<br><small style="color:#667">' + esc(c.action) + '</small></li>'; },
    '✅ No topic is below 60% understood this week.');
  const quietHtml = digestSection_('😴 Gone quiet (' + d.windowDays + '+ days inactive)', d.quiet,
    function (s) { return '<li>' + esc(s.name) + ' (Grade ' + esc(s.cls) + ')</li>'; },
    'Everyone’s been active in the last ' + d.windowDays + ' days.');
  const footer = '<p style="color:#99a;font-size:12px;margin-top:20px">Sent automatically by DigiClass. Open “My Class (live)” in DigiClass Teach for the full picture, filters, and comments.</p>';
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">' + header + topHtml + helpHtml + weakHtml + quietHtml + footer + '</div>';
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
