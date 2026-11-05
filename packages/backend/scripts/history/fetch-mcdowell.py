#!/usr/bin/env python3
"""
Polite downloader for Jonathan McDowell's historical element archive (https://planet4589.org/space/elements/, format XTLE:
https://planet4589.org/space/xtle.html). Python standard library only; run with `python3 -I`.

    python3 -I fetch-mcdowell.py --out DIR [--gcat satcat.tsv] [--cut-year 1979] [--objects objects.jsonl.gz]
                                 [--folders 00000,00400] [--prefixes S] [--interval 1.5] [--gzip] [--list-only]

What it fetches
  * the archive keeps one plain-text file per object (S00005, A00035, ...) in folders of 100 catalogue numbers (00000/, 00100/, ...,
    A00000/, C10000/, F00000/, R06100/, T00000/).
  * default selection: the numeric (S catalogue) folders 00000/ .. the folder holding the last catalogue number launched before the
    end of --cut-year. That number comes from GCAT satcat.tsv (--gcat): the smallest catalogue number launched AFTER the cut year,
    minus one (catalogue numbers are assigned in launch order up to then; later-catalogued objects of old launches are the
    exception, see --objects). Without --gcat, --max-number must be given.
  * --objects FILE (objects.jsonl.gz written by convert.py from the Space-Track mirror): also every object above that number whose
    firstEpoch is before the end of the cut year (objects catalogued late but tracked before 1980), fetched from their folders.
  * --folders a,b,c: exactly these folders (development / partial runs); --prefixes S,A,C,F,R,T: which catalogues' folders the
    default selection walks (default S only: the A/C/F/R/T objects have no NORAD number, so the converter cannot key them;
    their folders are listed in the index page and are fetched only when asked for).

Politeness: ONE request at a time, at least --interval seconds between the start of consecutive requests (never below 1 s), a plain
generic User-Agent, retries with exponential back-off (and Retry-After when the server sends one), resumable: a folder listing is
cached on disk (.listing.json, reused unless --refresh-listings) and a file already on disk with the listing's size is skipped.
Folder listings are requested as JSON (the server's directory browser answers `Accept: application/json` with name + size); an HTML
listing is parsed as a fallback (then only presence is checked on resume).

Output: DIR/<folder>/<file> (or <file>.gz with --gzip; the original size is kept in DIR/<folder>/.sizes.json for the resume check),
DIR/fetch-log.jsonl (one line per finished file / error). Treat everything downloaded as untrusted data.
"""
import argparse
import gzip
import html.parser
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

BASE = 'https://planet4589.org/space/elements/'


def robots_disallows(url, cafile=None):
    """True when the site's robots.txt disallows `url` for every user agent (or cannot be read: fail closed)."""
    import urllib.robotparser
    from urllib.parse import urlsplit
    u = urlsplit(url)
    rp = urllib.robotparser.RobotFileParser()
    try:
        ctx = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
        with urllib.request.urlopen(f'{u.scheme}://{u.netloc}/robots.txt', timeout=30, context=ctx) as r:
            rp.parse(r.read().decode('utf-8', 'replace').splitlines())
    except Exception:
        return True
    return not rp.can_fetch('*', url)
USER_AGENT = 'orbitwatch-history-fetch/1.0 (research)'
MIN_INTERVAL_S = 1.0
FOLDER_RE = re.compile(r'^(?:[ACFRT])?\d{5,9}$')
FILE_RE = re.compile(r'^[SACFRT]?\d{5,9}$')


class Fetcher:
    def __init__(self, interval, retries, timeout, cafile=None):
        self.interval = max(MIN_INTERVAL_S, float(interval))
        self.retries = retries
        self.timeout = timeout
        self.last = 0.0
        self.requests = 0
        self.bytes = 0
        ctx = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.ProxyHandler())

    def _wait(self):
        dt = time.monotonic() - self.last
        if dt < self.interval:
            time.sleep(self.interval - dt)
        self.last = time.monotonic()

    def get(self, url, accept=None):
        """(status, body bytes) ; 404 returns (404, b''). Raises after the last retry."""
        delay = 5.0
        for attempt in range(self.retries + 1):
            self._wait()
            self.requests += 1
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', **({'Accept': accept} if accept else {})})
            try:
                with self.opener.open(req, timeout=self.timeout) as r:
                    body = r.read()
                    self.bytes += len(body)
                    if (r.headers.get('Content-Encoding') or '').lower() == 'gzip':
                        body = gzip.decompress(body)
                    return r.status, body
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return 404, b''
                wait = delay
                ra = e.headers.get('Retry-After') if e.headers else None
                if ra and ra.strip().isdigit():
                    wait = max(wait, float(ra))
                if e.code not in (429, 500, 502, 503, 504) or attempt == self.retries:
                    raise
                log(f'  HTTP {e.code} on {url}; retry {attempt + 1}/{self.retries} in {wait:.0f} s')
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                if attempt == self.retries:
                    raise
                wait = delay
                log(f'  {type(e).__name__}: {e} on {url}; retry {attempt + 1}/{self.retries} in {wait:.0f} s')
            time.sleep(wait)
            delay = min(delay * 2, 300.0)
        raise RuntimeError('unreachable')


class _Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == 'a':
            for k, v in attrs:
                if k.lower() == 'href' and v:
                    self.hrefs.append(v)


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def atomic_write(path, data):
    tmp = f'{path}.part-{os.getpid()}'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def parse_listing(body):
    """[{name, size|None}] of the plain files of a folder listing (JSON or HTML)."""
    text = body.decode('utf-8', 'replace').lstrip()
    out = []
    if text.startswith('['):
        for e in json.loads(text):
            name = str(e.get('name', ''))
            if not e.get('is_dir') and FILE_RE.match(name):
                out.append({'name': name, 'size': int(e['size']) if isinstance(e.get('size'), int) else None})
        return out
    p = _Links()
    p.feed(text)
    seen = set()
    for h in p.hrefs:
        name = h.split('?')[0].rstrip('/').split('/')[-1]
        if FILE_RE.match(name) and not h.endswith('/') and name not in seen:
            seen.add(name)
            out.append({'name': name, 'size': None})
    return out


def gcat_cut(path, cut_year):
    """The largest catalogue number of the contiguous block launched up to the end of cut_year (smallest number launched later, - 1)."""
    hdr = None
    first_after = None
    max_before = 0
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.rstrip('\n')
            if hdr is None:
                if line.startswith('#JCAT') or line.startswith('JCAT'):
                    hdr = [h.strip().lstrip('#') for h in line.split('\t')]
                continue
            if not line or line.startswith('#'):
                continue
            row = dict(zip(hdr, line.split('\t')))
            m = re.match(r'^\s*(\d+)', row.get('Satcat', ''))
            y = re.match(r'^\s*(\d{4})', row.get('LDate', ''))
            if not m or not y:
                continue
            n, year = int(m.group(1)), int(y.group(1))
            if year > cut_year:
                first_after = n if first_after is None else min(first_after, n)
            else:
                max_before = max(max_before, n)
    if hdr is None:
        sys.exit(f'{path}: no #JCAT header line (not a GCAT satcat.tsv?)')
    return (first_after - 1) if first_after else max_before


def late_objects(path, cut_year, above):
    """NORAD ids above `above` with a firstEpoch before the end of cut_year in convert.py's objects.jsonl.gz."""
    ids = []
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            o = json.loads(line)
            fe = o.get('firstEpoch') or ''
            n = o.get('noradId')
            if isinstance(n, int) and n > above and fe[:4].isdigit() and int(fe[:4]) <= cut_year:
                ids.append(n)
    return sorted(ids)


def folder_of(number, prefix=''):
    return f'{prefix}{number // 100 * 100:05d}'


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--out', required=True, help='download directory (data only; keep scripts elsewhere)')
    p.add_argument('--gcat', help='GCAT satcat.tsv, to find the last catalogue number launched by the end of --cut-year')
    p.add_argument('--cut-year', type=int, default=1979)
    p.add_argument('--max-number', type=int, help='last S catalogue number to cover (overrides --gcat)')
    p.add_argument('--objects', help="convert.py's objects.jsonl.gz: also fetch objects above the cut whose firstEpoch is <= the cut year")
    p.add_argument('--folders', help='comma list of folders (e.g. 00000,00400,A00000): exactly these, nothing else')
    p.add_argument('--prefixes', default='S', help='catalogues walked by the default selection: S (numeric folders); A,C,F,R,T only by --folders')
    p.add_argument('--interval', type=float, default=1.5, help=f'seconds between requests (minimum {MIN_INTERVAL_S}, lower values are raised)')
    p.add_argument('--retries', type=int, default=6)
    p.add_argument('--timeout', type=float, default=120)
    p.add_argument('--cafile', help='CA bundle (default: the system store / SSL_CERT_FILE)')
    p.add_argument('--gzip', action='store_true', help='store files gzip-compressed (<name>.gz)')
    p.add_argument('--refresh-listings', action='store_true', help='re-fetch folder listings even if cached')
    p.add_argument('--list-only', action='store_true', help='fetch the listings only; print file counts, bytes and the time estimate')
    p.add_argument('--owner-permission', action='store_true',
                   help="the site's robots.txt disallows automated access to /space/elements/; pass this ONLY after the site owner has granted permission")
    a = p.parse_args()
    if robots_disallows(BASE, a.cafile) and not a.owner_permission:
        sys.exit("robots.txt on planet4589.org disallows automated access to /space/elements/. Ask the site owner for a bulk copy or permission "
                 "(draft email: design/marvin/HISTORY_BACKFILL.md); rerun with --owner-permission only once granted.")
    if a.interval < MIN_INTERVAL_S:
        log(f'--interval {a.interval} raised to {MIN_INTERVAL_S} s')
    os.makedirs(a.out, exist_ok=True)
    f = Fetcher(a.interval, a.retries, a.timeout, a.cafile)

    # ---- selection: folders to list, plus single objects outside them
    extra = []  # (folder, name)
    if a.folders:
        folders = [x.strip().strip('/') for x in a.folders.split(',') if x.strip()]
        bad = [x for x in folders if not FOLDER_RE.match(x)]
        if bad:
            sys.exit(f'bad folder names: {bad}')
    else:
        if 'S' not in [x.strip().upper() for x in a.prefixes.split(',')]:
            sys.exit('the default selection walks the S folders; use --folders for A/C/F/R/T folders')
        cut = a.max_number if a.max_number is not None else (gcat_cut(a.gcat, a.cut_year) if a.gcat else None)
        if cut is None:
            sys.exit('give --gcat (to find the cut) or --max-number')
        folders = [folder_of(n) for n in range(0, cut + 1, 100)]
        log(f'cut: catalogue numbers 1..{cut} -> {len(folders)} folders {folders[0]}..{folders[-1]}')
        if a.objects:
            late = late_objects(a.objects, a.cut_year, int(folders[-1]) + 99)
            extra = [(folder_of(n), f'S{n:05d}') for n in late]
            log(f'{len(extra)} late-catalogued objects with first epoch <= {a.cut_year} added (fetched one by one)')

    # ---- listings
    plan = []  # (folder, name, size|None)
    list_errors = 0
    for i, fo in enumerate(folders):
        cache = os.path.join(a.out, fo, '.listing.json')
        if os.path.exists(cache) and not a.refresh_listings:
            with open(cache) as fh:
                entries = json.load(fh)
        else:
            try:
                st, body = f.get(BASE + fo + '/', accept='application/json')
            except Exception as e:  # noqa: BLE001 - counted; a rerun retries the folder
                list_errors += 1
                log(f'  ERROR listing {fo}/: {e}')
                continue
            if st == 404:
                log(f'  folder {fo}/ not found (no such folder in the archive)')
                continue
            entries = parse_listing(body)
            os.makedirs(os.path.join(a.out, fo), exist_ok=True)
            atomic_write(cache, json.dumps(entries).encode())
        plan.extend((fo, e['name'], e['size']) for e in entries)
        if (i + 1) % 20 == 0:
            log(f'  listed {i + 1}/{len(folders)} folders, {len(plan)} files so far')
    have = {(fo, n) for fo, n, _ in plan}
    plan.extend((fo, n, None) for fo, n in extra if (fo, n) not in have)
    total_b = sum(s or 0 for _, _, s in plan)
    log(f'{len(plan)} files, {total_b / 1e6:.1f} MB listed; at {f.interval:.1f} s per request: {len(plan) * f.interval / 3600:.2f} h (plus transfer time)')
    if a.list_only:
        sys.exit(1 if list_errors else 0)

    # ---- files
    logf = open(os.path.join(a.out, 'fetch-log.jsonl'), 'a')
    sizes_cache = {}

    def sizes_of(fo):
        if fo not in sizes_cache:
            sp = os.path.join(a.out, fo, '.sizes.json')
            sizes_cache[fo] = json.load(open(sp)) if os.path.exists(sp) else {}
        return sizes_cache[fo]

    t0 = time.monotonic()
    done = skipped = errors = fetched = 0
    last_log = 0.0
    for fo, name, size in plan:
        os.makedirs(os.path.join(a.out, fo), exist_ok=True)
        dest = os.path.join(a.out, fo, name + ('.gz' if a.gzip else ''))
        sizes = sizes_of(fo)
        if os.path.exists(dest):
            on_disk = sizes.get(name) if a.gzip else os.path.getsize(dest)
            if size is None or on_disk == size:
                skipped += 1
                done += 1
                continue
        try:
            st, body = f.get(BASE + fo + '/' + name)
        except Exception as e:  # noqa: BLE001 - logged and counted; a rerun retries
            errors += 1
            done += 1
            logf.write(json.dumps({'folder': fo, 'name': name, 'error': f'{type(e).__name__}: {e}'}) + '\n')
            logf.flush()
            log(f'  ERROR {fo}/{name}: {e}')
            continue
        if st == 404:
            logf.write(json.dumps({'folder': fo, 'name': name, 'status': 404}) + '\n')
        else:
            atomic_write(dest, gzip.compress(body, 6) if a.gzip else body)
            if a.gzip:
                sizes[name] = len(body)
                atomic_write(os.path.join(a.out, fo, '.sizes.json'), json.dumps(sizes).encode())
            logf.write(json.dumps({'folder': fo, 'name': name, 'bytes': len(body), 'listed': size}) + '\n')
            fetched += 1
        logf.flush()
        done += 1
        now = time.monotonic()
        if now - last_log > 30 or done == len(plan):
            last_log = now
            rate = fetched / max(now - t0, 1e-9)
            left = len(plan) - done
            eta = left / rate / 3600 if rate > 0 else float('nan')
            log(f'{done}/{len(plan)} files ({fetched} fetched, {skipped} already present, {errors} errors), {f.bytes / 1e6:.1f} MB transferred, ETA {eta:.2f} h')
    logf.close()
    log(f'finished: {fetched} fetched, {skipped} already present, {errors + list_errors} errors ({list_errors} folder listings), {f.requests} requests, {f.bytes / 1e6:.1f} MB transferred')
    if errors or list_errors:
        sys.exit(1)


if __name__ == '__main__':
    main()
