#!/usr/bin/env python3
"""
Convert the third-party Space-Track GP-history mirror (yearly parquet files) into the per-day element-set files the Orbitwatch
history tooling reads.

    python3 -I convert.py --mirror data/tle_history/data --satcat data/satcat.parquet [--gcat data/gcat] --out OUT
                          [--years 1959-2026] [--threads 4] [--jobs 32] [--memory-limit 8GB] [--force]
    python3 -I convert.py --verify data/check/st-2026-03-14.json --mirror data/tle_history/data

Output (OUT):
    elsets/YYYY/YYYY-MM-DD.jsonl.gz   every element set whose epoch falls in that UTC day, one OMM JSON object per line, ordered by
                                      (NORAD id, epoch). Days without element sets have no file.
    objects.jsonl.gz                  one line per object: noradId, name, objectType, rcsSize, launchDate, decayDate, intlDesignator,
                                      owner, firstEpoch, lastEpoch, nSets
    .work/objects.parquet             static metadata used while converting (safe to delete afterwards)
    .work/months/YYYY-MM.json         per-month completion marker + row counts (restart skips months that have one)

OMM line fields (the names the app's element sets use): OBJECT_NAME, OBJECT_ID, EPOCH, MEAN_MOTION, ECCENTRICITY, INCLINATION,
RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, EPHEMERIS_TYPE (0), CLASSIFICATION_TYPE ('U'), NORAD_CAT_ID, ELEMENT_SET_NO (0),
REV_AT_EPOCH (0), BSTAR, MEAN_MOTION_DOT, MEAN_MOTION_DDOT (0).

Conventions
  * epoch: UTC, truncated to milliseconds, written 'YYYY-MM-DDTHH:MM:SS.mmmZ' (the app's form). A set belongs to the UTC day of its epoch.
  * FLOAT (32 bit) columns are widened through their shortest decimal text, so 98.05 stays 98.05 (not 98.0499954223633).
  * objectType uses the app's wire vocabulary: satellite | rocket_body | debris | unknown (PAYLOAD -> satellite, ROCKET BODY ->
    rocket_body, DEBRIS -> debris, anything else -> unknown).
  * rcsSize from rcs_m2 with Space-Track's RCS_SIZE definition: SMALL < 0.1 m2, MEDIUM 0.1 .. 1.0 m2, LARGE > 1.0 m2; no value -> null.
  * intl designator '98067A' -> '1998-067A' (2-digit year 57..99 -> 19yy, else 20yy).
  * duplicate (NORAD id, epoch) rows are collapsed (the app's omm_updates is unique on them); rows with non-finite elements are dropped;
    both are counted in the month markers.
Only duckdb is needed (no pandas / pyarrow).
"""
import argparse
import csv
import glob
import gzip
import json
import math
import multiprocessing as mp
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import duckdb

MONTHS = range(1, 13)
OMM_KEYS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER',
            'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR',
            'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT']


# ------------------------------------------------------------------ helpers
def sql_str(s):
    return "'" + str(s).replace("'", "''") + "'"


def sql_type(t):
    """OBJECT_TYPE text (any case) -> app vocabulary, as a SQL expression over column `t`."""
    return (f"CASE upper(trim(coalesce({t}, ''))) WHEN 'PAYLOAD' THEN 'satellite' WHEN 'PAY' THEN 'satellite' "
            f"WHEN 'ROCKET BODY' THEN 'rocket_body' WHEN 'R/B' THEN 'rocket_body' WHEN 'DEBRIS' THEN 'debris' WHEN 'DEB' THEN 'debris' ELSE 'unknown' END")


def sql_designator(d):
    """'98067A' -> '1998-067A'; anything else passes through unchanged (may be NULL)."""
    return (f"CASE WHEN regexp_matches({d}, '^[0-9]{{5}}[A-Z]{{1,3}}$') THEN "
            f"(CASE WHEN CAST(substr({d}, 1, 2) AS INTEGER) >= 57 THEN '19' ELSE '20' END) || substr({d}, 1, 2) || '-' || substr({d}, 3) "
            f"ELSE nullif(trim({d}), '') END")


def sql_f32(c):
    """FLOAT column -> DOUBLE through its shortest decimal text."""
    return f"CAST(CAST({c} AS VARCHAR) AS DOUBLE)"


def sql_epoch_iso(c):
    return f"strftime({c} AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%g') || 'Z'"


def parse_years(spec, available):
    if not spec:
        return sorted(available)
    out = set()
    for part in spec.split(','):
        if '-' in part:
            a, b = part.split('-')
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(part))
    return sorted(y for y in out if y in available)


def mirror_files(mirror):
    files = {}
    for p in glob.glob(os.path.join(mirror, 'tle_*.parquet')):
        m = re.search(r'tle_(\d{4})\.parquet$', p)
        if m:
            files[int(m.group(1))] = p
    return files


def connect(threads=None, memory=None):
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    if threads:
        con.execute(f'SET threads={int(threads)}')
    if memory:
        con.execute(f"SET memory_limit={sql_str(memory)}")
    return con


def atomic_write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp-{os.getpid()}'
    with open(tmp, 'w') as f:
        f.write(text)
    os.replace(tmp, path)


# ------------------------------------------------------------------ GCAT (McDowell) satcat.tsv
GCAT_MONTHS = {m: i + 1 for i, m in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])}


def gcat_date(s):
    """'1957 Oct  4 1912', '1997 Mar 14?', '2001 Jan' -> 'YYYY-MM-DD' (day 1 when only the month is known); None when unparseable."""
    if not s:
        return None
    m = re.match(r'^\s*(\d{4})\s+([A-Z][a-z]{2})(?:\s+(\d{1,2}))?', s)
    if not m or m.group(2) not in GCAT_MONTHS:
        return None
    return f'{int(m.group(1)):04d}-{GCAT_MONTHS[m.group(2)]:02d}-{int(m.group(3) or 1):02d}'


def gcat_type(code):
    c = (code or '').strip()[:1].upper()
    return {'P': 'satellite', 'R': 'rocket_body', 'D': 'debris'}.get(c)  # C (component), Z, X ... -> no opinion


def read_gcat_satcat(path):
    """{norad: {name, type, launch, decay}} from GCAT satcat.tsv. The header is the line starting '#JCAT'; other '#' lines are comments."""
    out = {}
    if not path or not os.path.exists(path):
        return out
    with open(path, newline='', encoding='utf-8', errors='replace') as f:
        header = None
        for line in f:
            line = line.rstrip('\n')
            if header is None:
                if line.startswith('#JCAT') or line.startswith('JCAT'):
                    header = [h.strip().lstrip('#') for h in line.split('\t')]
                continue
            if not line or line.startswith('#'):
                continue
            row = dict(zip(header, line.split('\t')))
            m = re.match(r'^\s*(\d+)', row.get('Satcat', ''))
            if not m:
                continue
            out[int(m.group(1))] = {
                'name': (row.get('Name') or '').strip() or None,
                'type': gcat_type(row.get('Type')),
                'launch': gcat_date(row.get('LDate')),
                'decay': gcat_date(row.get('DDate')),
            }
    return out


# ------------------------------------------------------------------ stage 1: static object metadata
def build_objects_parquet(satcat, gcat_dir, work):
    """satcat.parquet (+ GCAT fallbacks) -> work/objects.parquet (noradId, name, objectType, rcsSize, launchDate, decayDate, intl, owner)."""
    con = connect()
    cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet({sql_str(satcat)})").fetchall()}
    def c(name, default='NULL'):
        return name if name in cols else default
    con.execute(f"""CREATE TABLE st AS SELECT
        CAST({c('norad_id')} AS INTEGER) AS norad_id,
        nullif(trim(CAST({c('object_name')} AS VARCHAR)), '') AS name,
        {sql_type(c('object_type'))} AS otype,
        upper(trim(CAST({c('object_type')} AS VARCHAR))) AS otype_raw,
        CASE WHEN {c('rcs_m2')} IS NULL THEN NULL WHEN {c('rcs_m2')} < 0.1 THEN 'SMALL' WHEN {c('rcs_m2')} <= 1.0 THEN 'MEDIUM' ELSE 'LARGE' END AS rcs_size,
        strftime(TRY_CAST({c('launch_date')} AS DATE), '%Y-%m-%d') AS launch,
        strftime(TRY_CAST({c('decay_date')} AS DATE), '%Y-%m-%d') AS decay,
        nullif(trim(CAST({c('intl_designator')} AS VARCHAR)), '') AS intl,
        nullif(trim(CAST({c('owner')} AS VARCHAR)), '') AS owner
      FROM read_parquet({sql_str(satcat)}) WHERE {c('norad_id')} IS NOT NULL""")
    # one row per object (a satcat may repeat an id): keep the last by file order
    con.execute("CREATE TABLE st1 AS SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY norad_id ORDER BY (decay IS NOT NULL) DESC) AS rn FROM st) WHERE rn = 1")
    gc = read_gcat_satcat(os.path.join(gcat_dir, 'satcat.tsv')) if gcat_dir else {}
    con.execute("CREATE TABLE gc (norad_id INTEGER, name VARCHAR, otype VARCHAR, launch VARCHAR, decay VARCHAR)")
    if gc:
        con.executemany('INSERT INTO gc VALUES (?, ?, ?, ?, ?)', [(k, v['name'], v['type'], v['launch'], v['decay']) for k, v in gc.items()])
    # Space-Track first; GCAT only where Space-Track has no value (or says unknown / TBA)
    con.execute(f"""COPY (SELECT coalesce(s.norad_id, g.norad_id) AS norad_id,
        coalesce(s.name, g.name) AS name,
        CASE WHEN s.otype IS NOT NULL AND s.otype <> 'unknown' THEN s.otype ELSE coalesce(g.otype, 'unknown') END AS otype,
        s.rcs_size AS rcs_size,
        coalesce(s.launch, g.launch) AS launch,
        coalesce(s.decay, g.decay) AS decay,
        s.intl AS intl, s.owner AS owner
      FROM st1 s FULL OUTER JOIN gc g ON g.norad_id = s.norad_id) TO {sql_str(os.path.join(work, 'objects.parquet'))} (FORMAT PARQUET)""")
    n = con.execute(f"SELECT count(*) FROM read_parquet({sql_str(os.path.join(work, 'objects.parquet'))})").fetchone()[0]
    return n, len(gc)


# ------------------------------------------------------------------ stage 2: one month of one year
def month_bounds(y, m):
    a = datetime(y, m, 1, tzinfo=timezone.utc)
    b = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=timezone.utc)
    return a.strftime('%Y-%m-%d %H:%M:%S+00'), b.strftime('%Y-%m-%d %H:%M:%S+00')


def convert_month(task):
    """Write the day files of one month. Returns the marker dict."""
    out, work, files, y, m, threads, memory, force = task
    marker = os.path.join(work, 'months', f'{y:04d}-{m:02d}.json')
    if not force and os.path.exists(marker):
        with open(marker) as f:
            d = json.load(f)
        d['skipped'] = True
        return d
    t0 = time.time()
    lo, hi = month_bounds(y, m)
    con = connect(threads, memory)
    flist = '[' + ', '.join(sql_str(p) for p in files) + ']'
    # rows of the month; non-finite elements dropped, duplicates (norad, epoch) collapsed
    con.execute(f"""CREATE TEMP TABLE raw AS SELECT * FROM read_parquet({flist}, union_by_name=true)
        WHERE epoch >= TIMESTAMPTZ {sql_str(lo)} AND epoch < TIMESTAMPTZ {sql_str(hi)}""")
    n_in = con.execute('SELECT count(*) FROM raw').fetchone()[0]
    con.execute(f"""CREATE TEMP TABLE m AS SELECT * FROM (
        SELECT r.*, strftime(epoch AT TIME ZONE 'UTC', '%Y-%m-%d') AS day,
               row_number() OVER (PARTITION BY norad_id, epoch) AS rn
        FROM raw r WHERE norad_id IS NOT NULL AND epoch IS NOT NULL
          AND isfinite(mean_motion) AND isfinite(inclination) AND isfinite(raan) AND isfinite(eccentricity)
          AND isfinite(arg_perigee) AND isfinite(mean_anomaly) AND mean_motion > 0 AND eccentricity >= 0 AND eccentricity < 1
        ) WHERE rn = 1 ORDER BY day, norad_id, epoch""")
    n_ok = con.execute('SELECT count(*) FROM m').fetchone()[0]
    con.execute(f"CREATE TEMP TABLE obj AS SELECT norad_id, name, intl FROM read_parquet({sql_str(os.path.join(work, 'objects.parquet'))})")
    sel = f"""SELECT coalesce(o.name, 'NORAD ' || m.norad_id) AS OBJECT_NAME,
        coalesce({sql_designator('m.intl_designator')}, o.intl) AS OBJECT_ID,
        {sql_epoch_iso('m.epoch')} AS EPOCH,
        CAST(m.mean_motion AS DOUBLE) AS MEAN_MOTION,
        {sql_f32('m.eccentricity')} AS ECCENTRICITY,
        {sql_f32('m.inclination')} AS INCLINATION,
        {sql_f32('m.raan')} AS RA_OF_ASC_NODE,
        {sql_f32('m.arg_perigee')} AS ARG_OF_PERICENTER,
        {sql_f32('m.mean_anomaly')} AS MEAN_ANOMALY,
        0 AS EPHEMERIS_TYPE, 'U' AS CLASSIFICATION_TYPE, m.norad_id AS NORAD_CAT_ID, 0 AS ELEMENT_SET_NO, 0 AS REV_AT_EPOCH,
        coalesce(m.bstar, 0.0) AS BSTAR, coalesce(m.mean_motion_dot, 0.0) AS MEAN_MOTION_DOT, 0.0 AS MEAN_MOTION_DDOT
      FROM m LEFT JOIN obj o ON o.norad_id = m.norad_id"""
    con.execute(f'CREATE TEMP TABLE o AS {sel} ORDER BY m.day, m.norad_id, m.epoch')
    con.execute('CREATE TEMP TABLE od AS SELECT substr(EPOCH, 1, 10) AS day, * FROM o')
    days = [r[0] for r in con.execute('SELECT day, count(*) FROM od GROUP BY day ORDER BY day').fetchall()]
    written = 0
    ydir = os.path.join(out, 'elsets', f'{y:04d}')
    os.makedirs(ydir, exist_ok=True)
    for day in days:
        final = os.path.join(ydir, f'{day}.jsonl.gz')
        if os.path.exists(final) and not force:
            continue
        tmp = f'{final}.tmp-{os.getpid()}.jsonl.gz'
        cols = ', '.join(OMM_KEYS)
        con.execute(f"COPY (SELECT {cols} FROM od WHERE day = {sql_str(day)}) TO {sql_str(tmp)} (FORMAT JSON, COMPRESSION gzip)")
        os.replace(tmp, final)
        written += 1
    con.close()
    d = {'year': y, 'month': m, 'rowsIn': n_in, 'rowsOut': n_ok, 'dropped': n_in - n_ok, 'days': len(days), 'daysWritten': written, 'wallS': round(time.time() - t0, 1)}
    atomic_write_text(marker, json.dumps(d))
    return d


# ------------------------------------------------------------------ stage 3: objects.jsonl.gz
def write_objects(mirror_glob, out, work, threads, memory):
    con = connect(threads, memory)
    con.execute(f"""CREATE TEMP TABLE ms AS SELECT norad_id, min(epoch) AS first_epoch, max(epoch) AS last_epoch, count(*) AS n,
        arg_max(intl_designator, epoch) AS intl_m FROM read_parquet({mirror_glob}, union_by_name=true) GROUP BY norad_id""")
    obj = sql_str(os.path.join(work, 'objects.parquet'))
    sel = f"""SELECT coalesce(m.norad_id, o.norad_id) AS noradId,
        coalesce(o.name, 'NORAD ' || coalesce(m.norad_id, o.norad_id)) AS name,
        coalesce(o.otype, 'unknown') AS objectType, o.rcs_size AS rcsSize, o.launch AS launchDate, o.decay AS decayDate,
        coalesce(o.intl, {sql_designator('m.intl_m')}) AS intlDesignator, o.owner AS owner,
        CASE WHEN m.first_epoch IS NULL THEN NULL ELSE {sql_epoch_iso('m.first_epoch')} END AS firstEpoch,
        CASE WHEN m.last_epoch IS NULL THEN NULL ELSE {sql_epoch_iso('m.last_epoch')} END AS lastEpoch,
        coalesce(m.n, 0) AS nSets
      FROM ms m FULL OUTER JOIN read_parquet({obj}) o ON o.norad_id = m.norad_id ORDER BY 1"""
    tmp = os.path.join(out, f'objects.jsonl.gz.tmp-{os.getpid()}.jsonl.gz')
    con.execute(f"COPY ({sel}) TO {sql_str(tmp)} (FORMAT JSON, COMPRESSION gzip)")
    os.replace(tmp, os.path.join(out, 'objects.jsonl.gz'))
    n = con.execute(f"SELECT count(*) FROM ({sel})").fetchone()[0]
    return n


# ------------------------------------------------------------------ main conversion
def run_convert(a):
    files = mirror_files(a.mirror)
    if not files:
        sys.exit(f'no tle_YYYY.parquet in {a.mirror}')
    years = parse_years(a.years, files)
    out, work = a.out, os.path.join(a.out, '.work')
    os.makedirs(os.path.join(work, 'months'), exist_ok=True)
    t0 = time.time()
    n_obj, n_gc = build_objects_parquet(a.satcat, a.gcat, work)
    print(f'objects: {n_obj} metadata rows ({n_gc} GCAT rows used as fallback)', flush=True)

    # which yearly files can hold epochs of a month (normally just its own year's)
    con = connect()
    rng = {y: con.execute(f"SELECT epoch_us(min(epoch)), epoch_us(max(epoch)) FROM read_parquet({sql_str(files[y])})").fetchone() for y in files}
    con.close()
    tasks = []
    for y in years:
        for m in MONTHS:
            lo, hi = (int(datetime.fromisoformat(s.replace('+00', '+00:00')).timestamp() * 1_000_000) for s in month_bounds(y, m))
            fl = [files[fy] for fy in sorted(files) if rng[fy][0] is not None and rng[fy][0] < hi and rng[fy][1] >= lo]
            if fl:
                tasks.append((out, work, fl, y, m, a.threads, a.memory_limit, a.force))
    print(f'{len(tasks)} month tasks over {len(years)} years, {a.jobs} processes x {a.threads} duckdb threads', flush=True)
    done = 0
    with ProcessPoolExecutor(max_workers=a.jobs, mp_context=mp.get_context('spawn')) as ex:
        futs = [ex.submit(convert_month, t) for t in tasks]
        for fu in as_completed(futs):
            d = fu.result()
            done += 1
            if not d.get('skipped'):
                print(f"  {d['year']}-{d['month']:02d}: {d['rowsIn']:>10,} rows -> {d['rowsOut']:>10,} ({d['days']} days, {d['wallS']} s)   [{done}/{len(tasks)}]", flush=True)

    if not a.no_objects:
        glob_expr = '[' + ', '.join(sql_str(files[y]) for y in sorted(files)) + ']'
        n = write_objects(glob_expr, out, work, a.threads * a.jobs if a.threads * a.jobs < 256 else 256, a.memory_limit)
        print(f'objects.jsonl.gz: {n} objects', flush=True)

    # per-year summary from all markers (also those of earlier runs)
    per = {}
    for p in glob.glob(os.path.join(work, 'months', '*.json')):
        with open(p) as f:
            d = json.load(f)
        s = per.setdefault(d['year'], {'in': 0, 'out': 0, 'days': 0})
        s['in'] += d['rowsIn']; s['out'] += d['rowsOut']; s['days'] += d['days']
    print('\nyear   rows in      rows out   dropped  day files')
    tot_in = tot_out = 0
    for y in sorted(per):
        s = per[y]
        tot_in += s['in']; tot_out += s['out']
        print(f"{y}  {s['in']:>12,} {s['out']:>12,} {s['in'] - s['out']:>8,} {s['days']:>6}")
    print(f'total  {tot_in:>12,} {tot_out:>12,} {tot_in - tot_out:>8,}')
    # rows of the yearly files that no month task read (epochs outside every month window: should be zero)
    con = connect()
    for y in years:
        n = con.execute(f"SELECT count(*) FROM read_parquet({sql_str(files[y])})").fetchone()[0]
        got = per.get(y, {}).get('in', 0)
        if n != got:
            print(f'  NOTE {y}: file has {n:,} rows, month tasks read {got:,} (rows with epochs in a neighbouring year file are read there)')
    print(f'done in {time.time() - t0:.0f} s')


# ------------------------------------------------------------------ --verify
VERIFY_FIELDS = [('MEAN_MOTION', 'mean_motion', 1.0), ('ECCENTRICITY', 'eccentricity', 1.0), ('INCLINATION', 'inclination', 1.0),
                 ('RA_OF_ASC_NODE', 'raan', 1.0), ('ARG_OF_PERICENTER', 'arg_perigee', 1.0), ('MEAN_ANOMALY', 'mean_anomaly', 1.0),
                 ('BSTAR', 'bstar', 1.0), ('MEAN_MOTION_DOT', 'mean_motion_dot', 1.0)]


def parse_st_epoch(s):
    s = s.strip().replace(' ', 'T')
    if s.endswith('Z'):
        s = s[:-1]
    d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def run_verify(a):
    with open(a.verify) as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get('data') or data.get('rows') or [data]
    rows = []
    for r in data:
        try:
            ep = parse_st_epoch(r['EPOCH'])
            us = (ep - datetime(1970, 1, 1, tzinfo=timezone.utc)) // timedelta(microseconds=1)
            rows.append({'norad': int(r['NORAD_CAT_ID']), 'us': us,
                         **{k: (float(r[k]) if r.get(k) not in (None, '') else None) for k, _, _ in VERIFY_FIELDS}})
        except (KeyError, ValueError) as e:
            print(f'  skipping an unreadable Space-Track row: {e}', file=sys.stderr)
    if not rows:
        sys.exit('no usable rows in the Space-Track dump')
    files = mirror_files(a.mirror)
    lo_us, hi_us = min(r['us'] for r in rows), max(r['us'] for r in rows)
    ys = range(datetime.fromtimestamp(lo_us / 1e6 - 3600, timezone.utc).year, datetime.fromtimestamp(hi_us / 1e6 + 3600, timezone.utc).year + 1)
    fl = [files[y] for y in ys if y in files]
    if not fl:
        sys.exit(f'no mirror file for years {list(ys)}')
    con = connect(a.threads, a.memory_limit)
    tmp = os.path.join(os.path.dirname(os.path.abspath(a.verify)), f'.verify-{os.getpid()}.ndjson')
    try:
        with open(tmp, 'w') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')
        cols = ', '.join(f"{k} DOUBLE" for k, _, _ in VERIFY_FIELDS)
        con.execute(f"CREATE TEMP TABLE st AS SELECT * FROM read_json({sql_str(tmp)}, format='newline_delimited', columns={{norad: 'INTEGER', us: 'BIGINT', {', '.join(f'{k}: {chr(39)}DOUBLE{chr(39)}' for k, _, _ in VERIFY_FIELDS)}}})")
    finally:
        os.remove(tmp)
    flist = '[' + ', '.join(sql_str(p) for p in fl) + ']'
    con.execute(f"""CREATE TEMP TABLE mi AS SELECT norad_id AS norad, CAST(epoch_us(epoch) AS BIGINT) AS us, epoch, inclination, raan, eccentricity, arg_perigee,
        mean_anomaly, mean_motion, mean_motion_dot, bstar FROM read_parquet({flist}, union_by_name=true)
        WHERE norad_id IN (SELECT DISTINCT norad FROM st) AND epoch_us(epoch) BETWEEN {lo_us - 1000} AND {hi_us + 1000}""")
    n_st = len(rows)
    n_mi = con.execute('SELECT count(*) FROM mi').fetchone()[0]
    # nearest mirror row per Space-Track row within 1 ms
    con.execute("""CREATE TEMP TABLE j AS SELECT st.*, mi.us AS mi_us, mi.inclination AS mi_inclination, mi.raan AS mi_raan, mi.eccentricity AS mi_eccentricity,
        mi.arg_perigee AS mi_arg_perigee, mi.mean_anomaly AS mi_mean_anomaly, mi.mean_motion AS mi_mean_motion, mi.mean_motion_dot AS mi_mean_motion_dot, mi.bstar AS mi_bstar
        FROM st JOIN mi ON mi.norad = st.norad AND abs(mi.us - st.us) <= 1000""")
    n_j = con.execute('SELECT count(*) FROM j').fetchone()[0]
    matched_st = con.execute('SELECT count(DISTINCT (norad, us)) FROM j').fetchone()[0]
    matched_mi = con.execute('SELECT count(DISTINCT (norad, mi_us)) FROM j').fetchone()[0]
    print(f'Space-Track rows : {n_st:,}\nmirror rows      : {n_mi:,} (same objects, epochs within the dump range)\njoined pairs     : {n_j:,}')
    print(f'Space-Track rows with a mirror row (norad + epoch within 1 ms): {matched_st:,} ({100 * matched_st / n_st:.2f} %)')
    print(f'Space-Track rows without one : {n_st - matched_st:,}')
    print(f'mirror rows without a Space-Track row : {n_mi - matched_mi:,}')
    mx = con.execute('SELECT max(abs(mi_us - us)) FROM j').fetchone()[0]
    print(f'max epoch difference : {mx} us')
    print(f"{'field':<18}{'max |delta|':>16}{'median |delta|':>18}{'worst norad':>14}{'ratio mirror/ST (median)':>26}")
    for k, mcol, _ in VERIFY_FIELDS:
        r = con.execute(f"""SELECT max(abs(mi_{mcol} - {k})), median(abs(mi_{mcol} - {k})),
            (SELECT norad FROM j ORDER BY abs(mi_{mcol} - {k}) DESC NULLS LAST LIMIT 1),
            median(CASE WHEN abs({k}) > 1e-12 THEN mi_{mcol} / {k} END) FROM j WHERE {k} IS NOT NULL""").fetchone()
        f = lambda v: 'n/a' if v is None else f'{v:.6g}'
        print(f'{k:<18}{f(r[0]):>16}{f(r[1]):>18}{str(r[2]):>14}{f(r[3]):>26}')
    print('(MEAN_MOTION_DOT in Space-Track OMM is ndot/2 in rev/day^2; a mirror/ST ratio of ~2 or ~0.5 would mean the mirror stores another convention)')


# ------------------------------------------------------------------ cli
def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--mirror', required=True, help='directory with tle_YYYY.parquet (data/tle_history/data)')
    p.add_argument('--satcat', help='satcat.parquet (Space-Track SATCAT mirror)')
    p.add_argument('--gcat', help='directory with the McDowell GCAT tsv files (satcat.tsv is used as a fallback for names / types / dates)')
    p.add_argument('--out', help='output directory')
    p.add_argument('--years', help="e.g. '1959-2026' or '2019,2020' (default: every yearly file)")
    p.add_argument('--threads', type=int, default=4, help='duckdb threads per process')
    p.add_argument('--jobs', type=int, default=max(1, (os.cpu_count() or 8) // 4), help='month tasks in parallel (processes)')
    p.add_argument('--memory-limit', help="duckdb memory limit per process, e.g. '8GB'")
    p.add_argument('--force', action='store_true', help='redo months that have a marker and rewrite existing day files')
    p.add_argument('--no-objects', action='store_true', help='skip objects.jsonl.gz (written after the months)')
    p.add_argument('--verify', metavar='ST_JSON', help='compare a Space-Track gp_history JSON dump against the mirror rows for the same objects / epochs')
    a = p.parse_args()
    if a.verify:
        run_verify(a)
        return
    if not a.out or not a.satcat:
        p.error('--out and --satcat are required for a conversion')
    run_convert(a)


if __name__ == '__main__':
    main()
