// Guard for decision D10 (state/DECISIONS.md): the idle HUD is still. No looping CSS or SVG
// animation, and no animation frame loop, may live in ui/cockpit. One-shot transitions are fine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('the cockpit HUD is still when idle (D10)', () => {
  const files = sources(DIR);
  it('scans the cockpit sources (sanity)', () => {
    assert.ok(files.length > 20);
  });
  it('has no infinite or indefinite animation', () => {
    const bad = files.filter((f) => /\binfinite\b|repeatCount\s*=\s*["{']*indefinite|animation-iteration-count/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(bad.map((f) => path.relative(DIR, f)), []);
  });
  it('has no SMIL <animate> elements', () => {
    const bad = files.filter((f) => /<animate(Transform|Motion)?\b/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(bad.map((f) => path.relative(DIR, f)), []);
  });
  it('the orbit diagram has no frame loop and no spin', () => {
    const src = ['OrbitDiagram.tsx', 'OrbitScene.tsx', 'orbit-diagram.ts'].map((f) => fs.readFileSync(path.join(DIR, 'panes', f), 'utf8')).join('\n');
    assert.ok(!/requestAnimationFrame|SPIN_/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  });
});
