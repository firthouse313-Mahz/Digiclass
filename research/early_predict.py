#!/usr/bin/env python3
"""
early_predict.py -- can a student's FIRST FEW attempts on a chapter
predict whether they will end up needing practice on it, before the live
BKT model (sheet-script-template.gs) has seen enough attempts to say so
itself? For the dissertation's "early prediction" contribution, companion
to `bkt_eval.py`'s "adaptive feedback" contribution.

This is a standalone script: it does NOT talk to Google Sheets or Apps
Script, and has no third-party dependencies (consistent with
bkt_eval.py) -- csv, math and random from the standard library only.

WHY THIS, AND NOT MORE LOGGING
-------------------------------
The live Activity log already records exactly what an early-prediction
model needs: one timestamped row per quiz/code attempt, per student, per
chapter, with a score and total. No new instrumentation is needed to
answer this question -- the question is purely about what you do with
data DigiClass already collects.

THE PREDICTION TASK
--------------------
Unit of prediction: one (student, chapter) pair.
  Features : derived from only the first EARLY_K "opportunities" (one
             opportunity = one question: a `code` attempt is 1
             opportunity, a `total`-question `quiz` attempt is `total`
             opportunities, each 0/1 correct/incorrect -- same
             flattening bkt_eval.py's load_csv_sequences() already does,
             reused here directly).
  Label    : whether the model's own mastery estimate, run forward over
             the student's WHOLE chapter history (every opportunity,
             not just the first EARLY_K), ends below BKT_NEEDS_PRACTICE
             -- i.e. "this chapter, in the end, needed practice". Uses
             the same BKT_P_* constants and update rule as
             sheet-script-template.gs's bktStep_/bktUpdateAttempt_ (see
             final_mastery() below), so the label is literally "what the
             live model eventually decides", not a separately-invented
             target.
  Only sequences with at least MIN_TOTAL opportunities are used, so the
  "eventual" label is itself based on enough evidence to trust -- a
  4-opportunity sequence has no real "later" to predict.

Why first 3 opportunities specifically: BKT_MIN_ATTEMPTS in the live
script is 2 *attempts*, which on a real class (mostly single-question
'code' attempts, per README.md's own finding) is often only 2
opportunities -- barely enough for BKT's own guess/slip correction to
settle. 3 is the smallest window that is clearly still "early" (a
handful of practice questions, well before a chapter is finished) while
giving the classifier slightly more than BKT's own minimum to work
with. This is a judgement call, not a fact -- EARLY_K is a constant
below, and the dissertation should report sensitivity to it (e.g. also
trying 2 and 5) rather than present 3 as uniquely correct.

USAGE
-----
  python3 early_predict.py                  # self-test on a synthetic
                                              # dataset with a known,
                                              # genuine early->eventual
                                              # relationship
  python3 early_predict.py activity.csv      # real "Activity - Computer
                                              # Science" export (same CSV
                                              # bkt_eval.py expects)

MODEL
-----
Logistic regression, fit by gradient descent from scratch (no numpy/
sklearn, matching bkt_eval.py's own from-scratch EM) on a small, fixed
feature set chosen to stay explainable in a methodology chapter:
  1. acc_early       -- accuracy over the first EARLY_K opportunities
  2. first_correct   -- was opportunity 1 correct (0/1)
  3. trend           -- (2nd half of early window mean) - (1st half mean)
  4. bkt_early_p      -- the live model's OWN forward mastery estimate
                         after just EARLY_K opportunities (BKT_P_* run
                         forward only that far)
Feature 4 matters most to the dissertation's framing: it lets the
evaluation show whether a trained classifier beats simply reading BKT's
own early-window estimate and thresholding it (one of the two baselines
below) -- if it doesn't, the honest conclusion is that BKT already is
the early predictor and a separate model adds nothing, which is itself
a publishable finding.

EVALUATION
----------
Stratified k-fold cross-validation (small-N safe; a real single-class
deployment will have far too few (student, chapter) rows for a held-out
test split to be meaningful on its own). Reports, averaged over folds:
  - accuracy, precision/recall/F1 on the minority "needs practice" class
  - against two baselines run through the SAME folds:
      majority  : always predict the more common label
      bkt_early : threshold bkt_early_p < BKT_NEEDS_PRACTICE, no fitting
                  at all -- "just trust the live model's early reading"
"""

import csv
import math
import random
import sys
from collections import defaultdict

# Same defaults as BKT_P_* in sheet-script-template.gs -- see that file's
# "Adaptive mastery model" comment block for what each one means. Kept as
# plain module-level constants (not imported) since this script has no
# dependency on the .gs file and must stand alone; if you refit these via
# bkt_eval.py, update both places together.
BKT_P_INIT = 0.3
BKT_P_TRANSIT = 0.15
BKT_P_GUESS = 0.25
BKT_P_SLIP = 0.1
BKT_NEEDS_PRACTICE = 0.4

EARLY_K = 3        # size of the "early" feature window, in opportunities
MIN_TOTAL = 8       # a sequence needs at least this many opportunities
                    # in total before its "eventual" label is trusted


# ----------------------------------------------------------------------
# BKT forward update -- one opportunity at a time, same recursion
# bkt_eval.py's predict_sequence() uses, but exposed here as a function
# that can be stopped after K steps (for the early feature) or run to
# the end (for the label).
# ----------------------------------------------------------------------

def bkt_forward(seq, p_init=BKT_P_INIT, p_transit=BKT_P_TRANSIT,
                 p_guess=BKT_P_GUESS, p_slip=BKT_P_SLIP, upto=None):
    """Runs the BKT forward recursion over seq[:upto] (or all of seq) and
    returns the final mastery probability p."""
    p = p_init
    n = len(seq) if upto is None else min(upto, len(seq))
    for o in seq[:n]:
        pred = p * (1 - p_slip) + (1 - p) * p_guess
        if o == 1:
            num, den = p * (1 - p_slip), pred
        else:
            num, den = p * p_slip, 1 - pred
        p = (num / den) if den > 0 else p
        p = p + (1 - p) * p_transit
    return p


def final_mastery(seq):
    """The label: BKT's own estimate after the WHOLE sequence."""
    return bkt_forward(seq, upto=None)


# ----------------------------------------------------------------------
# Feature engineering from only the first EARLY_K opportunities.
# ----------------------------------------------------------------------

def early_features(seq, k=EARLY_K):
    early = seq[:k]
    acc = sum(early) / len(early)
    first_correct = float(early[0])
    half = max(1, k // 2)
    first_half = sum(early[:half]) / half
    second_half = sum(early[half:]) / max(1, len(early) - half)
    trend = second_half - first_half
    bkt_early_p = bkt_forward(seq, upto=k)
    return [acc, first_correct, trend, bkt_early_p]


FEATURE_NAMES = ["acc_early", "first_correct", "trend", "bkt_early_p"]


# ----------------------------------------------------------------------
# Logistic regression, from scratch (gradient descent), to match
# bkt_eval.py's "no third-party ML libraries" style.
# ----------------------------------------------------------------------

def _standardize(X, mean=None, std=None):
    n, d = len(X), len(X[0])
    if mean is None:
        mean = [sum(row[j] for row in X) / n for j in range(d)]
        std = []
        for j in range(d):
            var = sum((row[j] - mean[j]) ** 2 for row in X) / n
            std.append(math.sqrt(var) or 1.0)
    Xs = [[(row[j] - mean[j]) / std[j] for j in range(d)] for row in X]
    return Xs, mean, std


def _sigmoid(z):
    if z < -60:
        return 0.0
    if z > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def fit_logreg(X, y, lr=0.2, iters=2000, l2=0.01, class_weight="balanced"):
    """Gradient descent, with optional per-class sample weighting. Without
    it, a classifier trained on an imbalanced label (the common case
    here -- most chapters don't end up 'needs practice') simply learns to
    always predict the majority class: that minimizes average loss just
    as well as any real decision boundary, while being a completely
    useless early-warning system (it would never flag an at-risk
    student). class_weight="balanced" reweights each class's contribution
    to the gradient by n / (2 * count_of_that_class), the standard fix
    (same idea as sklearn's class_weight='balanced'), so the minority
    ("needs practice") class isn't drowned out just because it's rarer."""
    n, d = len(X), len(X[0])
    w = [0.0] * d
    b = 0.0
    if class_weight == "balanced":
        n_pos = sum(y) or 1
        n_neg = (n - n_pos) or 1
        wpos, wneg = n / (2.0 * n_pos), n / (2.0 * n_neg)
        sw = [wpos if yi == 1 else wneg for yi in y]
    else:
        sw = [1.0] * n
    sw_sum = sum(sw) or 1.0
    for _ in range(iters):
        gw = [0.0] * d
        gb = 0.0
        for xi, yi, wi in zip(X, y, sw):
            z = sum(w[j] * xi[j] for j in range(d)) + b
            p = _sigmoid(z)
            err = wi * (p - yi)
            for j in range(d):
                gw[j] += err * xi[j]
            gb += err
        for j in range(d):
            w[j] -= lr * (gw[j] / sw_sum + l2 * w[j])
        b -= lr * (gb / sw_sum)
    return w, b


def predict_logreg(w, b, x):
    z = sum(wj * xj for wj, xj in zip(w, x)) + b
    return _sigmoid(z)


# ----------------------------------------------------------------------
# Data loading.
# ----------------------------------------------------------------------

def load_csv_sequences(path):
    """Same loader as bkt_eval.py -- duplicated rather than imported so
    this script stays runnable on its own (e.g. copied out of the repo
    for a dissertation appendix) without needing bkt_eval.py alongside
    it. Keep both copies in sync if the CSV format ever changes."""
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            if (r.get("Event") or "").strip().lower() not in ("quiz", "code"):
                continue
            try:
                score = float(r.get("Score") or 0)
                total = max(1, int(float(r.get("Total") or 1)))
            except ValueError:
                continue
            sid = (r.get("Student ID") or "").strip() or ((r.get("Name") or "") + "|" + (r.get("Class") or ""))
            chapter = (r.get("Chapter") or "").strip()
            ts = (r.get("Time") or "").strip()
            rows.append((ts, sid, chapter, score, total))
    rows.sort(key=lambda r: r[0])

    by_key = defaultdict(list)
    for ts, sid, chapter, score, total in rows:
        correct = max(0, min(total, round(score)))
        wrong = total - correct
        by_key[(sid, chapter)].extend([1] * correct + [0] * wrong)
    return by_key


def synthetic_dataset(seed=0, n_students=300):
    """Generates sequences with a GENUINE (but noisy) early->eventual
    relationship: each simulated student has a hidden 'learning speed'
    that shapes both their early accuracy and their eventual mastery, so
    a real signal exists for the classifier to find -- while still being
    noisy enough (slip/guess) that perfect prediction is impossible, same
    spirit as bkt_eval.py's synthetic_dataset() self-test."""
    rnd = random.Random(seed)
    by_key = {}
    for s in range(n_students):
        speed = rnd.random()  # 0 = slow learner, 1 = fast learner
        p_transit = 0.05 + 0.35 * speed
        p_init = 0.1 + 0.3 * speed
        n_opp = rnd.randint(MIN_TOTAL, MIN_TOTAL + 10)
        mastered = rnd.random() < p_init
        seq = []
        for _ in range(n_opp):
            p_correct = (1 - BKT_P_SLIP) if mastered else BKT_P_GUESS
            o = 1 if rnd.random() < p_correct else 0
            seq.append(o)
            if not mastered and rnd.random() < p_transit:
                mastered = True
        by_key[(f"s{s}", "synthetic-chapter")] = seq
    return by_key


# ----------------------------------------------------------------------
# Cross-validated evaluation.
# ----------------------------------------------------------------------

def _metrics(y_true, y_pred_bin):
    tp = sum(1 for t, p in zip(y_true, y_pred_bin) if t == 1 and p == 1)
    fp = sum(1 for t, p in zip(y_true, y_pred_bin) if t == 0 and p == 1)
    fn = sum(1 for t, p in zip(y_true, y_pred_bin) if t == 1 and p == 0)
    tn = sum(1 for t, p in zip(y_true, y_pred_bin) if t == 0 and p == 0)
    acc = (tp + tn) / max(1, len(y_true))
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return {"acc": acc, "prec": prec, "rec": rec, "f1": f1, "n": len(y_true), "n_pos": sum(y_true)}


def _auc(y_true, y_score):
    """ROC-AUC via the rank-sum (Mann-Whitney U) identity: the probability
    that a random positive is scored higher than a random negative, with
    ties counted as half a win. Threshold-independent -- unlike accuracy/
    F1 at a fixed 0.5 cutoff, this doesn't change if the classifier's
    probabilities are well-separated but shifted (e.g. after class
    reweighting), which matters here since fit_logreg's balanced
    reweighting intentionally moves the decision boundary. Returns None
    if y_true has only one class (AUC undefined)."""
    pairs = sorted(zip(y_score, y_true))
    n = len(pairs)
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1  # 1-indexed average rank for tied scores
        for k in range(i, j + 1):
            ranks[k] = avg_rank
        i = j + 1
    n_pos = sum(y_true)
    n_neg = n - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    sum_ranks_pos = sum(r for r, (s, t) in zip(ranks, pairs) if t == 1)
    u = sum_ranks_pos - n_pos * (n_pos + 1) / 2.0
    return u / (n_pos * n_neg)


def _avg_metrics(ms):
    keys = ["acc", "prec", "rec", "f1"]
    out = {k: sum(m[k] for m in ms) / len(ms) for k in keys}
    aucs = [m["auc"] for m in ms if m.get("auc") is not None]
    out["auc"] = sum(aucs) / len(aucs) if aucs else None
    return out


def cross_validate(X, y, k_folds=5, seed=0):
    n = len(y)
    idx = list(range(n))
    rnd = random.Random(seed)
    # stratified: shuffle within each class, then interleave into folds
    pos = [i for i in idx if y[i] == 1]
    neg = [i for i in idx if y[i] == 0]
    rnd.shuffle(pos)
    rnd.shuffle(neg)
    folds = [[] for _ in range(k_folds)]
    for group in (pos, neg):
        for i, item in enumerate(group):
            folds[i % k_folds].append(item)

    model_ms, maj_ms, bkt_ms = [], [], []
    for f in range(k_folds):
        test_idx = set(folds[f])
        train_idx = [i for i in idx if i not in test_idx]
        test_idx = list(test_idx)
        if not train_idx or not test_idx:
            continue
        Xtr = [X[i] for i in train_idx]
        ytr = [y[i] for i in train_idx]
        Xte = [X[i] for i in test_idx]
        yte = [y[i] for i in test_idx]
        if len(set(ytr)) < 2:
            continue  # can't fit/evaluate a fold with only one class present

        Xtr_s, mean, std = _standardize(Xtr)
        Xte_s, _, _ = _standardize(Xte, mean, std)
        w, b = fit_logreg(Xtr_s, ytr)
        model_scores = [predict_logreg(w, b, x) for x in Xte_s]
        model_pred = [1 if s >= 0.5 else 0 for s in model_scores]
        mm = _metrics(yte, model_pred); mm["auc"] = _auc(yte, model_scores); model_ms.append(mm)

        majority = 1 if sum(ytr) / len(ytr) >= 0.5 else 0
        maj_pred = [majority] * len(yte)
        mj = _metrics(yte, maj_pred); mj["auc"] = None; maj_ms.append(mj)

        # bkt_early_p is feature index 3 (FEATURE_NAMES) -- a probability
        # already, and lower means MORE at-risk, so flip sign for AUC
        # (which assumes higher score = more positive) and threshold the
        # RAW (unstandardized) value for the 0.5-cutoff metrics, since
        # BKT_NEEDS_PRACTICE is a probability, not a standardized score.
        bkt_scores = [1 - X[i][3] for i in test_idx]
        bkt_pred = [1 if X[i][3] < BKT_NEEDS_PRACTICE else 0 for i in test_idx]
        bm = _metrics(yte, bkt_pred); bm["auc"] = _auc(yte, bkt_scores); bkt_ms.append(bm)

    return {
        "model": _avg_metrics(model_ms) if model_ms else None,
        "majority": _avg_metrics(maj_ms) if maj_ms else None,
        "bkt_early": _avg_metrics(bkt_ms) if bkt_ms else None,
        "folds_used": len(model_ms),
    }


def fit_full_and_report_weights(X, y):
    """Fits one final model on ALL data (for inspection/porting), after
    cross-validation has already given an honest performance estimate.
    Standardized-space weights, so also reports the mean/std needed to
    apply them to a new raw feature vector elsewhere (e.g. ported into
    sheet-script-template.gs or app.js for live scoring)."""
    Xs, mean, std = _standardize(X)
    w, b = fit_logreg(Xs, y)
    return w, b, mean, std


# ----------------------------------------------------------------------

def build_dataset(by_key):
    X, y = [], []
    for (sid, chapter), seq in by_key.items():
        if len(seq) < MIN_TOTAL:
            continue
        X.append(early_features(seq, EARLY_K))
        y.append(1 if final_mastery(seq) < BKT_NEEDS_PRACTICE else 0)
    return X, y


def main():
    if len(sys.argv) > 1:
        path = sys.argv[1]
        print(f"Loading quiz/code attempts from {path} ...")
        by_key = load_csv_sequences(path)
        print(f"{len(by_key)} (student, chapter) sequences loaded.\n")
    else:
        print("No CSV given -- running on a built-in synthetic dataset "
              "(self-test: a genuine, noisy early->eventual relationship).\n")
        by_key = synthetic_dataset()

    X, y = build_dataset(by_key)
    n_usable = len(y)
    n_pos = sum(y)
    print(f"Usable (student, chapter) rows (>= {MIN_TOTAL} opportunities): {n_usable}")
    if n_usable < 20:
        print(f"Too few rows ({n_usable}) to cross-validate meaningfully "
              f"(need >=20, ideally 50+). Collect more real usage, or point "
              f"this at a larger export, before trusting any numbers below.\n")
        if n_usable == 0:
            return
    print(f"Label balance: {n_pos}/{n_usable} ({n_pos/n_usable*100:.1f}%) are "
          f"'eventually needed practice' (final BKT mastery < {BKT_NEEDS_PRACTICE}).\n")

    if n_pos == 0 or n_pos == n_usable:
        print("Only one label value present -- cannot evaluate a classifier "
              "against it meaningfully. Collect more varied real usage.\n")
        return

    result = cross_validate(X, y, k_folds=min(5, n_pos, n_usable - n_pos) or 2)
    print(f"5-fold cross-validation ({result['folds_used']} folds completed):\n")

    def line(name, m):
        if m is None:
            print(f"  {name:10s}  (no folds evaluable)")
            return
        auc_s = f"{m['auc']*100:5.1f}%" if m["auc"] is not None else "  n/a "
        print(f"  {name:10s}  AUC={auc_s}  acc={m['acc']*100:5.1f}%  precision={m['prec']*100:5.1f}%  "
              f"recall={m['rec']*100:5.1f}%  F1={m['f1']*100:5.1f}%")

    line("model", result["model"])
    line("bkt_early", result["bkt_early"])
    line("majority", result["majority"])
    print()
    print("  'model'     = logistic regression (balanced class weights) on the 4 early features below")
    print("  'bkt_early' = baseline: just threshold BKT's own early-window estimate")
    print("  'majority'  = baseline: always predict the more common label (AUC undefined -- no ranking, just one label)")
    print()
    print("  AUC is the headline number to report: it's threshold-independent, so it survives the")
    print("  class-balanced reweighting above shifting where 0.5 falls. acc/precision/recall/F1 are")
    print("  all read at a plain 0.5 cutoff and are shown for completeness, not as the main result.")
    print()
    if result["model"] and result["bkt_early"] and result["model"]["auc"] is not None and result["bkt_early"]["auc"] is not None \
       and result["model"]["auc"] <= result["bkt_early"]["auc"] + 0.02:
        print("  NOTE: the trained model's AUC is not clearly above the 'just read BKT "
              "early' baseline's on this data. That is itself a valid, reportable "
              "finding for the dissertation (the adaptive model may already be "
              "an adequate early predictor on its own) -- it is not a bug.\n")

    w, b, mean, std = fit_full_and_report_weights(X, y)
    print("Final model (fit on ALL usable rows, standardized features):")
    for name, wj, m, s in zip(FEATURE_NAMES, w, mean, std):
        print(f"  {name:14s} weight={wj:+.3f}   (train mean={m:.3f}, std={s:.3f})")
    print(f"  {'intercept':14s} weight={b:+.3f}")
    print()
    print("To score a NEW (student, chapter) at opportunity K live: compute the\n"
          "4 features above from their first "
          f"{EARLY_K} opportunities, standardize each\n"
          "with (value - mean) / std using the mean/std printed above, take the\n"
          "dot product with the weights plus the intercept, and apply the\n"
          "logistic function -- that is an early-risk probability, which can\n"
          "feed the same 'needs support' section of the weekly digest "
          "(sheet-script-template.gs's buildDigest_()) or a new early-warning\n"
          "card in app.js's recommend(), well before BKT itself would flag it.")


if __name__ == "__main__":
    main()
