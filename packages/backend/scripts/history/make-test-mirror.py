#!/usr/bin/env python3
"""
Build a small mirror-schema fixture (tle_YYYY.parquet + satcat.parquet) for the tests and for timing runs on a dev machine.

    python3 -I make-test-mirror.py --out DIR [--catalogs packages/backend/data/history] [--objects 2000] [--from 2026-10-09 --to 2026-10-14]
                                   [--sets-per-day 1]

Source of the element sets: the daily catalog JSON files (catalog-YYYY-MM-DD.json: latest set per object) in the range, which
gives every distinct (object, epoch) pair they contain. Without --catalogs a purely synthetic constellation is generated.
Edge rows are added on purpose: epochs at 23:59:59.999 and 00:00:00.000 around a UTC day boundary, a duplicate (norad, epoch)
row, and a row with a non-finite element, so the converter's bucketing / dedupe / drop paths run.
Schema = the mirror's: norad_id INTEGER, epoch TIMESTAMPTZ, inclination/raan/eccentricity/arg_perigee/mean_anomaly FLOAT,
mean_motion/mean_motion_dot/bstar DOUBLE, intl_designator VARCHAR ('98067A'), altitude_km FLOAT.
"""
import argparse
import glob
import json
import math
import os
import random
from datetime import datetime, timezone

import duckdb


def short_designator(object_id):
    """'1998-067A' -> '98067A'"""
    try:
        y, rest = object_id.split('-')
        return y[2:] + rest
    except Exception:
        return ''


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True)
    p.add_argument('--catalogs')
    p.add_argument('--objects', type=int, default=2000)
    p.add_argument('--from', dest='dfrom', default='2026-10-09')
    p.add_argument('--to', dest='dto', default='2026-10-14')
    p.add_argument('--seed', type=int, default=7)
    a = p.parse_args()
    rnd = random.Random(a.seed)
    os.makedirs(a.out, exist_ok=True)

    rows, meta = {}, {}  # (norad, epoch_iso) -> row ; norad -> meta
    if a.catalogs:
        files = sorted(f for f in glob.glob(os.path.join(a.catalogs, 'catalog-*.json')) if a.dfrom <= os.path.basename(f)[8:18] <= a.dto)
        if not files:
            raise SystemExit('no catalog files in range')
        first = json.load(open(files[0]))
        ids = sorted(o['noradId'] for o in first)
        keep = set(rnd.sample(ids, min(a.objects, len(ids))))
        for f in files:
            for o in json.load(open(f)):
                if o['noradId'] not in keep:
                    continue
                m = o['omm']
                rows[(o['noradId'], m['EPOCH'])] = (o['noradId'], m['EPOCH'], m['INCLINATION'], m['RA_OF_ASC_NODE'], m['ECCENTRICITY'], m['ARG_OF_PERICENTER'],
                                                    m['MEAN_ANOMALY'], m['MEAN_MOTION'], m['MEAN_MOTION_DOT'], m['BSTAR'], short_designator(m.get('OBJECT_ID', '')),
                                                    o.get('perigee'))
                meta[o['noradId']] = o
    else:
        for i in range(a.objects):
            nid = 100 + i
            for d in range(6):
                ep = f'2026-10-{9 + d:02d}T{rnd.randint(0, 23):02d}:{rnd.randint(0, 59):02d}:{rnd.randint(0, 59):02d}.{rnd.randint(0, 999):03d}Z'
                rows[(nid, ep)] = (nid, ep, [53, 98, 28.5, 70, 97.5, 51.6][i % 6], (i * 37 + d) % 360, 0.0001 + (i % 4) * 0.001, 0.0, (i * 91 + d * 10) % 360,
                                   14.2 + (i % 5) * 0.4, 1e-6, 1e-4, f'20{i % 20:02d}{(i % 999) + 1:03d}A', 500.0)
            meta[nid] = {'name': f'SYN-{nid}', 'objectType': ['unknown', 'rocket_body', 'debris'][i % 3], 'rcsSize': ['SMALL', 'MEDIUM', 'LARGE', None][i % 4],
                         'launchDate': '2020-01-01', 'omm': {'OBJECT_ID': f'20{i % 20:02d}-{(i % 999) + 1:03d}A'}}

    # edge rows on the first object: around the UTC midnight of day 2 and a duplicate; a bad element on another object
    ids = sorted(meta)
    some = rows[next(k for k in rows if k[0] == ids[0])]
    day2 = sorted({k[1][:10] for k in rows})[1]
    for k, ep in enumerate([f'{day2}T00:00:00.000Z', f'{day2}T23:59:59.999Z']):
        r = list(some); r[1] = ep; rows[(ids[0], ep)] = tuple(r)
    bad = list(rows[next(k for k in rows if k[0] == ids[1])]); bad[1] = f'{day2}T12:00:00.500Z'; bad[7] = float('nan')
    rows[(ids[1], bad[1])] = tuple(bad)

    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    con.execute("""CREATE TABLE t (norad_id INTEGER, epoch TIMESTAMPTZ, inclination FLOAT, raan FLOAT, eccentricity FLOAT, arg_perigee FLOAT, mean_anomaly FLOAT,
        mean_motion DOUBLE, mean_motion_dot DOUBLE, bstar DOUBLE, intl_designator VARCHAR, altitude_km FLOAT)""")
    data = list(rows.values())
    con.executemany('INSERT INTO t VALUES (?, CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', data)
    # a duplicate row (same norad + epoch): must be collapsed by the converter
    dup = data[0]
    con.executemany('INSERT INTO t VALUES (?, CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [dup])
    for y in sorted({int(r[1][:4]) for r in data}):
        con.execute(f"COPY (SELECT * FROM t WHERE year(epoch) = {y} ORDER BY norad_id, epoch) TO '{os.path.join(a.out, f'tle_{y}.parquet')}' (FORMAT PARQUET)")

    con.execute("""CREATE TABLE s (object_name VARCHAR, intl_designator VARCHAR, norad_id INTEGER, object_type VARCHAR, ops_status VARCHAR, owner VARCHAR,
        launch_date DATE, launch_site VARCHAR, decay_date DATE, period_min DOUBLE, inclination DOUBLE, apogee_km DOUBLE, perigee_km DOUBLE, rcs_m2 DOUBLE,
        data_status VARCHAR, orbit_center VARCHAR, orbit_type VARCHAR)""")
    typ = {'unknown': 'PAYLOAD', 'rocket_body': 'ROCKET BODY', 'debris': 'DEBRIS'}
    rcs = {'SMALL': 0.05, 'MEDIUM': 0.5, 'LARGE': 3.0, None: None}
    srows = []
    for n, o in sorted(meta.items()):
        decay = '2026-10-12' if n == ids[2] else None  # one object decays inside the range
        srows.append((o['name'], (o['omm'].get('OBJECT_ID') or None), n, typ.get(o.get('objectType'), 'UNKNOWN'), '', 'US', o.get('launchDate'), 'AFETR', decay, 90.0, 53.0, 500.0, 480.0,
                      rcs.get(o.get('rcsSize')), '', 'EA', 'ORB'))
    con.executemany('INSERT INTO s VALUES (?, ?, ?, ?, ?, ?, CAST(? AS DATE), ?, CAST(? AS DATE), ?, ?, ?, ?, ?, ?, ?, ?)', srows)
    con.execute(f"COPY s TO '{os.path.join(a.out, 'satcat.parquet')}' (FORMAT PARQUET)")
    print(f'{len(data) + 1} rows, {len(meta)} objects, years {sorted({int(r[1][:4]) for r in data})} -> {a.out}')


if __name__ == '__main__':
    main()
