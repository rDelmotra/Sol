import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ASK_HINT, WAVE_BARS, askCaption, waveBars } from './ask-bar';

describe('ask bar helpers', () => {
  it('48 bars, tallest in the middle (18 px), 4 px at the left edge', () => {
    const bars = waveBars();
    assert.equal(bars.length, WAVE_BARS);
    assert.ok(Math.abs(bars[0].height - 4) < 1e-9);
    assert.ok(Math.abs(bars[24].height - 18) < 1e-9);
    assert.ok(bars[24].height > bars[40].height);
  });
  it('delays cycle under 900 ms', () => {
    const bars = waveBars();
    assert.equal(bars[1].delayMs, 40);
    assert.equal(bars[23].delayMs, (23 * 40) % 900);
    assert.ok(bars.every((b) => b.delayMs < 900));
  });
  it('caption follows the answer state', () => {
    assert.deepEqual(askCaption(null), { text: ASK_HINT, error: false });
    assert.equal(askCaption({ status: 'compiling', question: 'q' }).text, 'COMPILING…');
    assert.equal(askCaption({ status: 'ready', question: 'q', interpretation: 'x' }).text, '“q” → x');
    assert.equal(askCaption({ status: 'ready', question: 'q' }).text, '“q” → ready');
    assert.deepEqual(askCaption({ status: 'error', question: 'q', message: 'bad' }), { text: 'bad', error: true });
    assert.equal(askCaption({ status: 'error', question: 'q' }).text, 'Ask failed');
  });
});
