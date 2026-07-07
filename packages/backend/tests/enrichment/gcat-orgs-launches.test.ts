// Tests for the orgs.tsv / launch.tsv entity parsers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGcatOrgs } from '../../src/enrichment/gcat/orgs.js';
import {
  parseGcatLaunches,
  parseLvFamilies,
  parseSiteNames,
  launchSuccess,
} from '../../src/enrichment/gcat/launches.js';

// ── orgs ──────────────────────────────────────────────────────────────────────

const ORGS = [
  '#Code\tUCode\tStateCode\tType\tClass\tTStart\tTStop\tShortName\tName\tLocation\tLongitude\tLatitude\tError\tParent\tShortEName\tEName\tUName',
  '# Updated 2026 Jul  3 2202:24',
  'EARTH\tEARTH\tEARTH\tAP\tC\t-\t-\tEarth\tEarth\tEarth\t-\t-\t0.02\t-\tEarth (Terra)\tEarth\tEarth',
  'SPXS\tSPX\tUS\tO/LV\tB\t2002\t*\tSpaceX\tSpace Exploration Technologies\tHawthorne\t-118.32\t33.92\t0.01\t-\t-\tSpaceX\tSpaceX',
  'RVSN\tRVSN\tSU\tO\tD\t1959\t-\tRVSN\tRaketnye Voyska\tMoskva\t-\t-\t0.1\tMO\t-\t-\tRVSN',
  'TUG\tTUG\tAT\tO/PL\tA\t-\t-\tTU Graz\tTechnische Universitaet Graz\tGraz\t15.45\t47.06\t0.01\t-\t-\t-\tTU Graz',
  'NASA\tNASA\tUS\tO\tC\t1958\t*\tNASA\tNASA\tWashington\t-77.02\t38.88\t0.01\t-\tNASA\tNASA\tNASA',
].join('\n');

test('orgs: display-name pick order, AP skip, class fold, fields', () => {
  const orgs = parseGcatOrgs(ORGS);
  assert.equal(orgs.has('EARTH'), false);            // astronomical body skipped
  const spx = orgs.get('SPXS')!;
  assert.equal(spx.name, 'SpaceX');                  // EName wins
  assert.deepEqual(spx.sectors, ['commercial']);
  assert.equal(spx.stateCode, 'US');
  assert.equal(spx.lat, 33.92);
  assert.equal(spx.lon, -118.32);
  const rvsn = orgs.get('RVSN')!;
  assert.equal(rvsn.name, 'RVSN');                   // no EName/ShortEName → ShortName
  assert.deepEqual(rvsn.sectors, ['military']);
  assert.equal(rvsn.parent, 'MO');
  assert.deepEqual(orgs.get('TUG')!.sectors, ['civil']);  // A → civil fold
});

test('orgs: aliases keep the name variants the display pick drops (G3)', () => {
  const orgs = parseGcatOrgs(ORGS);
  // SPXS: EName 'SpaceX' is the display; ShortName dedups into it; Name survives.
  assert.deepEqual(orgs.get('SPXS')!.aliases, ['Space Exploration Technologies']);
  // RVSN: ShortName is the display; the native-language Name survives as alias.
  assert.deepEqual(orgs.get('RVSN')!.aliases, ['Raketnye Voyska']);
  // NASA: every variant equals the display → no aliases key at all.
  assert.equal(orgs.get('NASA')!.aliases, undefined);
});

// ── launches ──────────────────────────────────────────────────────────────────

test('launchSuccess: char2 only; partial-assessment digits ignored', () => {
  assert.equal(launchSuccess('OS'), true);
  assert.equal(launchSuccess('OS75'), true);
  assert.equal(launchSuccess('OF'), false);
  assert.equal(launchSuccess('OF40'), false);
  assert.equal(launchSuccess('OE'), false);
  assert.equal(launchSuccess('DS'), true);
  assert.equal(launchSuccess('OU'), null);
  assert.equal(launchSuccess(''), null);
});

const LV = [
  '#LV_Name\tLV_Family\tLV_Manufacturer',
  'Falcon 9\tFalcon9              \tSPX',
].join('\n');

const SITES = [
  '#Site\tCode\tUCode\tType\tStateCode\tTStart\tTStop\tShortName\tName\tLocation\tLongitude\tLatitude\tError\tParent\tShortEName\tEName\tGroup\tUName',
  'CC\t-\tCC\tLS\tUS\t1950\t*\tCanaveral\tCape Canaveral Space Force Station\tFlorida\t-80.57\t28.49\t0.01\tUSSF\tCape Canaveral\t-\t-\tCC',
  'GIK-5\t-\tGIK-5\tLS\tKZ\t1957\t*\tBaykonur\tGosudarstvennyy ispytatelnyy kosmodrom\tKazakhstan\t63.3\t45.9\t0.1\t-\t-\t-\t-\tX',
].join('\n');

const LAUNCH = [
  '#Launch_Tag\tLaunch_JD\tLaunch_Date\tLV_Type\tVariant\tFlight_ID\tFlight\tMission\tFlightCode\tPlatform\tLaunch_Site\tLaunch_Pad\tAscent_Site\tAscent_Pad\tApogee\tApoflag\tRange\tRangeFlag\tDest\tOrbPay\tAgency\tLaunchCode\tFailCode\tGroup\tCategory\tLTCite\tCite\tNotes',
  '2019-074\t2458798.9\t2019 Nov 11 1456\tFalcon 9\t-\t076/B1048.4\tF076\tStarlink-1\t-\t-\tCC\tLC40\t-\t-\t-\t \t-\t \t-\t15.600\tSPXS\tOS\t-\t-\tSat LEO O\t-\t-\t-',
  '1998-067\t2451137.8\t1998 Nov 20 0640\tProton-K\t-\t-\t-\tZarya\t-\t-\tGIK-5\tLC81L\t-\t-\t-\t \t-\t \t-\t20.260\tRAKA/DASA?\tOS\t-\t-\tSat LEO O\t-\t-\t-',
  '2026-F05\t2461000.5\t2026 Apr  3\tTL-3\t-\t-\t-\t-\t-\t-\tXIC\t-\t-\t-\t-\t \t-\t \t-\t0.000\tXIAMT\tOF40\t-\t-\tFTO\t-\t-\t-',
].join('\n');

test('launches: joins, agency split + ?-strip, outcome, fields', () => {
  const launches = parseGcatLaunches(LAUNCH, parseLvFamilies(LV), parseSiteNames(SITES));
  const sl = launches.get('2019-074')!;
  assert.equal(sl.lvType, 'Falcon 9');
  assert.equal(sl.lvFamily, 'Falcon9');              // padded family trimmed
  assert.equal(sl.siteName, 'Cape Canaveral');       // ShortEName wins
  assert.equal(sl.pad, 'LC40');
  assert.deepEqual(sl.agencies, ['SPXS']);
  assert.equal(sl.success, true);
  assert.equal(sl.orbPay, 15.6);
  const iss = launches.get('1998-067')!;
  assert.deepEqual(iss.agencies, ['RAKA', 'DASA']);  // multi + '?' stripped
  assert.equal(iss.siteName, 'Baykonur');            // no ShortEName → ShortName
  const fto = launches.get('2026-F05')!;
  assert.equal(fto.success, false);                  // OF40 → failure
  assert.equal(fto.lvFamily, null);
  assert.equal(fto.siteName, null);
});
