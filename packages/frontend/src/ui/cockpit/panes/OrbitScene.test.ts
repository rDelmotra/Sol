import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrbitElements } from '@orbitwatch/orbital-core';
import { OrbitScene } from './OrbitScene';
import { layoutOrbit, prepareOrbit } from './orbit-diagram';

const iss: OrbitElements = {
  meanMotionRevPerDay: 15.5,
  eccentricity: 0.0005,
  meanAnomalyDeg: 10,
  inclinationDeg: 51.6,
  raanDeg: 100,
  argPerigeeDeg: 80,
  epochMs: Date.UTC(2026, 9, 1),
};
const molniya: OrbitElements = { ...iss, meanMotionRevPerDay: 2.006, eccentricity: 0.72, inclinationDeg: 63.4 };

function render(el: OrbitElements, uid = 'u1'): string {
  const prep = prepareOrbit(el)!;
  return renderToStaticMarkup(createElement(OrbitScene, { layout: layoutOrbit(prep), uid }));
}

describe('OrbitScene (the static markup of the orbit card)', () => {
  it('renders one svg of the card size, with no NaN or undefined', () => {
    for (const el of [iss, molniya, { ...iss, inclinationDeg: 98.2 }, { ...iss, inclinationDeg: 0, eccentricity: 0 }]) {
      const html = render(el);
      assert.match(html, /^<svg viewBox="0 0 200 130"/);
      assert.ok(!/NaN|undefined|Infinity/.test(html));
    }
  });
  it('every url(#id) points at an id the svg defines, and the uid keeps two cards apart', () => {
    const a = render(iss, 'a1'), b = render(iss, 'b2');
    for (const [html, uid] of [[a, 'a1'], [b, 'b2']] as const) {
      const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
      assert.ok(ids.length >= 3 && ids.every((id) => id.startsWith(uid)));
      for (const m of html.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(m[1]!), m[1]);
    }
    assert.ok(![...a.matchAll(/ id="([^"]+)"/g)].some((m) => b.includes(` id="${m[1]}"`)));
  });
  it('has both marker groups, hidden until the parent places them', () => {
    assert.equal((render(iss).match(/<g display="none"/g) ?? []).length, 2);
  });
  it('labels the ascending node and the inclination always, the perigee only when eccentric', () => {
    assert.match(render(iss), />AN</);
    assert.match(render(iss), />i 51\.6°</);
    assert.ok(!/>PE</.test(render(iss)));
    assert.match(render(molniya), />PE</);
  });
});
