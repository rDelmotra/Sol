import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { encounterFixture } from '../../../data/ssa-fixtures';
import { ManoeuvreTag } from './ManoeuvreTag';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const html = (e: ReturnType<typeof encounterFixture>, noradId: number) => renderToStaticMarkup(createElement(ManoeuvreTag, { e, noradId, nowMs: NOW }));

describe('ManoeuvreTag', () => {
  it('shows "manoeuvred 2 d ago" for the other object, in the row text style (no warning colours)', () => {
    const e = encounterFixture(1, 100, 200, '2026-10-31T20:00:00Z');
    e.b.lastManoeuvreAt = '2026-10-29T10:00:00.000Z';
    const out = html(e, 100);
    assert.match(out, />manoeuvred 2 d ago</);
    assert.match(out, /data-testid="manoeuvre-tag"/);
    assert.match(out, /var\(--hud-text-faint\)/);
    const colours = [...out.matchAll(/color:([^;"]+)/g)].map((m) => m[1]);
    assert.deepEqual(colours, ['var(--hud-text-faint)']);
  });
  it('says so when the focused object is the one that changed orbit', () => {
    const e = encounterFixture(1, 100, 200, '2026-10-31T20:00:00Z');
    e.a.lastManoeuvreAt = '2026-10-31T09:00:00.000Z';
    assert.match(html(e, 100), />this object manoeuvred 3 h ago</);
    assert.match(html(e, 200), />manoeuvred 3 h ago</);
  });
  it('renders nothing when neither object has a recent orbit change (manoeuvrable alone does not count)', () => {
    const e = encounterFixture(1, 100, 200, '2026-10-31T20:00:00Z', { manoeuvrable: true });
    assert.equal(html(e, 100), '');
  });
});
