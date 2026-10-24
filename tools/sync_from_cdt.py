#!/usr/bin/env python3
"""sync_from_cdt.py --- pull plot-ready data and figures for the site from the CDT_4d research repo.

Usage:  python tools/sync_from_cdt.py ../CDT_4d-master

Reads (never writes) the research repo and produces, in this site:
  data/desitter.json      de Sitter volume profiles, rescaled collapse points, s0 fits
  data/spectral.json      D_S(sigma) per run (jackknife errors) and the AJL fit
  data/phases.json        phase A/B/C runs, profile kymographs, phase-B collapse, A-C N0/N4 histories
  data/fluctuations.json  xi = N32/N41 per chain and the kinetic coefficient k1
  data/curvature2d.json   2D quantum Ricci curvature profiles (CDT and DT) against 2110.11100 / 1802.10524
  data/targets.json       published targets from 3p1_mh/validation/TARGETS.md
  data/references.json    references/references.bib + categories and notes of references/INDEX.md
  data/reading.json       notes/READING.md
  data/manifest.json      source commit, branch, timestamp, files produced
  assets/fig/{lisp-validation,large-volume,curvature2d}/*.png

The summary JSONs of the research repo hold fit results but not every plotted curve. The curves (profiles,
D_S(sigma), Monte Carlo histories) are recomputed here from the measurement files in the validation out/
directories, with the estimators of 3p1_mh/validation/analysis.py; those files are only read, never copied.
Standard library only. Re-running gives the same output (apart from the manifest timestamp).
See data/README.md for the schema of every file.
"""
import argparse
import datetime
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(SITE, "data")
FIGS = os.path.join(SITE, "assets", "fig")

LISP_VAL = "3p1_mh/validation"
LV = "cdt/validation/large-volume"
CURV = "cdt/validation/2d-curvature"

# C++ de Sitter run per volume; dS-80k was retired for dS-80k-n (large-volume/analyse.py, DS)
CPP_DS = {"20k": "dS-20k", "40k": "dS-40k", "80k": "dS-80k-n"}
AJL = (4.02, 119.0, 54.0)  # D_S(sigma) = a - b/(c + sigma), [R] Fig. 9, N4 = 181k


class SyncError(Exception):
    pass


# --------------------------------------------------------------------------- io helpers
class Source:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        if not os.path.isdir(self.root):
            raise SyncError(f"source repo not found: {self.root}")

    def path(self, rel):
        p = os.path.join(self.root, *rel.split("/"))
        if not os.path.exists(p):
            raise SyncError(f"missing input: {rel} (looked in {self.root})")
        return p

    def json(self, rel):
        with open(self.path(rel), encoding="utf-8") as f:
            return json.load(f)  # accepts the NaN literals the analysis scripts write

    def text(self, rel):
        with open(self.path(rel), encoding="utf-8") as f:
            return f.read()

    def glob(self, rel_pattern):
        return sorted(glob.glob(os.path.join(self.root, *rel_pattern.split("/"))))


def rnd(x, sig=6):
    """JSON-safe value: floats rounded to `sig` significant digits, NaN/inf -> null"""
    if isinstance(x, bool) or x is None or isinstance(x, (int, str)):
        return x
    if isinstance(x, float):
        if not math.isfinite(x):
            return None
        if x == 0:
            return 0.0
        return float(f"{x:.{sig}g}")
    if isinstance(x, dict):
        return {k: rnd(v, sig) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [rnd(v, sig) for v in x]
    raise TypeError(f"cannot serialise {type(x)}")


def write_json(name, obj, produced):
    path = os.path.join(DATA, name)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(rnd(obj), f, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        f.write("\n")
    produced.append(path)


def thin_idx(n, k, log=False):
    """about k indices of range(n), evenly spaced (or geometrically, for log-scaled axes), with the first and last"""
    if n <= k:
        return list(range(n))
    if log:
        return sorted({0} | {round(math.exp(j * math.log(n - 1) / (k - 1))) for j in range(k)})
    return sorted({round(j * (n - 1) / (k - 1)) for j in range(k)})


# --------------------------------------------------------------------------- measurement files
def read_meas(path):
    """rows of a .meas file (Lisp and C++ share the format):
    stage(T|P) proposals N0 N41 N32 kappa4 N3(0) ... N3(T-1). Adds the cumulative proposal count (the
    production counter restarts at 0 after thermalisation)."""
    rows, offset, last_t = [], 0.0, 0.0
    with open(path) as f:
        for line in f:
            w = line.split()
            if len(w) < 7 or w[0] not in ("T", "P"):
                continue
            count = float(w[1])
            if w[0] == "T":
                last_t = count
                offset = 0.0
            elif offset == 0.0:
                offset = last_t
            rows.append({"stage": w[0], "count": count, "cum": count + (offset if w[0] == "P" else 0.0),
                         "N0": float(w[2]), "N41": float(w[3]), "N32": float(w[4]), "k4": float(w[5]),
                         "prof": [float(x) for x in w[6:]]})
    if not rows:
        raise SyncError(f"no measurements in {path}")
    return rows


def production(rows):
    return [r for r in rows if r["stage"] == "P"]


def therm_end(rows):
    t = [r["cum"] for r in rows if r["stage"] == "T"]
    return t[-1] if t else 0.0


def mean(x):
    return sum(x) / len(x)


def tau_int(x, c=6.0):
    """integrated autocorrelation time with Madras-Sokal windowing (analysis.tau_int, without FFT)"""
    n = len(x)
    m = mean(x)
    d = [v - m for v in x]
    var = sum(v * v for v in d)
    if n < 10 or var == 0:
        return 0.5
    tau = 0.5
    for w in range(1, n):
        tau += sum(d[i] * d[i + w] for i in range(n - w)) / var
        if w >= c * tau:
            break
    return max(tau, 0.5)


def stats(x):
    """[mean, autocorrelation-corrected error, tau_int] as in analysis.binned_error"""
    n = len(x)
    m = mean(x)
    if n < 2:
        return [m, float("nan"), 0.5]
    tau = tau_int(x)
    sd = math.sqrt(sum((v - m) ** 2 for v in x) / (n - 1))
    return [m, sd * math.sqrt(2 * tau / n), tau]


def centre(p):
    """AGJL centre of volume ([dS] footnote 4), as analysis.centre: the profile rolled so i_cv sits at n//2"""
    n = len(p)
    ks = range(-n // 2, n // 2)
    best, best_cv = 0, None
    for ip in range(n):
        cv = abs(sum((k + 0.5) * p[(ip + k) % n] for k in ks))
        if best_cv is None or cv < best_cv - 1e-9 or (abs(cv - best_cv) <= 1e-9 and p[ip] > p[best]):
            best, best_cv = ip, cv
    s = n // 2 - best
    return [p[(j - s) % n] for j in range(n)]


def mean_profile(profs):
    n = len(profs)
    return [sum(p[j] for p in profs) / n for j in range(len(profs[0]))]


def ext90(p):
    t, tot = len(p), sum(p)
    for L in range(1, t + 1):
        if max(sum(p[(i + j) % t] for j in range(L)) for i in range(t)) >= 0.9 * tot:
            return L
    return t


def lag1(p):
    m = mean(p)
    d = [v - m for v in p]
    v = sum(x * x for x in d)
    return sum(d[i] * d[i - 1] for i in range(len(d))) / v if v > 0 else 0.0


def max_slice_frac(p):
    return max(p) / sum(p)


def classify(lag, msf):
    """phase label used on the site: B = most of the volume in one slice, C = smooth extended profile, else A.
    (A runs have lag1 <= 0.1 and C runs >= 0.28 in both validations; a collapsed slice has lag1 ~ 0.)"""
    if msf > 0.5:
        return "B"
    return "C" if lag > 0.2 else "A"


# --------------------------------------------------------------------------- run parameters
LISP_HEAD = re.compile(r"run (\S+): k0=([\d.]+) D=([\d.]+) T=(\d+) N41=(\d+)")
CPP_HEAD = re.compile(r"k0=([\d.]+) delta=([\d.]+) .* target (\d+)")


def lisp_params(src, name):
    with open(src.path(f"{LISP_VAL}/out/{name}.log")) as f:
        m = LISP_HEAD.match(f.readline())
    if not m:
        raise SyncError(f"cannot parse run parameters from {LISP_VAL}/out/{name}.log")
    return {"kappa0": float(m.group(2)), "Delta": float(m.group(3)), "T": int(m.group(4)), "N41": int(m.group(5))}


def cpp_params(src, name):
    with open(src.path(f"{LV}/out/{name}.log")) as f:
        for line in f:
            m = CPP_HEAD.search(line)
            if m:
                return {"kappa0": float(m.group(1)), "Delta": float(m.group(2)), "N41": int(m.group(3))}
    raise SyncError(f"cannot parse run parameters from {LV}/out/{name}.log")


def start_of(name):
    """u = uniform start, c/s = concentrated / collapsed start (run naming of both validations)"""
    m = re.search(r"-(u|c|s)(\d*)(-c\d)?$", name)
    return {"u": "uniform", "c": "concentrated", "s": "collapsed"}[m.group(1)] if m else None


def vlabel(vol):
    """volume label: the Lisp summary writes '05k'"""
    return vol.lstrip("0")


def close(a, b, rel=1e-6):
    return a is not None and b is not None and abs(a - b) <= rel * max(1.0, abs(a), abs(b))


# --------------------------------------------------------------------------- de Sitter
def rescale(i, n3, n41, n4):
    q = n4 ** 0.25
    return [k / q for k in i], [v / (0.5 * n41) * q for v in n3]


def cos3_curve(s0, amp=None, n=61):
    """published-form curve in rescaled units: y = (3/4)/s0 cos^3(x/s0) on |x| < pi s0 / 2 (amp overrides 3/4/s0)"""
    a = 0.75 / s0 if amp is None else amp
    xs = [(-0.5 + j / (n - 1)) * math.pi * s0 for j in range(n)]
    return {"x": xs, "y": [a * max(math.cos(x / s0), 0.0) ** 3 for x in xs]}


def ds_chain(rows, cid, code, volume, extra):
    prod = production(rows)
    half = prod[len(prod) // 2:]
    m = mean_profile([centre(r["prof"]) for r in half])
    n41 = mean([r["N41"] for r in half])
    n4 = mean([r["N41"] + r["N32"] for r in half])
    i = [k - len(m) // 2 for k in range(len(m))]
    x, y = rescale(i, m, n41, n4)
    out = {"id": cid, "code": code, "volume": volume, "N41": n41, "N4": n4, "T": len(m), "window": "second half of production",
           "nmeas": len(half), "i": i, "n3": [round(v, 2) for v in m], "x": x, "y": y}
    out.update(extra)
    return out, len(prod)


def build_desitter(src, lisp, lv, targets):
    chains, fits = [], []
    # Lisp (3p1_mh), N41 = 5k and 10k
    for vol, v in lisp["desitter"].items():
        if not isinstance(v, dict):
            continue
        pooled = 0
        for cid in v["chains"]:
            rows = read_meas(src.path(f"{LISP_VAL}/out/{cid}.meas"))
            c, nprod = ds_chain(rows, cid, "lisp", vlabel(vol), {"start": start_of(cid), "equilibrated": vol != "10k"})
            pooled += nprod
            chains.append(c)
        if pooled != v["nmeas"]:
            raise SyncError(f"Lisp de Sitter {vol}: {pooled} production rows, summary.json pools {v['nmeas']}")
        f = v.get("fit")
        fits.append({"volume": vlabel(vol), "code": "lisp", "N41": v["N41"], "N4": v["N4"], "nmeas": v["nmeas"], "window": "all production",
                     "fit": f, "curve": cos3_curve(f["s0"]) if f else None, "provisional": vol == "10k"})
    # C++ (cdt/4d), N41 = 20k, 40k, 80k
    for vol, run in CPP_DS.items():
        r = lv[f"dS-{vol}"]
        files = src.glob(f"{LV}/out/{run}-c[0-9].meas")
        if len(files) != len(r["chains"]):
            raise SyncError(f"{run}: {len(files)} chain files, results.json has {len(r['chains'])} chains")
        s0h = r["s0_norm_chains_2nd_half"]
        for k, path in enumerate(files):
            cid = os.path.basename(path)[:-5]
            rows = read_meas(path)
            c, nprod = ds_chain(rows, cid, "cpp", vol, {"start": None, "equilibrated": vol != "80k",
                                                         "s0_2nd_half": s0h[k][0], "norm_ratio_2nd_half": s0h[k][1]})
            if nprod != r["chains"][k]["nmeas"]:
                raise SyncError(f"{cid}: {nprod} production rows, results.json says {r['chains'][k]['nmeas']}")
            chains.append(c)
        f = r.get("fit")
        fit = {"volume": vlabel(vol), "code": "cpp", "N41": r["N41"], "N4": r["N4"], "nmeas": r["nmeas"], "window": "all production",
               "fit": f, "fit_error": r.get("fit_error"), "curve": cos3_curve(f["s0"]) if f else None,
               "s0_chains_all": r["s0_chains"], "s0_chains_2nd_half": [a for a, _ in s0h], "provisional": vol == "80k"}
        if f:
            q = r["N4"] ** 0.25
            fit["curve_free_amp"] = cos3_curve(f["free_w"] / q, amp=f["free_amp"] / (0.5 * r["N41"]) * q)
        fits.append(fit)
    return {
        "published": {**targets["values"]["s0"], "curve": cos3_curve(targets["values"]["s0"]["value"])},
        "rescaling": {"x": "i / N4^(1/4)", "y": "<N3(i)> / (N41/2) * N4^(1/4)",
                      "model": "y = (3/4)/s0 * cos^3(x/s0) for |x| < pi*s0/2, else 0"},
        "chains": chains,
        "fits": fits,
        "D_H_best_overlap": {"lisp": lisp["desitter"].get("D_H_best_overlap"), "cpp": lv.get("D_H_best_overlap"),
                             "scan": [2.5, 6.0], "note": "at the edge of the scan: no D_H could be determined"},
    }


# --------------------------------------------------------------------------- spectral dimension
def ds_curve(p):
    """analysis.spectral_dimension: D_S at even sigma from the central difference over sigma-2, sigma+2"""
    out = {}
    for k in range(4, len(p) - 2, 2):
        if p[k - 2] > 0 and p[k + 2] > 0:
            out[k] = -2 * (math.log(p[k + 2]) - math.log(p[k - 2])) / (math.log(k + 2) - math.log(k - 2))
    return out


def build_spectral(src, lisp, lv):
    runs = []
    for vol, run in CPP_DS.items():
        files = [f for f in src.glob(f"{LV}/out/spectral_dual-{run}-c[0-9].dat") if os.path.getsize(f) > 0]
        if not files:
            raise SyncError(f"missing input: {LV}/out/spectral_dual-{run}-c*.dat")
        rows = []
        for f in files:
            with open(f) as fh:
                rows += [[float(x) for x in line.split()] for line in fh if line.strip()]
        n, m = len(rows), len(rows[0])
        tot = [sum(r[j] for r in rows) for j in range(m)]
        ds = ds_curve([t / n for t in tot])
        jk = [ds_curve([(tot[j] - r[j]) / (n - 1) for j in range(m)]) for r in rows]
        sig = sorted(ds)
        err = {}
        for s in sig:
            v = [d[s] for d in jk if s in d]
            mv = mean(v)
            err[s] = math.sqrt((n - 1) / n * sum((x - mv) ** 2 for x in v))
        ref = lv[f"spectral-{vol}"]
        if ref["nmeas"] != n:
            raise SyncError(f"spectral {run}: {n} measurements, results.json says {ref['nmeas']}")
        for s, (d, e, _) in ref["at"].items():
            if not (close(ds.get(int(s)), d, 1e-6) and close(err.get(int(s)), e, 1e-4)):
                raise SyncError(f"spectral {run}: recomputed D_S({s}) = {ds.get(int(s))} differs from results.json {d}")
        fit = next((v for k, v in ref.items() if k.startswith("fit_")), None)
        runs.append({"id": f"spectral-{vol}", "run": run, "code": "cpp", "volume": vlabel(vol), "N4": lv[f"dS-{vol}"]["N4"],
                     "nmeas": n, "nsources": ref["nsources"], "peak": ref["peak"], "sigma_peak": ref["sigma_peak"],
                     "blob": vol != "80k", "sigma": sig, "ds": [ds[s] for s in sig], "err": [err[s] for s in sig],
                     "at": {s: {"ds": d, "err": e, "ajl": a} for s, (d, e, a) in ref["at"].items()}, "fit": fit})
    lisp_peaks = [{"volume": vlabel(vol), "code": "lisp", "N4": v["N4"], "nconfigs": v["nconfigs"], "nstarts": v["nstarts"],
                   "peak": v["DS_peak"], "sigma_peak": v["sigma_peak"]} for vol, v in lisp["spectral"].items()]
    a, b, c = AJL
    sg = list(range(10, 801, 5))
    return {"ajl": {"a": a, "b": b, "c": c, "formula": "D_S(sigma) = 4.02 - 119/(54 + sigma)", "arxiv": "hep-th/0505154",
                    "N4": 181000, "fit_range": [40, 400], "curve": {"sigma": sg, "ds": [a - b / (c + s) for s in sg]}},
            "sigma_min_reliable": 40, "runs": runs, "lisp_peaks": lisp_peaks}


# --------------------------------------------------------------------------- phases
LISP_PHASE_RUNS = ("ph", "k0s-", "dls-")
KYMO_LISP = ("phA", "phB", "k0s-3.6", "k0s-4.2", "dls-0.0", "phB20a-u")
KYMO_CPP = ("phB-20k-u-c0", "phB-40k-u-c0", "AC-20k-4.4-u-c0", "AC-20k-4.8-u-c0")


def run_summary(prod):
    thin = [prod[k]["prof"] for k in thin_idx(len(prod), 300)]
    n4 = [r["N41"] + r["N32"] for r in prod]
    return {"nmeas": len(prod),
            "N0_N4": stats([r["N0"] / v for r, v in zip(prod, n4)]),
            "conjD": stats([(r["N41"] - 6 * r["N0"]) / v for r, v in zip(prod, n4)]),
            "ext90": mean([ext90(p) for p in thin]),
            "max_slice_frac": mean([max_slice_frac(p) for p in thin]),
            "lag1": mean([lag1(p) for p in thin]),
            "k4": prod[-1]["k4"],
            "mean_profile": [round(v, 2) for v in mean_profile([centre(p) for p in thin])]}


def kymograph(rows, k=48):
    idx = thin_idx(len(rows), k)
    return {"stage": "".join(rows[j]["stage"] for j in idx), "proposals": [rows[j]["cum"] for j in idx],
            "therm_end": therm_end(rows), "profiles": [[int(v) for v in rows[j]["prof"]] for j in idx]}


def history(rows, fn, k=120, log=False):
    idx = thin_idx(len(rows), k, log)
    return {"proposals": [rows[j]["cum"] for j in idx], "value": [round(fn(rows[j]), 4) for j in idx], "therm_end": therm_end(rows)}


def build_phases(src, lisp, lv):
    runs, kymo, collapse, ac_hist = [], {}, [], []
    checked = 0
    names = sorted({os.path.basename(p)[:-5] for p in src.glob(f"{LISP_VAL}/out/*.meas")})
    for name in names:
        if not name.startswith(LISP_PHASE_RUNS):
            continue
        rows = read_meas(src.path(f"{LISP_VAL}/out/{name}.meas"))
        prod = production(rows)
        if len(prod) < 20:
            continue
        r = {"id": name, "code": "lisp", **lisp_params(src, name), "start": start_of(name), **run_summary(prod)}
        ref = lisp["phases"].get(name)
        if ref:
            # summary.json covers the first 12 Lisp phase runs; the later scans are computed here only
            if not close(r["N0_N4"][0], ref["N0/N4"][0], 1e-9):
                raise SyncError(f"{name}: N0/N4 {r['N0_N4'][0]} differs from summary.json {ref['N0/N4'][0]}")
            checked += 1
            r["stats_source"] = "summary.json"
            r["N0_N4"], r["conjD"], r["lag1"] = ref["N0/N4"], ref["conjD"], ref["corr1"]
        else:
            r["stats_source"] = "computed from out/*.meas (not in summary.json)"
        r["phase"] = classify(r["lag1"], r["max_slice_frac"])
        runs.append(r)
        if name in KYMO_LISP:
            kymo[name] = kymograph(rows)
        if name.startswith("phB"):
            h = history(rows, lambda x: max_slice_frac(x["prof"]), log=True)
            collapse.append({"id": name, "code": "lisp", "N41": r["N41"], "T": r["T"], "start": r["start"], **h})
    print(f"  phases: {checked} Lisp runs cross-checked against summary.json")
    for name, ref in lv.items():
        if not name.startswith(("phB-", "AC-")):
            continue
        rows = read_meas(src.path(f"{LV}/out/{name}.meas"))
        prod = production(rows)
        if len(prod) != ref["nmeas"]:
            raise SyncError(f"{name}: {len(prod)} production rows, results.json says {ref['nmeas']}")
        r = {"id": name, "code": "cpp", **cpp_params(src, name), "T": len(prod[0]["prof"]), "start": start_of(name.rsplit("-", 1)[0]),
             "nmeas": ref["nmeas"], "N0_N4": ref["N0/N4"], "conjD": ref["conjD"], "ext90": ref["ext90"],
             "max_slice_frac": ref["max_slice_frac"], "lag1": ref["lag1"], "k4": ref["k4"],
             "mean_profile": [round(v, 2) for v in mean_profile([centre(prod[k]["prof"]) for k in thin_idx(len(prod), 300)])],
             "stats_source": "results.json"}
        r["phase"] = classify(r["lag1"], r["max_slice_frac"])
        runs.append(r)
        if name in KYMO_CPP:
            kymo[name] = kymograph(rows)
        if name.startswith("phB-"):
            h = history(rows, lambda x: max_slice_frac(x["prof"]), log=True)
            collapse.append({"id": name, "code": "cpp", "N41": r["N41"], "T": r["T"], "start": r["start"], **h})
        else:
            h = history(rows, lambda x: x["N0"] / (x["N41"] + x["N32"]))
            counts, edges = ref["N0/N4_hist"]
            ac_hist.append({"id": name, "code": "cpp", "kappa0": r["kappa0"], "N41": r["N41"], "start": r["start"],
                            "phase": r["phase"], **h, "hist": {"counts": counts, "edges": edges}})
    # N0/N4 against kappa0 at Delta = 0.6, one series per code and volume
    series = {}
    for r in runs:
        if r["Delta"] == 0.6 and r["id"].startswith(("k0s-", "AC-")):
            series.setdefault((r["code"], r["N41"]), []).append(r["id"])
    ac_series = [{"code": c, "N41": n, "runs": sorted(ids, key=lambda i: next(x["kappa0"] for x in runs if x["id"] == i))}
                 for (c, n), ids in sorted(series.items(), key=lambda kv: (kv[0][1], kv[0][0]))]
    return {"published": {"AC": {"kappa0": 4.711, "Delta": 0.6, "N4": 120000, "order": "first", "N0_N4_jump": [0.153, 0.163],
                                 "arxiv": "1203.3591"},
                          "BC": {"Delta": 0.022, "kappa0": 2.2, "N4": 40000, "order": "second", "arxiv": "1203.3591"},
                          "examples": {"A": [5.0, 0.0], "B": [1.6, 0.0], "C": [2.2, 0.6]}},
            "classification": "B if max_slice_frac > 0.9; else C if lag1 > 0.3; else A",
            "runs": runs, "kymographs": kymo, "phaseB_collapse": collapse, "AC_history": ac_hist, "AC_vs_kappa0": ac_series}


# --------------------------------------------------------------------------- fluctuations
def build_fluctuations(lisp, lv, targets):
    xi = []
    for vol, v in lisp["desitter"].items():
        if isinstance(v, dict):
            for cid, c in v["chains"].items():
                xi.append({"id": cid, "code": "lisp", "volume": vlabel(vol), "N41": v["N41"], "xi": c["xi"][0], "err": c["xi"][1],
                           "tau": c["xi"][2], "equilibrated": vol != "10k"})
    for vol, run in CPP_DS.items():
        v = lv[f"dS-{vol}"]
        for k, c in enumerate(v["chains"]):
            xi.append({"id": f"{run}-c{k}", "code": "cpp", "volume": vlabel(vol), "N41": v["N41"], "xi": c["xi"][0], "err": c["xi"][1],
                       "tau": c["xi"][2], "equilibrated": vol != "80k"})
    k1 = [{"volume": vlabel(vol), "code": "lisp", "N41": lisp["desitter"][vol]["N41"], "k1": f["k1_bulk_mean"], "err": f["k1_bulk_sd"],
           "nbulk": f["nbulk"], "nmeas": f["nmeas"]} for vol, f in lisp["fluctuations"].items()]
    for vol in CPP_DS:
        v = lv[f"dS-{vol}"]
        m, sd, nb = v["k1_bulk"]
        k1.append({"volume": vlabel(vol), "code": "cpp", "N41": v["N41"], "k1": m, "err": sd, "nbulk": nb, "nmeas": v["nmeas"]})
    return {"published": {"xi": targets["values"]["xi"], "k1": targets["values"]["k1"]},
            "err_note": "xi err: autocorrelation-corrected standard error; k1 err: spread (sd) of k1_i over the bulk slices",
            "xi": xi, "k1": k1}


# --------------------------------------------------------------------------- 2D curvature
def interp(xs, ys, x):
    if x <= xs[0]:
        return ys[0]
    for j in range(1, len(xs)):
        if x <= xs[j]:
            t = (x - xs[j - 1]) / (xs[j] - xs[j - 1])
            return ys[j - 1] + t * (ys[j] - ys[j - 1])
    return ys[-1]


def build_curvature(src):
    res = src.json(f"{CURV}/results.json")
    dt = src.json(f"{CURV}/results_dt.json")
    lat = src.json(f"{CURV}/lattice_ref.json")
    sph = src.json(f"{CURV}/sphere_ref.json")
    figs = src.json(f"{CURV}/paper_figs.json")
    sets = []
    for sid, s in res["sets"].items():
        kind, vol = sid.split("-")
        sets.append({"id": sid, "distance": {"link": "link", "dual": "dual link", "bug": "link"}[kind],
                     "sampler": "original 2d-cdt v1.0.0 (acceptance bug)" if kind == "bug" else "fixed (cdt/2d)",
                     "N2": int(vol[:-1]) * 1000, "delta": list(range(1, len(s["mean"]) + 1)), "mean": s["mean"], "err": s["err"],
                     "nchains": s["nchains"], "nmeas": s["nmeas"], "half_z_max": s["half_z_max"], "paper_cmp": s.get("paper")})
    paper = {}
    for fig, distance in (("fig5", "link"), ("fig7", "dual link")):
        curves = []
        for label, pts in figs[fig].items():
            if label == "calibration":
                continue
            d = sorted(int(k) for k in pts)
            curves.append({"label": label, "N2": None if label == "hexagonal" else int(label[:-1]) * 1000,
                           "delta": d, "value": [pts[str(k)] for k in d]})
        paper[fig] = {"distance": distance, "curves": curves}
    paper["fig5"]["note"] = "legend: 50k, 90k, 150k, 350k at tau = 183 and 600k at tau = 243 (the text says 50k, 70k, 150k, 250k)"
    refs = {D: {"x": [p[0] for p in pts], "f": [p[1] for p in pts]} for D, pts in sph.items()}
    runs = []
    for n, r in dt.items():
        if not n.isdigit():
            continue
        y5 = r["mean"][4]
        curves = {}
        for key, fr in r["fits"].items():
            D, shift = key[1], key[2]
            xs, fs = refs[D]["x"], refs[D]["f"]
            f5 = interp(xs, fs, 5 / fr["rho"])
            d = [2 + 0.5 * j for j in range(27)]
            f = [interp(xs, fs, x / fr["rho"]) for x in d]
            curves[key] = {"delta": d, "value": [v + y5 - f5 for v in f] if shift == "+" else [v * y5 / f5 for v in f]}
        runs.append({"N": int(n), "delta": list(range(1, len(r["mean"]) + 1)), "mean": r["mean"], "err": r["err"],
                     "nchains": r["nchains"], "nmeas": r["nmeas"], "fits": r["fits"], "fit_curves": curves})
    return {"cdt": {"arxiv": "2110.11100", "sets": sets, "bug_vs_fixed": {"fixed": "link-50k", "bug": "bug-50k", **res["bug_vs_fixed_50k"]},
                    "lattice_flat": {"link": {"delta": list(range(1, len(lat["link"]) + 1)), "value": lat["link"]},
                                     "dual": {"delta": list(range(1, len(lat["dual"]) + 1)), "value": lat["dual"]},
                                     "check_vs_paper": res["lattice"]},
                    "paper": paper},
            "dt": {"arxiv": "1802.10524", "runs": runs, "scaling": dt["scaling"],
                   "sphere_ref": refs, "fit_rule": "rho minimises chi^2 over delta = 6..15 after shifting f_D(delta/rho) through the "
                                                   "data at delta = 5, additively (+) or multiplicatively (x)"}}


# --------------------------------------------------------------------------- markdown helpers
LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
ARXIV = re.compile(r"^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?/\d{7})$")


def plain(md):
    """markdown inline -> plain text; links keep their text only (the targets are local files)"""
    s = LINK.sub(r"\1", md)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"\1", s)
    return s.replace("`", "").strip()


def link_ids(md):
    return [t for t, _ in LINK.findall(md) if ARXIV.match(t)]


def table_rows(lines):
    rows = []
    for ln in lines:
        if ln.startswith("|") and not re.match(r"^\|[-\s|]+\|$", ln):
            rows.append([c.strip() for c in ln.strip().strip("|").split("|")])
    return rows[1:]  # drop the header


def bullets(lines):
    """top-level '- ' bullets with their indented sub-bullets"""
    out = []
    for ln in lines:
        if ln.startswith("- "):
            out.append({"md": ln[2:], "sub": []})
        elif re.match(r"^\s+- ", ln) and out:
            out[-1]["sub"].append(ln.strip()[2:])
        elif ln.strip() and out and not ln.startswith(("#", "|")):
            out[-1]["md"] += " " + ln.strip()
    return out


def sections(text, level):
    """{heading: [lines]} for headings of exactly `level` #'s (in order)"""
    out, cur = {}, None
    for ln in text.splitlines():
        m = re.match(r"^(#+) (.*)$", ln)
        if m and len(m.group(1)) <= level:
            cur = m.group(2).strip() if len(m.group(1)) == level else None
            if cur is not None:
                out[cur] = []
        elif cur is not None:
            out[cur].append(ln)
    return out


# --------------------------------------------------------------------------- targets
def need_match(pattern, text, what):
    m = re.search(pattern, text)
    if not m:
        raise SyncError(f"TARGETS.md: could not find {what} (pattern {pattern!r}); has the file changed?")
    return m


def build_targets(src):
    text = src.text(f"{LISP_VAL}/TARGETS.md")
    head = text.split("\n## ")[0].splitlines()
    refs = []
    for row in table_rows([ln for ln in head if ln.startswith("|")]):
        refs.append({"tag": row[0].strip("[]"), "arxiv": row[1], "citation": plain(row[2])})
    tag2arxiv = {r["tag"]: r["arxiv"] for r in refs}
    sec2 = sections(text, 2)
    conventions = [{"text": plain(b["md"]), "sub": [plain(s) for s in b["sub"]]}
                   for b in bullets(sec2["Simulation conventions in the papers"])]
    targets = []
    for title, lines in sections(text, 3).items():
        m = re.match(r"^(T\d)\. (.*?)(?: \((.*)\))?$", title)
        if not m:
            continue
        tags = re.findall(r"\[(\w+)\]", m.group(3) or "")
        body = lines
        items = []
        for b in bullets(body):
            lm = re.match(r"^\*\*(.+?):?\*\*:?\s*(.*)$", b["md"])
            items.append({"label": plain(lm.group(1)).rstrip(":") if lm else None, "text": plain(lm.group(2) if lm else b["md"]),
                          "sub": [plain(s) for s in b["sub"]]})
        paras = [plain(ln) for ln in body if ln.strip() and not ln.startswith(("-", " "))]
        targets.append({"id": m.group(1), "title": m.group(2), "refs": m.group(3), "arxiv": [tag2arxiv[t] for t in tags if t in tag2arxiv],
                        "items": items, "text": paras})
    if [t["id"] for t in targets] != ["T1", "T2", "T3", "T4", "T5"]:
        raise SyncError(f"TARGETS.md: expected targets T1..T5, found {[t['id'] for t in targets]}")

    g = lambda p, w: need_match(p, text, w)  # noqa: E731
    ac = g(r"first order, at κ0 = (\d+(?:\.\d+)?) for Δ=(\d+(?:\.\d+)?), N4 = (\d+)k", "A-C transition")
    jump = g(r"N0/N4 jumps between about (\d+(?:\.\d+)?) and (\d+(?:\.\d+)?)", "A-C N0/N4 jump")
    bc = g(r"at Δ = (\d+(?:\.\d+)?) for κ0=(\d+(?:\.\d+)?), N4 = (\d+)k", "B-C transition")
    s0 = g(r"\*\*s0 = (\d+(?:\.\d+)?)\*\*", "s0")
    s0r = g(r"verified for N4 = (\d+(?:\.\d+)?)k–(\d+)k", "s0 volume range")
    dh = g(r"D_H ≈ (\d+(?:\.\d+)?) ± (\d+(?:\.\d+)?)", "D_H")
    dsf = g(r"at N4 = (\d+)k .*?\*\*D_S\(σ\) = (\d+(?:\.\d+)?) − (\d+)/\((\d+)\+σ\)\*\* on σ ∈ \[(\d+), (\d+)\]", "D_S fit")
    dsi = g(r"D_S\(∞\) = (\d+(?:\.\d+)?) ± (\d+(?:\.\d+)?)", "D_S(inf)")
    ds0 = g(r"D_S\(0\) = (\d+(?:\.\d+)?) ± (\d+(?:\.\d+)?)", "D_S(0)")
    k1 = g(r"\*\*k1 = (\d+(?:\.\d+)?)\*\*", "k1")
    stalk = g(r"s ≈ (\d+(?:\.\d+)?), so N3 ≈ s/2 ≈ (\d+(?:\.\d+)?)", "stalk")
    ratio = g(r"N4/N41 is ([\d., and]+?) for Ñ4 = ([\dk, and]+?) \(\[R\] Table 1\)", "N4/N41 table")
    ratios = [float(x) for x in re.findall(r"[\d.]+\d", ratio.group(1))]
    vols = [int(x) * 1000 for x in re.findall(r"(\d+)k", ratio.group(2))]
    if len(ratios) != len(vols):
        raise SyncError("TARGETS.md: N4/N41 table does not parse into matching lists")
    f = float
    values = {
        "s0": {"value": f(s0.group(1)), "N4_range": [round(f(s0r.group(1)) * 1000), int(s0r.group(2)) * 1000], "arxiv": tag2arxiv["dS"], "target": "T2"},
        "stalk": {"s": f(stalk.group(1)), "N3_per_slice": f(stalk.group(2)), "arxiv": [tag2arxiv["R"], tag2arxiv["Rev"]], "target": "T2"},
        "AC_transition": {"kappa0": f(ac.group(1)), "Delta": f(ac.group(2)), "N4": int(ac.group(3)) * 1000, "order": "first",
                          "N0_N4_jump": [f(jump.group(1)), f(jump.group(2))], "arxiv": tag2arxiv["Rev"], "target": "T1"},
        "BC_transition": {"Delta": f(bc.group(1)), "kappa0": f(bc.group(2)), "N4": int(bc.group(3)) * 1000, "order": "second",
                          "arxiv": tag2arxiv["Rev"], "target": "T1"},
        "D_H": {"value": f(dh.group(1)), "err": f(dh.group(2)), "arxiv": tag2arxiv["R"], "target": "T3"},
        "D_S_fit": {"a": f(dsf.group(2)), "b": f(dsf.group(3)), "c": f(dsf.group(4)), "N4": int(dsf.group(1)) * 1000,
                    "sigma_range": [int(dsf.group(5)), int(dsf.group(6))], "D_S_inf": [f(dsi.group(1)), f(dsi.group(2))],
                    "D_S_0": [f(ds0.group(1)), f(ds0.group(2))], "arxiv": [tag2arxiv["S"], tag2arxiv["R"]], "target": "T4"},
        "k1": {"value": f(k1.group(1)), "arxiv": tag2arxiv["dS"], "target": "T5"},
        "xi": [{"N41": v, "N4_over_N41": r, "xi": round(r - 1, 6), "arxiv": tag2arxiv["R"]} for v, r in zip(vols, ratios)],
    }
    return {"source": "3p1_mh/validation/TARGETS.md", "refs": refs, "conventions": conventions, "targets": targets, "values": values}


# --------------------------------------------------------------------------- references
def parse_bib(text):
    entries, i = [], 0
    while True:
        i = text.find("@", i)
        if i < 0:
            return entries
        j = text.index("{", i)
        etype = text[i + 1:j].strip().lower()
        depth, k = 0, j
        while True:
            if text[k] == "{":
                depth += 1
            elif text[k] == "}":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        body = text[j + 1:k]
        key, rest = body.split(",", 1)
        fields, p = {}, 0
        while True:
            m = re.compile(r"\s*(\w+)\s*=\s*").match(rest, p)
            if not m:
                break
            p = m.end()
            if rest[p] == "{":
                d, q = 0, p
                while True:
                    if rest[q] == "{":
                        d += 1
                    elif rest[q] == "}":
                        d -= 1
                        if d == 0:
                            break
                    q += 1
                val, p = rest[p + 1:q], q + 1
            elif rest[p] == '"':
                q = rest.index('"', p + 1)
                val, p = rest[p + 1:q], q + 1
            else:
                q = re.compile(r"[,\n]").search(rest, p)
                q = q.start() if q else len(rest)
                val, p = rest[p:q].strip(), q
            fields[m.group(1).lower()] = val
            c = re.compile(r"\s*,").match(rest, p)
            if not c:
                break
            p = c.end()
        entries.append({"type": etype, "key": key.strip(), **fields})
        i = k + 1


def bib_text(s):
    s = re.sub(r"[{}]", "", s or "")
    return re.sub(r"\s+", " ", s).strip()


def bib_authors(s):
    out = []
    for a in re.split(r"\s+and\s+", bib_text(s)):
        if a == "others":
            out.append("et al.")
        elif "," in a:
            last, first = [x.strip() for x in a.split(",", 1)]
            out.append(f"{first} {last}".strip())
        else:
            out.append(a)
    return out


def build_references(src):
    bib = parse_bib(src.text("references/references.bib"))
    index = src.text("references/INDEX.md")
    cats, meta = [], {}
    for head, lines in sections(index, 2).items():
        m = re.match(r"^([A-Z])\. (.*?) \((\d+)\)$", head)
        if not m:
            raise SyncError(f"references/INDEX.md: unexpected section heading {head!r}")
        rows = table_rows([ln for ln in lines if ln.startswith("|")])
        if len(rows) != int(m.group(3)):
            raise SyncError(f"references/INDEX.md: section {m.group(1)} says {m.group(3)} papers, table has {len(rows)}")
        cats.append({"id": m.group(1), "name": m.group(2), "count": len(rows)})
        for order, row in enumerate(rows):
            if len(row) != 5 or not LINK.match(row[0]):
                raise SyncError(f"references/INDEX.md: malformed row {row!r}")
            ident = LINK.match(row[0]).group(1)
            meta[ident] = {"category": m.group(1), "order": order, "note": plain(row[4]) or None,
                           "authors_short": row[2]}
    entries = []
    for e in bib:
        ident = e.get("eprint") or e["key"]
        if ident not in meta:
            raise SyncError(f"references.bib entry {e['key']} has no row in references/INDEX.md")
        m = meta.pop(ident)
        entries.append({"key": e["key"], "title": bib_text(e.get("title")), "authors": bib_authors(e.get("author")),
                        "authors_short": m["authors_short"], "year": int(e["year"]) if e.get("year") else None,
                        "arxiv": e.get("eprint"), "primary_class": e.get("primaryclass"), "doi": e.get("doi"),
                        "journal": bib_text(e.get("journal")) or None, "category": m["category"], "note": m["note"],
                        "_order": (m["category"], m["order"])})
    if meta:
        raise SyncError(f"references/INDEX.md rows without a references.bib entry: {sorted(meta)}")
    entries.sort(key=lambda x: x.pop("_order"))
    return {"source": "references/references.bib, references/INDEX.md", "categories": cats, "entries": entries}


def build_reading(src, bib_keys):
    text = src.text("notes/READING.md")
    sec = sections(text, 2)
    books = [{"topic": r[0], "books": plain(r[1]), "use": None if r[2] in ("—", "-", "") else plain(r[2])}
             for r in table_rows([ln for ln in sec["Textbooks (background)"] if ln.startswith("|")])]

    def refs_of(md):
        ids = [t for t, _ in LINK.findall(md) if ARXIV.match(t) or t in bib_keys]
        return [{"id": t, "key": f"arXiv:{t}" if ARXIV.match(t) else t, "arxiv": t if ARXIV.match(t) else None} for t in ids]

    steps, cur = [], None
    for ln in sec["CDT papers, in reading order"]:
        m = re.match(r"^(\d+)\. \*\*(.+?):?\*\*:?\s*(.*)$", ln)
        if m:
            cur = {"n": int(m.group(1)), "title": m.group(2).rstrip(":"), "md": m.group(3), "items": [], "after": []}
            steps.append(cur)
        elif cur and re.match(r"^\s+- ", ln):
            cur["items"].append(ln.strip()[2:])
        elif cur and ln.strip():
            cur["after"].append(ln.strip())
    out_steps = []
    for s in steps:
        md_all = " ".join([s["md"]] + s["items"] + s["after"])
        refs = refs_of(md_all)
        for r in refs:
            if r["key"] not in bib_keys:
                raise SyncError(f"notes/READING.md cites {r['id']}, which is not in references.bib")
        out_steps.append({"n": s["n"], "title": s["title"], "text": plain(s["md"]),
                          "items": [{"text": plain(i), "refs": refs_of(i)} for i in s["items"]],
                          "after": [plain(a) for a in s["after"]], "refs": refs,
                          "arxiv": [r["arxiv"] for r in refs if r["arxiv"]]})
    if [s["n"] for s in out_steps] != list(range(1, len(out_steps) + 1)) or not out_steps:
        raise SyncError("notes/READING.md: reading steps are not numbered 1..n")
    online = [plain(b["md"]) for b in bullets(sec.get("Online resources mentioned in the notes", []))]
    return {"source": "notes/READING.md", "textbooks": books, "steps": out_steps, "online_unchecked": online}


# --------------------------------------------------------------------------- figures
FIG_DIRS = ((f"{LISP_VAL}/fig", "lisp-validation"), (f"{LV}/fig", "large-volume"), (f"{CURV}/fig", "curvature2d"))


def copy_figures(src, produced):
    for rel, dest in FIG_DIRS:
        sdir = src.path(rel)
        pngs = sorted(f for f in os.listdir(sdir) if f.lower().endswith(".png"))
        if not pngs:
            raise SyncError(f"no PNG figures in {rel}")
        ddir = os.path.join(FIGS, dest)
        os.makedirs(ddir, exist_ok=True)
        for old in os.listdir(ddir):  # this script owns these folders: drop figures removed upstream
            if old.lower().endswith(".png") and old not in pngs:
                os.remove(os.path.join(ddir, old))
        for f in pngs:
            shutil.copyfile(os.path.join(sdir, f), os.path.join(ddir, f))
            produced.append(os.path.join(ddir, f))


# --------------------------------------------------------------------------- manifest
def git(src, *args):
    try:
        return subprocess.run(["git", "-C", src.root, *args], check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as e:
        raise SyncError(f"git {' '.join(args)} failed in {src.root}: {e}")


INPUTS = [f"{LISP_VAL}/summary.json", f"{LISP_VAL}/TARGETS.md", f"{LV}/results.json",
          *(f"{CURV}/{n}.json" for n in ("results", "results_dt", "lattice_ref", "sphere_ref", "paper_figs")),
          "references/references.bib", "references/INDEX.md", "notes/READING.md"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="path to the CDT_4d-master research repo")
    args = ap.parse_args()
    src = Source(args.source)
    for rel in INPUTS:
        src.path(rel)
    commit, branch = git(src, "rev-parse", "HEAD"), git(src, "rev-parse", "--abbrev-ref", "HEAD")
    dirty = git(src, "status", "--porcelain", "--", *INPUTS)

    os.makedirs(DATA, exist_ok=True)
    produced = []
    lisp = src.json(f"{LISP_VAL}/summary.json")
    lv = src.json(f"{LV}/results.json")
    for k in ("desitter", "phases", "fluctuations", "spectral"):
        if k not in lisp:
            raise SyncError(f"{LISP_VAL}/summary.json has no '{k}' section")

    print("targets"); targets = build_targets(src); write_json("targets.json", targets, produced)
    print("desitter"); write_json("desitter.json", build_desitter(src, lisp, lv, targets), produced)
    print("spectral"); write_json("spectral.json", build_spectral(src, lisp, lv), produced)
    print("phases"); write_json("phases.json", build_phases(src, lisp, lv), produced)
    print("fluctuations"); write_json("fluctuations.json", build_fluctuations(lisp, lv, targets), produced)
    print("curvature2d"); write_json("curvature2d.json", build_curvature(src), produced)
    print("references"); refs = build_references(src); write_json("references.json", refs, produced)
    print("reading"); write_json("reading.json", build_reading(src, {e["key"] for e in refs["entries"]}), produced)
    print("figures"); copy_figures(src, produced)

    files = [{"path": os.path.relpath(p, SITE).replace(os.sep, "/"), "bytes": os.path.getsize(p)} for p in produced]
    manifest = {"source_repo": os.path.basename(src.root), "commit": commit, "branch": branch,
                "inputs_uncommitted_changes": dirty.splitlines() if dirty else [],
                "generated_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
                "script": "tools/sync_from_cdt.py", "files": files}
    with open(os.path.join(DATA, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
        f.write("\n")
    files.append({"path": "data/manifest.json", "bytes": os.path.getsize(os.path.join(DATA, "manifest.json"))})

    print(f"\nsource {commit[:12]} ({branch}){'  [inputs have uncommitted changes]' if dirty else ''}")
    for f in files:
        print(f"  {f['bytes'] / 1024:8.1f} KB  {f['path']}")
    big = [f["path"] for f in files if f["path"].endswith(".json") and f["bytes"] > 200 * 1024]
    if big:
        print(f"warning: over 200 KB: {', '.join(big)}")


if __name__ == "__main__":
    try:
        main()
    except SyncError as e:
        sys.exit(f"sync_from_cdt: error: {e}")
