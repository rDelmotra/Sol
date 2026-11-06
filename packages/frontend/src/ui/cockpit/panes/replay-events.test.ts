import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SsaEvent } from '@orbitwatch/contracts';
import { toEnrichedObject } from '../../../data/replay-catalog';
import { histObj } from '../../../data/replay-fixtures';
import { eventRows, toggleFragments, type CatalogEntry } from './replay-events';
import { ReplayEventsView, type ReplayEventsViewProps } from './ReplayEventsPane';

const ev = (id: number, kind: string, subjects: number[], payload: unknown): SsaEvent => ({ id, day: '2009-02-11', kind, subjects, tStart: null, tEnd: null, payload });

const EVENTS: SsaEvent[] = [
  ev(1, 'object.disappeared', [11], { cls: 'decay_likely', lastEpoch: '2009-02-09T03:00:00', name: 'OLD SAT' }),
  ev(2, 'object.appeared', [25544], { launch: '1998-11-20', perigee: 350.2, apogee: 410.8, name: 'ZARYA' }),
  ev(3, 'object.breakup', [22675], { launch: '1993-036', parentNorad: 22675, pieces: 1347, firstDay: '2009-02-10', lastDay: '2009-03-10' }),
  ev(4, 'elements.jump', [24946], { da: -1.234, dpos: 22.5, name: 'IRIDIUM 33' }),
];

const lookup = (n: number): CatalogEntry | undefined =>
  ({ 25544: { index: 0, name: 'ZARYA', designator: '1998-067A', launchDate: '1998-11-20' }, 22675: { index: 1, name: 'COSMOS 2251', designator: '1993-036A', launchDate: '1993-06-16' } } as Record<number, CatalogEntry>)[n];

describe('replay events pane model', () => {
  it('orders breakups, new objects, orbit changes, objects no longer tracked; plain wording', () => {
    const rows = eventRows(EVENTS, lookup);
    assert.deepEqual(rows.map((r) => r.tag), ['BREAKUP', 'NEW OBJECT', 'ORBIT CHANGE', 'NO LONGER TRACKED']);
    const [brk, app, jump, gone] = rows;
    assert.equal(brk.title, 'LAUNCH 1993-036 · 1347 PIECES');
    assert.match(brk.detail, /parent COSMOS 2251 \(22675\) · catalogued 2009-02-10 – 2009-03-10/);
    assert.equal(brk.index, 1);
    assert.equal(brk.breakup?.firstDay, '2009-02-10');
    assert.equal(app.title, 'ZARYA (25544)');
    assert.equal(app.detail, 'launch 1998-11-20 · 1998-067A · 350 × 411 km');
    assert.equal(app.index, 0);
    assert.equal(jump.detail, 'Δa −1.2 km · Δpos 23 km');
    assert.equal(jump.index, null, 'not in the loaded catalog → not selectable');
    assert.match(gone.detail, /decay likely · last set 2009-02-09/);
  });
  it('fragments selection toggles per launch', () => {
    const b1 = { launch: '1993-036', parentNorad: 22675, pieces: 1, firstDay: '2009-02-10', lastDay: '' };
    const b2 = { launch: '1997-051', parentNorad: 24946, pieces: 1, firstDay: '2009-02-10', lastDay: '' };
    const one = toggleFragments(null, b1);
    assert.deepEqual(one, { launches: ['1993-036'], parentNorads: [22675] });
    const two = toggleFragments(one, b2);
    assert.deepEqual(two, { launches: ['1993-036', '1997-051'], parentNorads: [22675, 24946] });
    assert.deepEqual(toggleFragments(two, b1), { launches: ['1997-051'], parentNorads: [24946] });
    assert.equal(toggleFragments(toggleFragments(null, b1), b1), null);
  });
});

const view = (p: Partial<ReplayEventsViewProps>) =>
  renderToStaticMarkup(createElement(ReplayEventsView, { day: null, events: undefined, status: undefined, catalog: [], fragments: null, ...p }));

describe('ReplayEventsPane rendering', () => {
  it('lists the day’s events with a SHOW FRAGMENTS action on breakups, in neutral colours', () => {
    const html = view({
      day: '2009-02-11',
      events: EVENTS,
      status: 'ready',
      catalog: [toEnrichedObject(histObj(25544, { name: 'ZARYA' })), toEnrichedObject(histObj(22675, { name: 'COSMOS 2251', intlDesignator: '1993-036A' }))],
    });
    assert.match(html, />EVENTS</);
    assert.match(html, /2009-02-11 UTC/);
    assert.match(html, /SHOW FRAGMENTS/);
    assert.match(html, /ZARYA \(25544\)/);
    assert.match(html, /NO LONGER TRACKED/);
    assert.match(html, /ALL 4/);
    assert.doesNotMatch(html, /hud-warn|red|#f/i, 'no alarm styling');
  });
  it('says so when events are unavailable (503) or not replaying; shows the active fragments filter', () => {
    assert.match(view({ day: '1965-06-05', status: 'unavailable' }), /Event data unavailable for this day/);
    assert.match(view({ day: null }), /Replay a past date/);
    assert.match(
      view({ day: '2009-02-11', events: EVENTS, status: 'ready', fragments: { launches: ['1993-036'], parentNorads: [22675] } }),
      /FRAGMENTS SHOWN.*FRAGMENTS · 1993-036/,
    );
  });
});
