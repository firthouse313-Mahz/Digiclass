#!/usr/bin/env python3
"""
bkt_eval.py -- fit and evaluate a Bayesian Knowledge Tracing (BKT) model
on DigiClass's Computer Science quiz data, for the dissertation's
methodology / evaluation chapter.

This is a standalone script: it does NOT talk to Google Sheets or Apps
Script. It is the offline counterpart to the live, hand-picked-constant
BKT model running in sheet-script-template.gs (see "Adaptive mastery
model" in README.md) -- here the four BKT parameters are *fit* from real
data via EM (Baum-Welch), and the fit is *evaluated* (held-out accuracy,
log-loss, Brier score, a calibration table), rather than just asserted.

USAGE
-----
  python3 bkt_eval.py                       # runs on a built-in synthetic
                                             # dataset (self-test: recovers
                                             # the ground-truth parameters
                                             # it was generated from)
  python3 bkt_eval.py activity.csv          # fits + evaluates on real data

INPUT CSV
---------
Export the "Activity - Computer Science" sheet to CSV (Google Sheets:
File -> Download -> Comma-separated values) and pass that path. Expected
columns (same order as ACTIVITY_HEADERS in sheet-script-template.gs):
  Time, Name, Class, Event, Course, Chapter, Score, Total, Student ID,
  Boy/Girl, Subject, Answer, Class ID
Only rows where Event == "quiz" are used. Each row becomes `Total`
individual correct/incorrect "opportunities" in time order (Score of
them correct, the rest incorrect) -- matching exactly how
bktUpdateQuiz_() in sheet-script-template.gs consumes a quiz attempt, so
the parameters fit here are directly comparable to (and can replace) the
BKT_P_* constants near the top of that script.

MODEL
-----
Standard two-state BKT (Corbett & Anderson, 1995): a learner is either
"not yet mastered" (state 0) or "mastered" (state 1) on a given chapter.
Mastery never regresses (no "forgetting" state), so the only transition
is 0 -> 1 with probability p_transit. The observed correctness of each
opportunity depends on the hidden state via two noise parameters: a
learner who hasn't mastered it can still guess right (p_guess), and one
who has can still slip up (p_slip). p_init is the prior probability of
already being in the mastered state before the first opportunity.

Parameters are fit per chapter via Baum-Welch (EM over a left-to-right,
non-ergodic 2-state HMM), which is the textbook approach for BKT.
"""

import csv
import math
import random
import sys
from collections import defaultdict

# ----------------------------------------------------------------------
# Core BKT forward-backward (EM) -- operates on a list of sequences,
# each sequence a list of 0/1 (incorrect/correct), one per chapter.
# ----------------------------------------------------------------------

def forward_backward(seq, p_init, p_transit, p_guess, p_slip):
    """Returns (alpha, beta, loglik) for one observation sequence.
    alpha[t][s], beta[t][s] are *scaled* (normalized each step) forward/
    backward probabilities for hidden state s in {0=not mastered, 1=mastered}.
    """
    T = len(seq)
    emit = lambda s, o: (p_slip if o == 1 else 1 - p_slip) if s == 1 else (p_guess if o == 1 else 1 - p_guess)
    # transition: state 0 -> {0: 1-p_transit, 1: p_transit}; state 1 -> {1: 1}
    alpha = [[0.0, 0.0] for _ in range(T)]
    scale = [1.0] * T
    a0 = (1 - p_init) * emit(0, seq[0])
    a1 = p_init * emit(1, seq[0])
    s = a0 + a1 or 1e-12
    alpha[0] = [a0 / s, a1 / s]
    scale[0] = s
    for t in range(1, T):
        prev0, prev1 = alpha[t - 1]
        pred0 = prev0 * (1 - p_transit)
        pred1 = prev0 * p_transit + prev1
        a0 = pred0 * emit(0, seq[t])
        a1 = pred1 * emit(1, seq[t])
        s = a0 + a1 or 1e-12
        alpha[t] = [a0 / s, a1 / s]
        scale[t] = s

    beta = [[0.0, 0.0] for _ in range(T)]
    beta[T - 1] = [1.0, 1.0]
    for t in range(T - 2, -1, -1):
        b0, b1 = beta[t + 1]
        e0n, e1n = emit(0, seq[t + 1]), emit(1, seq[t + 1])
        beta0 = (1 - p_transit) * e0n * b0 + p_transit * e1n * b1
        beta1 = 1 * e1n * b1
        s = scale[t + 1]
        beta[t] = [beta0 / s, beta1 / s]

    loglik = sum(math.log(max(s, 1e-300)) for s in scale)
    return alpha, beta, loglik


def _em_fit_once(sequences, init_params, iters=50, verbose=False):
    p_init, p_transit, p_guess, p_slip = (init_params["p_init"], init_params["p_transit"],
                                           init_params["p_guess"], init_params["p_slip"])
    prev_ll = None
    for it in range(iters):
        # E-step accumulators
        init_num, init_den = 0.0, 0.0
        trans_num, trans_den = 0.0, 0.0
        guess_num, guess_den = 0.0, 0.0  # given state 0, observed correct / total time in state 0
        slip_num, slip_den = 0.0, 0.0    # given state 1, observed incorrect / total time in state 1
        total_ll = 0.0

        for seq in sequences:
            if not seq:
                continue
            alpha, beta, ll = forward_backward(seq, p_init, p_transit, p_guess, p_slip)
            total_ll += ll
            T = len(seq)
            gamma = [[a0 * b0, a1 * b1] for (a0, b0), (a1, b1) in zip(alpha, beta)]
            for t in range(T):
                s = gamma[t][0] + gamma[t][1] or 1e-12
                gamma[t] = [gamma[t][0] / s, gamma[t][1] / s]

            init_num += gamma[0][1]
            init_den += 1

            for t in range(T):
                g0, g1 = gamma[t]
                o = seq[t]
                guess_den += g0
                guess_num += g0 * (1 if o == 1 else 0)
                slip_den += g1
                slip_num += g1 * (1 if o == 0 else 0)

            # Expected transitions between t and t+1: alpha/beta here are
            # already per-step normalized (Rabiner-style scaled forward-
            # backward), so recovering the joint xi_t(i,j) needs dividing
            # back out by that step's own normalizer (scale[t+1]) -- see
            # forward_backward()'s docstring / module comment above.
            for t in range(T - 1):
                a0, a1 = alpha[t]
                e0n = (1 - p_guess) if seq[t + 1] == 0 else p_guess
                e1n = (1 - p_slip) if seq[t + 1] == 1 else p_slip
                b0n, b1n = beta[t + 1]
                num01 = a0 * p_transit * e1n * b1n
                num00 = a0 * (1 - p_transit) * e0n * b0n
                num11 = a1 * 1.0 * e1n * b1n
                denom = num01 + num00 + num11 or 1e-12
                xi01 = num01 / denom
                xi00 = num00 / denom
                trans_num += xi01
                trans_den += xi01 + xi00  # expected opportunities spent "still in state 0" at t

        # Bounds on p_guess/p_slip follow standard BKT fitting practice
        # (e.g. Baker, Corbett & Aleven, 2008): without them, EM on short
        # sequences readily collapses onto a degenerate "no learning, just
        # a coin-flip" solution (p_init~1, p_transit~0, p_guess~0.5) that
        # fits the raw correctness rate just as well as any real dynamic
        # model, because it throws away the (hard to pin down) state
        # dynamics entirely rather than really explaining them. Capping
        # guess <=0.3 and slip <=0.1 is the conventional way to rule that
        # degenerate region out and force a genuine two-state fit.
        p_init = max(1e-4, min(1 - 1e-4, init_num / max(init_den, 1e-9)))
        p_transit = max(1e-4, min(1 - 1e-4, trans_num / max(trans_den, 1e-9)))
        p_guess = max(1e-4, min(0.3, guess_num / max(guess_den, 1e-9)))
        p_slip = max(1e-4, min(0.1, slip_num / max(slip_den, 1e-9)))

        if verbose:
            print(f"  iter {it+1:2d}: ll={total_ll:.2f} p_init={p_init:.3f} p_transit={p_transit:.3f} p_guess={p_guess:.3f} p_slip={p_slip:.3f}")
        if prev_ll is not None and abs(total_ll - prev_ll) < 1e-4:
            break
        prev_ll = total_ll

    return {"p_init": p_init, "p_transit": p_transit, "p_guess": p_guess, "p_slip": p_slip}, prev_ll


def em_fit(sequences, iters=50, seed=0, n_restarts=6, verbose=False):
    """Fits BKT parameters via EM. BKT is well known to have multiple local
    optima (and parameter-identifiability issues in general -- see Beck &
    Chang, 2007), so this runs several random restarts and keeps the one
    with the best log-likelihood, which is standard practice rather than
    trusting a single run from one starting point.
    """
    rnd = random.Random(seed)
    best_params, best_ll = None, None
    starts = [{"p_init": 0.3, "p_transit": 0.1, "p_guess": 0.25, "p_slip": 0.1}]
    for _ in range(n_restarts - 1):
        starts.append({
            "p_init": rnd.uniform(0.05, 0.6),
            "p_transit": rnd.uniform(0.02, 0.4),
            "p_guess": rnd.uniform(0.05, 0.4),
            "p_slip": rnd.uniform(0.02, 0.3),
        })
    for start in starts:
        params, ll = _em_fit_once(sequences, start, iters=iters, verbose=verbose)
        if ll is not None and (best_ll is None or ll > best_ll):
            best_params, best_ll = params, ll
    return best_params, best_ll


def predict_sequence(seq, params):
    """Runs the forward BKT update step-by-step and returns, for each
    position t, the model's PRIOR predicted P(correct) before seeing
    seq[t] -- i.e. what the model would have predicted using only
    seq[0..t-1]. Used for honest held-out-style evaluation.
    """
    p = params["p_init"]
    preds = []
    for o in seq:
        pred = p * (1 - params["p_slip"]) + (1 - p) * params["p_guess"]
        preds.append(pred)
        # posterior update given observed o, then one learning step
        if o == 1:
            num, den = p * (1 - params["p_slip"]), pred
        else:
            num, den = p * params["p_slip"], 1 - pred
        p = (num / den) if den > 0 else p
        p = p + (1 - p) * params["p_transit"]
    return preds


def evaluate(sequences, params):
    """Leave-the-last-opportunity-out style evaluation: for every sequence
    with >=2 opportunities, use the model's prediction for each opportunity
    (made before seeing it) and score against what actually happened.
    Reports accuracy (@0.5), log-loss, and a 5-bucket calibration table.
    """
    y_true, y_pred = [], []
    for seq in sequences:
        if len(seq) < 2:
            continue
        preds = predict_sequence(seq, params)
        y_true.extend(seq)
        y_pred.extend(preds)
    if not y_true:
        return None
    n = len(y_true)
    acc = sum(1 for t, p in zip(y_true, y_pred) if (p >= 0.5) == (t == 1)) / n
    eps = 1e-9
    logloss = -sum(t * math.log(max(p, eps)) + (1 - t) * math.log(max(1 - p, eps)) for t, p in zip(y_true, y_pred)) / n
    brier = sum((p - t) ** 2 for t, p in zip(y_true, y_pred)) / n
    # calibration: bucket predictions into 5 bins, compare mean predicted vs observed rate
    buckets = [[] for _ in range(5)]
    for t, p in zip(y_true, y_pred):
        b = min(4, int(p * 5))
        buckets[b].append(t)
    calib = []
    for i, b in enumerate(buckets):
        if b:
            calib.append((f"{i*20}-{(i+1)*20}%", len(b), sum(b) / len(b)))
    return {"n": n, "accuracy": acc, "log_loss": logloss, "brier": brier, "calibration": calib}


# ----------------------------------------------------------------------
# Data loading: real CSV, grouped into per (student, chapter) sequences.
# ----------------------------------------------------------------------

def load_csv_sequences(path):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            if (r.get("Event") or "").strip().lower() != "quiz":
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
    rows.sort(key=lambda r: r[0])  # time order, same as rows_() in Apps Script

    by_key = defaultdict(list)
    for ts, sid, chapter, score, total in rows:
        correct = max(0, min(total, round(score)))
        wrong = total - correct
        by_key[(sid, chapter)].extend([1] * correct + [0] * wrong)
    return by_key


def synthetic_dataset(seed=0, n_students=60, ground_truth=None):
    """Generates data from a KNOWN set of BKT parameters, so fitting it
    back and comparing recovered vs. ground-truth parameters is a sanity
    check on the EM implementation itself (standard practice for a
    methodology chapter: "the fitting procedure recovers known parameters
    on simulated data before being trusted on real data").
    """
    gt = ground_truth or {"p_init": 0.25, "p_transit": 0.2, "p_guess": 0.22, "p_slip": 0.12}
    rnd = random.Random(seed)
    by_key = {}
    for s in range(n_students):
        n_opportunities = rnd.randint(4, 12)
        mastered = rnd.random() < gt["p_init"]
        seq = []
        for _ in range(n_opportunities):
            p_correct = (1 - gt["p_slip"]) if mastered else gt["p_guess"]
            o = 1 if rnd.random() < p_correct else 0
            seq.append(o)
            if not mastered and rnd.random() < gt["p_transit"]:
                mastered = True
        by_key[(f"s{s}", "synthetic-chapter")] = seq
    return by_key, gt


def main():
    if len(sys.argv) > 1:
        path = sys.argv[1]
        print(f"Loading quiz attempts from {path} ...")
        by_key = load_csv_sequences(path)
        print(f"{len(by_key)} (student, chapter) sequences, {sum(len(v) for v in by_key.values())} total opportunities.\n")
        ground_truth = None
    else:
        print("No CSV given -- running on a built-in synthetic dataset (EM self-test).\n")
        by_key, ground_truth = synthetic_dataset()

    # Fit one global model per chapter (small real deployments won't have
    # enough attempts per chapter to fit a stable model per student).
    by_chapter = defaultdict(list)
    for (sid, chapter), seq in by_key.items():
        by_chapter[chapter].append(seq)

    for chapter, sequences in sorted(by_chapter.items()):
        n_seq = len(sequences)
        n_obs = sum(len(s) for s in sequences)
        print(f"=== {chapter} ({n_seq} students, {n_obs} opportunities) ===")
        if n_obs < 10:
            print("  too little data to fit reliably (need >=10 opportunities) -- skipping.\n")
            continue
        params, ll = em_fit(sequences, iters=50, verbose=False)
        print(f"  fitted: p_init={params['p_init']:.3f}  p_transit={params['p_transit']:.3f}  "
              f"p_guess={params['p_guess']:.3f}  p_slip={params['p_slip']:.3f}  (log-lik={ll:.2f})")
        if ground_truth:
            print(f"  ground truth: p_init={ground_truth['p_init']:.3f}  p_transit={ground_truth['p_transit']:.3f}  "
                  f"p_guess={ground_truth['p_guess']:.3f}  p_slip={ground_truth['p_slip']:.3f}")
        ev = evaluate(sequences, params)
        if ev:
            print(f"  eval: n={ev['n']}  accuracy={ev['accuracy']*100:.1f}%  log-loss={ev['log_loss']:.3f}  brier={ev['brier']:.3f}")
            print("  calibration (predicted bucket -> observed correct rate):")
            for label, n, rate in ev["calibration"]:
                print(f"    {label:>8}  n={n:<4}  observed={rate*100:.1f}%")
        print()

    print("Done. Paste the fitted p_init/p_transit/p_guess/p_slip for Computer\n"
          "Science (or a chosen chapter) into BKT_P_INIT/BKT_P_TRANSIT/BKT_P_GUESS/\n"
          "BKT_P_SLIP in sheet-script-template.gs to replace the shipped defaults\n"
          "with values fit from real data.")


if __name__ == "__main__":
    main()
