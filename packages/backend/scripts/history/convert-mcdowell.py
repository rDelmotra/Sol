#!/usr/bin/env python3
"""
Convert Jonathan McDowell's historical element archive (XTLE text files, one per object, fetched by fetch-mcdowell.py) into the
per-day element-set files the Orbitwatch history tooling reads (the layout of convert.py). Python standard library only; `python3 -I`.

    python3 -I convert-mcdowell.py --in DIR --out OUT [--from 1957-10-04] [--to 1979-12-31] [--keep-problems ED,EI] [--no-brouwer]
    python3 -I convert-mcdowell.py --kozai-from-brouwer N_REV_DAY ECC INC_DEG        (prints the converted mean motion; used by tests)

Input: DIR/<folder>/<file>[.gz] as written by fetch-mcdowell.py (only S-catalogue files S00001.. are converted: A/C/F/R/T objects
have no NORAD number). Format: https://planet4589.org/space/xtle.html (XTLE1 lines 1/2 = TLE columns, optional line 0, line 3 =
provenance: flavour, ORIGIN, PROBLEM, ELTYPE, FRAME, TSYS, PRIMARY, SOURCE).

Output (OUT):
    elsets/YYYY/YYYY-MM-DD.jsonl.gz   one OMM object per line (convert.py's 17 fields + provenance), ordered by (NORAD id, epoch)
    objects.jsonl.gz                  noradId, name ('NORAD n'; names / types come from the mirror's objects file at merge time),
                                      firstEpoch, lastEpoch, nSets
    stats.json                        counts: sets read, kept, skipped by reason, cross-tags, Brouwer sets, origins, problem codes,
                                      eltype / frame / tsys values, per year

Rules (each is counted in stats.json):
  * object identity = the FILE's object (S00485 -> 485). The archive moved cross-tagged TLEs to the file of the object they really
    describe but usually kept the wrong number inside the TLE (ele.html, Apr 2022). Such sets get XTLE_TLE_NUMBER = the number in the TLE.
  * XTLE3 (flavour 3: hyperbolic, non-Earth, 9-digit numbers) is skipped; so is any set whose PRIMARY is not Earth, whose FRAME is not
    TEME or whose TSYS is not UTC (counted per value; none of these survive into the per-day files).
  * PROBLEM codes (xtle.html): N null, S shape only, G guess, EM cross-tagged, EW wrong, EC corrupted, EP predicted, E (bare: wrong in
    some way) are skipped; EI (inaccurate but valid) and ED (doubtful) are kept unless absent from --keep-problems (default EI,ED);
    I / O are not problems (kept). Kept problem sets carry XTLE_PROBLEM.
  * EPHTYPE 2 = Brouwer mean motion (1962-1964 sets so marked by McDowell). SGP and SGP4 both expect the Kozai mean motion, so
    MEAN_MOTION is converted Brouwer -> Kozai (kozai_from_brouwer below), the source value is kept in MEAN_MOTION_BROUWER and
    EPHEMERIS_TYPE is written 0 (the elements are now conventional); XTLE_EPHTYPE keeps the source value. --no-brouwer writes the
    source mean motion unchanged (for the attribution measurement only).
  * NDOT (rev/day^2, the TLE field = ndot/2) -> MEAN_MOTION_DOT. NDOT2 (TLE field = nddot/6, rev/day^3) is kept in XTLE_NDDOT
    (when non-zero) and MEAN_MOTION_DDOT is written 0 by default: measured on the sample (1959-1985 chain check, SGP with vs without
    it), NDOT2 never improved the median and made the p95 worse in 1963-1967 (e.g. 1965 p95 451 km without vs 634 km with the
    plausible values only). The ratio |NDOT2| / |NDOT| is bimodal: < 1 /day for real values and 1e2 .. 1e5 /day for a block of
    1964-1967 sets (e.g. Echo 1, 1965: NDOT 5.34e-6, NDOT2 0.215) that put SGP thousands of km off. --use-nddot writes NDOT2 to
    MEAN_MOTION_DDOT where |NDOT2| <= --nddot-max-ratio (10) x |NDOT| per day (larger values counted 'nddotImplausible').
    BSTAR -> BSTAR, ELNO -> ELEMENT_SET_NO, rev number -> REV_AT_EPOCH. Epochs: UTC, truncated to milliseconds (convert.py's form).
  * duplicates: identical (object, epoch, elements) lines are collapsed; different sets at the same (object, epoch) are all dropped
    except the first in file order (counted 'sameEpochConflict'; the merge step's outlier filter judges the rest).
  * unusable numbers (non-finite, e outside [0, 1), n <= 0) are skipped ('badNumbers'); unparseable lines are counted ('unparseable').
    A line 1 whose NDOT2 / BSTAR columns cannot be read (value one column off, seen in 1964-1976) keeps its set with both = 0
    (XTLE_DRAG_FIELDS_UNREADABLE, counted 'dragFieldsUnreadable').

Brouwer -> Kozai (the inverse of SGP4's initialisation step that recovers the Brouwer mean motion n'' from the TLE's Kozai n0:
Hoots & Roehrich, Spacetrack Report No. 3 (1980), SGP4 section eqs. for a1, delta1, a0, delta0, n0''; same as `initl` in
Vallado, Crawford, Hujsak & Kelso, "Revisiting Spacetrack Report #3", AIAA 2006-6753, and its sgp4unit / satellite.js port):
    a1 = (ke / n0)^(2/3),  d1 = 3/2 k2 (3 cos^2 i - 1) / (a1^2 (1 - e^2)^(3/2)),  a0 = a1 (1 - d1/3 - d1^2 - 134/81 d1^3),
    d0 = 3/2 k2 (3 cos^2 i - 1) / (a0^2 (1 - e^2)^(3/2)),  n0'' = n0 / (1 + d0)
with ke = 0.0743669161 er^(3/2)/min, k2 = J2/2 = 5.413080e-4 (WGS-72, the TLE constants). Given n'' we solve n0 = n'' (1 + d0(n0))
by fixed-point iteration (|d0| ~ 1e-3: converges to 1e-15 relative in < 10 steps).
"""
import argparse
import glob
import gzip
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

KE = 0.0743669161
K2 = 5.413080e-4
SKIP_PROBLEMS = {'N', 'S', 'G', 'E', 'EM', 'EW', 'EC', 'EP'}
NOT_PROBLEMS = {'', 'I', 'O'}
FILE_RE = re.compile(r'^S(\d{5,9})(\.gz)?$')
PACKED_RE = re.compile(r'^([+-]?)(\d{1,5})([+-]\d)$')


# ------------------------------------------------------------------ Brouwer <-> Kozai
def _d0(n0_rad_min, ecc, inc_rad):
    a1 = (KE / n0_rad_min) ** (2.0 / 3.0)
    c = 1.5 * K2 * (3 * math.cos(inc_rad) ** 2 - 1) / (1 - ecc * ecc) ** 1.5
    d1 = c / (a1 * a1)
    a0 = a1 * (1 - d1 / 3 - d1 * d1 - 134.0 / 81.0 * d1 ** 3)
    return c / (a0 * a0)


def brouwer_from_kozai(n_rev_day, ecc, inc_deg):
    """SGP4's un-Kozai step (Spacetrack Report #3 / Vallado 2006 initl): Kozai mean motion -> Brouwer mean motion, rev/day."""
    n0 = n_rev_day * 2 * math.pi / 1440.0
    return n0 / (1 + _d0(n0, ecc, math.radians(inc_deg))) * 1440.0 / (2 * math.pi)


def kozai_from_brouwer(n_rev_day, ecc, inc_deg):
    """Inverse of brouwer_from_kozai by fixed-point iteration: the Kozai mean motion whose SGP4 un-Kozai value is n_rev_day."""
    nb = n_rev_day * 2 * math.pi / 1440.0
    i = math.radians(inc_deg)
    n0 = nb
    for _ in range(50):
        nxt = nb * (1 + _d0(n0, ecc, i))
        if abs(nxt - n0) <= 1e-15 * nb:
            n0 = nxt
            break
        n0 = nxt
    return n0 * 1440.0 / (2 * math.pi)


# ------------------------------------------------------------------ XTLE parsing
def packed(s):
    """'+65942-4' / ' 00000-0' / '-11606-4' -> float (S x 0.M x 10^E); '' -> 0."""
    t = s.strip().replace(' ', '')
    if not t:
        return 0.0
    m = PACKED_RE.match(t)
    if not m:
        return float(t)  # some hand-made sets write a plain number
    v = float('0.' + m.group(2)) * 10 ** int(m.group(3))
    return -v if m.group(1) == '-' else v


def fnum(s):
    t = s.strip()
    return float(t) if t else 0.0


def epoch_of(field):
    """'58032.15833000' -> aware datetime (UTC). Two-digit years 57-99 -> 19xx, 00-56 -> 20xx (TLE convention)."""
    t = field.strip()
    yy = int(t[:2])
    doy = float(t[2:])
    year = 1900 + yy if yy >= 57 else 2000 + yy
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1)


def iso_ms(dt):
    us = dt.microsecond // 1000 * 1000
    return dt.replace(microsecond=us).strftime('%Y-%m-%dT%H:%M:%S.') + f'{us // 1000:03d}Z'


def parse_line3(l3):
    l3 = l3.ljust(110)
    return {
        'flavour': l3[12:13].strip() or '1', 'origin': l3[14:20].strip(), 'problem': l3[21:23].strip(), 'eltype': l3[24:28].strip() or 'SGP4',
        'frame': l3[29:33].strip() or 'TEME', 'tsys': l3[34:38].strip() or 'UTC', 'primary': l3[39:69].strip() or 'Earth', 'source': l3[70:110].strip(),
    }


DEFAULT_L3 = {'flavour': '1', 'origin': '', 'problem': '', 'eltype': 'SGP4', 'frame': 'TEME', 'tsys': 'UTC', 'primary': 'Earth', 'source': ''}


def parse_xtle1(l1, l2):
    """Lines 1 / 2 (TLE columns) -> dict of numbers; raises ValueError on unparseable fields."""
    l1, l2 = l1.ljust(69), l2.ljust(69)
    num1 = l1[2:7].strip()
    ep = epoch_of(l1[18:32])
    eph = l1[62:63].strip()
    elno = l1[64:68].strip()
    rev = l2[63:68].strip()
    try:
        nddot, bstar, shifted = packed(l1[44:52]), packed(l1[53:61]), False
    except ValueError:
        # a few 1964-1976 lines carry the packed NDOT2 / BSTAR value one column off (e.g. S00043 1965: '...  .00001214            19251-8   1679');
        # which field it belongs to cannot be told, so both are taken as 0 (the era's sets have B* = 0; NDOT2 is not used by default)
        nddot, bstar, shifted = 0.0, 0.0, True
    return {
        'tle_number': int(num1) if num1.isdigit() else None,
        'prefix': l1[1:2].strip() or 'S',
        'epoch': ep,
        'ndot': fnum(l1[33:43]),
        'nddot': nddot,
        'bstar': bstar,
        'shifted': shifted,
        'ephtype': int(eph) if eph.isdigit() else 0,
        'elno': int(elno) if elno.isdigit() else 0,
        'inc': fnum(l2[8:16]),
        'raan': fnum(l2[17:25]),
        'ecc': float('0.' + l2[26:33].strip().replace(' ', '0')) if l2[26:33].strip() else 0.0,
        'argp': fnum(l2[34:42]),
        'ma': fnum(l2[43:51]),
        'n': fnum(l2[52:63]),
        'rev': int(rev) if rev.isdigit() else 0,
    }


def read_sets(text):
    """Yield (line1, line2, line3|None) triples of a file; stray lines are counted by the caller via the 'orphan' marker."""
    pend1 = pend2 = None
    for raw in text.splitlines():
        line = raw.rstrip('\r\n')
        if not line.strip():
            continue
        k = line[0]
        if k == '1':
            if pend1 and pend2:
                yield pend1, pend2, None
            elif pend1:
                yield 'orphan', pend1, None
            pend1, pend2 = line, None
        elif k == '2':
            if pend1 and not pend2:
                pend2 = line
            else:
                yield 'orphan', line, None
        elif k == '3':
            if pend1 and pend2:
                yield pend1, pend2, line
                pend1 = pend2 = None
            else:
                yield 'orphan', line, None
        elif k == '0':
            continue  # optional human-readable line 0
        else:
            yield 'orphan', line, None
    if pend1 and pend2:
        yield pend1, pend2, None
    elif pend1:
        yield 'orphan', pend1, None


def file_text(path):
    data = open(path, 'rb').read()
    if path.endswith('.gz'):
        data = gzip.decompress(data)
    return data.decode('ascii', 'replace')


# ------------------------------------------------------------------ conversion
def convert(a):
    lo = datetime.fromisoformat(a.from_day).replace(tzinfo=timezone.utc)
    hi = datetime.fromisoformat(a.to_day).replace(tzinfo=timezone.utc) + timedelta(days=1)
    origins_keep = {x.strip() for x in a.origins.split(',')} if a.origins else None
    keep_problems = {p.strip().upper() for p in a.keep_problems.split(',') if p.strip()}
    st = Counter()
    per_year = defaultdict(Counter)
    origins, problems, eltypes, frames, tsyss, primaries, flavours = (Counter() for _ in range(7))
    xtag_objects = set()
    brouwer_objects = set()
    days = defaultdict(list)  # day -> [(norad, epoch iso, omm)]
    objs = {}
    files = []
    for p in sorted(glob.glob(os.path.join(a.inp, '*', '*'))):
        m = FILE_RE.match(os.path.basename(p))
        if m:
            files.append((int(m.group(1)), p))
        elif not os.path.basename(p).startswith('.') and not os.path.isdir(p):
            st['filesNotS'] += 1
    seen_all = {}
    for norad, path in files:
        st['files'] += 1
        seen = seen_all
        for l1, l2, l3 in read_sets(file_text(path)):
            if l1 == 'orphan':
                st['orphanLines'] += 1
                continue
            st['setsRead'] += 1
            meta = parse_line3(l3) if l3 else dict(DEFAULT_L3)
            if not l3:
                st['noLine3'] += 1
            flavours[meta['flavour']] += 1
            if meta['flavour'] == '3':
                st['skipXtle3'] += 1
                continue
            try:
                s = parse_xtle1(l1, l2)
            except (ValueError, IndexError):
                st['unparseable'] += 1
                continue
            if s['shifted']:
                st['dragFieldsUnreadable'] += 1
            ep = s['epoch']
            if ep < lo or ep >= hi:
                st['outsideRange'] += 1
                continue
            y = ep.year
            per_year[y]['read'] += 1
            origins[meta['origin'] or '-'] += 1
            problems[meta['problem'] or '-'] += 1
            eltypes[meta['eltype']] += 1
            frames[meta['frame']] += 1
            tsyss[meta['tsys']] += 1
            primaries[meta['primary']] += 1
            if origins_keep is not None and (meta['origin'] or '-') not in origins_keep:
                st['skipOrigin'] += 1
                continue
            if meta['primary'] != 'Earth':
                st['skipPrimary'] += 1
                continue
            if meta['frame'] != 'TEME':
                st['skipFrame'] += 1
                continue
            if meta['tsys'] != 'UTC':
                st['skipTsys'] += 1
                continue
            pr = meta['problem'].upper()
            if pr not in NOT_PROBLEMS and (pr in SKIP_PROBLEMS or pr not in keep_problems):
                st['skipProblem'] += 1
                per_year[y]['skipProblem'] += 1
                continue
            vals = [s['n'], s['ecc'], s['inc'], s['raan'], s['argp'], s['ma'], s['ndot'], s['nddot'], s['bstar']]
            if not all(math.isfinite(v) for v in vals) or not (s['n'] > 0) or not (0 <= s['ecc'] < 1):
                st['badNumbers'] += 1
                continue
            n = s['n']
            omm_extra = {}
            nddot = s['nddot'] if a.use_nddot else 0.0
            if s['nddot'] != 0:
                omm_extra['XTLE_NDDOT'] = s['nddot']
                if abs(s['nddot']) > a.nddot_max_ratio * abs(s['ndot']):
                    st['nddotImplausible'] += 1
                    per_year[y]['nddotImplausible'] += 1
                    nddot = 0.0
            if s['ephtype'] == 2:
                st['brouwer'] += 1
                per_year[y]['brouwer'] += 1
                brouwer_objects.add(norad)
                if not a.no_brouwer:
                    n = kozai_from_brouwer(s['n'], s['ecc'], s['inc'])
                    omm_extra['MEAN_MOTION_BROUWER'] = s['n']
            elif s['ephtype'] != 0:
                st[f'ephtype{s["ephtype"]}'] += 1
            xtag = s['tle_number'] is not None and s['tle_number'] != norad
            if xtag:
                st['crossTag'] += 1
                per_year[y]['crossTag'] += 1
                xtag_objects.add(norad)
            obj = s['tle_number'] if xtag and a.identity == 'tle' else norad
            epoch = iso_ms(ep)
            sig = (round(n, 8), s['ecc'], s['inc'], s['raan'], s['argp'], s['ma'])
            key = (obj, epoch)
            if key in seen:
                if seen[key] == sig:
                    st['duplicateIdentical'] += 1
                else:
                    st['sameEpochConflict'] += 1
                    per_year[y]['sameEpochConflict'] += 1
                continue
            seen[key] = sig
            omm = {
                'OBJECT_NAME': f'NORAD {obj}', 'OBJECT_ID': None, 'EPOCH': epoch, 'MEAN_MOTION': n, 'ECCENTRICITY': s['ecc'],
                'INCLINATION': s['inc'], 'RA_OF_ASC_NODE': s['raan'], 'ARG_OF_PERICENTER': s['argp'], 'MEAN_ANOMALY': s['ma'],
                'EPHEMERIS_TYPE': 0 if s['ephtype'] == 2 and not a.no_brouwer else s['ephtype'], 'CLASSIFICATION_TYPE': 'U', 'NORAD_CAT_ID': obj,
                'ELEMENT_SET_NO': s['elno'], 'REV_AT_EPOCH': s['rev'], 'BSTAR': s['bstar'], 'MEAN_MOTION_DOT': s['ndot'], 'MEAN_MOTION_DDOT': nddot,
                'HIST_SRC': 'jcm', 'XTLE_ORIGIN': meta['origin'] or None, 'XTLE_ELTYPE': meta['eltype'], 'XTLE_FRAME': meta['frame'], 'XTLE_TSYS': meta['tsys'],
                **({'XTLE_PROBLEM': meta['problem']} if meta['problem'] else {}),
                **({'XTLE_EPHTYPE': s['ephtype']} if s['ephtype'] else {}),
                **({'XTLE_TLE_NUMBER': s['tle_number']} if xtag else {}),
                **({'XTLE_DRAG_FIELDS_UNREADABLE': True} if s['shifted'] else {}),
                **omm_extra,
            }
            days[epoch[:10]].append((obj, epoch, omm))
            st['kept'] += 1
            per_year[y]['kept'] += 1
            if s['nddot'] != 0:
                per_year[y]['nddotNonZero'] += 1
            o = objs.setdefault(obj, {'noradId': obj, 'name': f'NORAD {obj}', 'firstEpoch': epoch, 'lastEpoch': epoch, 'nSets': 0})
            o['firstEpoch'] = min(o['firstEpoch'], epoch)
            o['lastEpoch'] = max(o['lastEpoch'], epoch)
            o['nSets'] += 1
    if a.prefer_origins:
        pref = {x.strip() for x in a.prefer_origins.split(',') if x.strip()}
        has_pref = {(r[0], r[1][:4]) for rows in days.values() for r in rows if (r[2].get('XTLE_ORIGIN') or '-') in pref}
        for day in list(days):
            keep = []
            for r in days[day]:
                if (r[2].get('XTLE_ORIGIN') or '-') not in pref and (r[0], r[1][:4]) in has_pref:
                    st['skipNonPreferredOrigin'] += 1
                    per_year[int(r[1][:4])]['skipNonPreferredOrigin'] += 1
                    o = objs[r[0]]
                    o['nSets'] -= 1
                    continue
                keep.append(r)
            if keep:
                days[day] = keep
            else:
                del days[day]
        firsts, lasts = {}, {}
        for rows in days.values():
            for n_, e_, _ in rows:
                firsts[n_] = min(firsts.get(n_, e_), e_)
                lasts[n_] = max(lasts.get(n_, e_), e_)
        objs = {n_: {**o, 'firstEpoch': firsts[n_], 'lastEpoch': lasts[n_]} for n_, o in objs.items() if n_ in firsts}
    os.makedirs(os.path.join(a.out, 'elsets'), exist_ok=True)
    for day in sorted(days):
        rows = sorted(days[day], key=lambda r: (r[0], r[1]))
        ydir = os.path.join(a.out, 'elsets', day[:4])
        os.makedirs(ydir, exist_ok=True)
        final = os.path.join(ydir, f'{day}.jsonl.gz')
        tmp = final + f'.tmp-{os.getpid()}'
        text = ''.join(json.dumps(omm, separators=(',', ':')) + '\n' for _, _, omm in rows)
        with open(tmp, 'wb') as f:
            f.write(gzip.compress(text.encode('utf-8'), 6, mtime=0))  # mtime 0: identical input -> identical bytes
        os.replace(tmp, final)
    tmp = os.path.join(a.out, f'objects.jsonl.gz.tmp-{os.getpid()}')
    with open(tmp, 'wb') as f:
        f.write(gzip.compress(''.join(json.dumps(objs[k]) + '\n' for k in sorted(objs)).encode('utf-8'), 6, mtime=0))
    os.replace(tmp, os.path.join(a.out, 'objects.jsonl.gz'))
    stats = {
        'range': [a.from_day, a.to_day], 'counts': dict(st), 'crossTagObjects': len(xtag_objects), 'brouwerObjects': len(brouwer_objects),
        'origins': dict(origins), 'problems': dict(problems), 'eltypes': dict(eltypes), 'frames': dict(frames), 'tsys': dict(tsyss),
        'primaries': dict(primaries), 'flavours': dict(flavours), 'dayFiles': len(days), 'objects': len(objs),
        'perYear': {str(y): dict(c) for y, c in sorted(per_year.items())},
    }
    with open(os.path.join(a.out, 'stats.json'), 'w') as f:
        json.dump(stats, f, indent=1)
    print(json.dumps({k: v for k, v in stats.items() if k != 'perYear'}, indent=1))
    print('year   read   kept  problem  brouwer  crossTag  sameEpochConflict')
    for y, c in sorted(per_year.items()):
        print(f"{y} {c['read']:>6} {c['kept']:>6} {c['skipProblem']:>8} {c['brouwer']:>8} {c['crossTag']:>9} {c['sameEpochConflict']:>18}")


def main():
    if len(sys.argv) == 5 and sys.argv[1] == '--kozai-from-brouwer':
        n, e, i = map(float, sys.argv[2:])
        print(repr(kozai_from_brouwer(n, e, i)))
        return
    if len(sys.argv) == 5 and sys.argv[1] == '--brouwer-from-kozai':
        n, e, i = map(float, sys.argv[2:])
        print(repr(brouwer_from_kozai(n, e, i)))
        return
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--in', dest='inp', required=True, help="fetch-mcdowell.py's download directory")
    p.add_argument('--out', required=True)
    p.add_argument('--from', dest='from_day', default='1957-10-04')
    p.add_argument('--to', dest='to_day', default='1979-12-31', help='last UTC day converted (default 1979-12-31: the archive is for the pre-1980 era here)')
    p.add_argument('--keep-problems', default='EI,ED', help='PROBLEM codes kept (flagged); N,S,G,E,EM,EW,EC,EP are always skipped')
    p.add_argument('--no-brouwer', action='store_true', help='do NOT convert EPHTYPE 2 mean motions (attribution runs only)')
    p.add_argument('--use-nddot', action='store_true', help='write NDOT2 to MEAN_MOTION_DDOT (plausible values only); default 0 (measured: no gain)')
    p.add_argument('--nddot-max-ratio', type=float, default=10.0, help='with --use-nddot: NDOT2 used only when |NDOT2| <= this x |NDOT| per day')
    p.add_argument('--prefer-origins', default='NOR,SPTR',
                   help="per object and calendar year: when any set has one of these ORIGINs, sets of other origins are dropped ('' = keep all)")
    p.add_argument('--origins', help="keep only these ORIGIN values (e.g. 'NOR,SPTR'); default all")
    p.add_argument('--identity', choices=['file', 'tle'], default='file',
                   help="'file' (default): the object of the file (cross-tag corrected); 'tle': the number inside the TLE (attribution runs only)")
    a = p.parse_args()
    convert(a)


if __name__ == '__main__':
    main()
