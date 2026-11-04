#!/usr/bin/env python3
"""
Era statistics of the GP-history mirror: how often is each object re-fitted, year by year?

    python3 -I era-stats.py --mirror data/tle_history/data [--years 1959-2026] [--jobs 16] [--threads 4] [--era-json era.json]

Per year it prints the number of objects and element sets and the gap (days) between consecutive element sets of the same object:
median, p90 and p99 (pooled over all consecutive pairs; the first 60 days of the previous year are read so January is not cut), plus the
typical-object view (median over objects of each object's median gap, and its p90 across objects). The suggested staleness window of
the catalog is   window = max(30 d, 1.5 x p90 gap)   rounded up to whole days; a '*' marks years where it exceeds 60 days (the coverage
build skips element sets more than 60 days from the day, so a longer window only helps the change events, not the coverage lists).

--era-json FILE writes the suggestions as a JSON era table (one row per year: fromYear, windowDays, jumpDposKm, jumpDaKm) that
build-range.ts reads with --era-file, and that can be copied into src/ssa/history/era.ts (ERA_TABLE). Jump thresholds are written
at the production values; edit them if the chain check shows a higher noise floor in old years.
Only duckdb is needed.
"""
import argparse
import glob
import json
import math
import multiprocessing as mp
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor

import duckdb

JUMP_DPOS_KM, JUMP_DA_KM = 16.3, 1.0


def sql_str(s):
    return "'" + str(s).replace("'", "''") + "'"


def year_stats(task):
    year, files, threads = task
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    con.execute(f'SET threads={int(threads)}')
    cur, prev = files.get(year), files.get(year - 1)
    srcs = []
    if cur:
        srcs.append(f"SELECT norad_id, epoch FROM read_parquet({sql_str(cur)})")
    if prev:
        srcs.append(f"SELECT norad_id, epoch FROM read_parquet({sql_str(prev)}) WHERE epoch >= TIMESTAMPTZ '{year}-01-01 00:00:00+00' - INTERVAL 60 DAY")
    if not cur:
        return year, None
    con.execute(f"CREATE TEMP TABLE s AS SELECT DISTINCT norad_id, epoch FROM ({' UNION ALL '.join(srcs)})")
    con.execute("""CREATE TEMP TABLE g AS SELECT norad_id, epoch,
        (epoch_us(epoch) - epoch_us(lag(epoch) OVER (PARTITION BY norad_id ORDER BY epoch))) / 86400e6 AS gap FROM s""")
    r = con.execute(f"""SELECT count(DISTINCT norad_id), count(*), count(gap),
        quantile_cont(gap, 0.5), quantile_cont(gap, 0.9), quantile_cont(gap, 0.99)
        FROM g WHERE epoch >= TIMESTAMPTZ '{year}-01-01 00:00:00+00' AND epoch < TIMESTAMPTZ '{year + 1}-01-01 00:00:00+00'""").fetchone()
    o = con.execute(f"""SELECT quantile_cont(m, 0.5), quantile_cont(m, 0.9) FROM (
        SELECT norad_id, median(gap) AS m FROM g WHERE gap IS NOT NULL AND epoch >= TIMESTAMPTZ '{year}-01-01 00:00:00+00'
          AND epoch < TIMESTAMPTZ '{year + 1}-01-01 00:00:00+00' GROUP BY norad_id)""").fetchone()
    return year, {'objects': r[0], 'sets': r[1], 'pairs': r[2], 'median': r[3], 'p90': r[4], 'p99': r[5], 'obj_median_med': o[0], 'obj_median_p90': o[1]}


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--mirror', required=True, help='directory with tle_YYYY.parquet')
    p.add_argument('--years', help="e.g. '1959-2026' (default: all)")
    p.add_argument('--jobs', type=int, default=max(1, (os.cpu_count() or 4) // 4))
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--era-json', help='write the suggested era table here')
    a = p.parse_args()
    files = {}
    for f in glob.glob(os.path.join(a.mirror, 'tle_*.parquet')):
        m = re.search(r'tle_(\d{4})\.parquet$', f)
        if m:
            files[int(m.group(1))] = f
    if not files:
        sys.exit('no tle_YYYY.parquet found')
    years = sorted(files)
    if a.years:
        sel = set()
        for part in a.years.split(','):
            lo, _, hi = part.partition('-')
            sel.update(range(int(lo), int(hi or lo) + 1))
        years = [y for y in years if y in sel]
    res = {}
    with ProcessPoolExecutor(max_workers=a.jobs, mp_context=mp.get_context('spawn')) as ex:
        for y, s in ex.map(year_stats, [(y, files, a.threads) for y in years]):
            res[y] = s
    print(f"{'year':<6}{'objects':>9}{'sets':>12}{'sets/obj':>9}{'gap med d':>11}{'gap p90 d':>11}{'gap p99 d':>11}{'obj-med med':>12}{'obj-med p90':>12}{'window d':>10}")
    table = []
    for y in years:
        s = res.get(y)
        if not s or not s['pairs']:
            print(f'{y:<6}{"(no pairs)":>9}')
            continue
        win = max(30, math.ceil(1.5 * s['p90']))
        flag = '*' if win > 60 else ' '
        print(f"{y:<6}{s['objects']:>9,}{s['sets']:>12,}{s['sets'] / max(1, s['objects']):>9.1f}{s['median']:>11.2f}{s['p90']:>11.2f}{s['p99']:>11.2f}"
              f"{(s['obj_median_med'] or 0):>12.2f}{(s['obj_median_p90'] or 0):>12.2f}{win:>9}{flag}")
        table.append({'fromYear': y, 'windowDays': win, 'jumpDposKm': JUMP_DPOS_KM, 'jumpDaKm': JUMP_DA_KM})
    print('\nwindow = max(30, ceil(1.5 x p90 gap)).  * = above the 60-day coverage cap (coverage skips element sets older than that).')
    if a.era_json:
        with open(a.era_json, 'w') as f:
            json.dump(table, f, indent=1)
        print(f'wrote {a.era_json} ({len(table)} rows, one per year): pass it to build-range.ts --era-file')


if __name__ == '__main__':
    main()
