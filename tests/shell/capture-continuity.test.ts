import { describe, expect, it, vi } from 'vitest';
import type { TrackingSample } from '../../src/shared/contracts';
import { CONFIRM_FRESH_MS, drawLandmarkOverlay, drawMirroredPreview, HAND_LOSS_MS, rejectionHint, SampleGate, SelectedHandContinuity, type AnchorResult } from '../../src/renderer/tracking';

const anchor = (x = 0.5, y = 0.5): AnchorResult => ({ valid: true, anchor: { x, y }, reason: 'valid' });
const invalid: AnchorResult = { valid: false, anchor: null, reason: 'multiple subjects' };
const sample = (frameId = 1, captureTimestamp = 100): TrackingSample => ({ generation: 4, frameId, captureTimestamp, mode: 'palm', valid: true, anchor: { x: 0.5, y: 0.5 }, qualityReason: 'valid', selectedHand: 'Left' });

describe('selected-hand continuity (synthetic, no identity claim)', () => {
  it('selects one model label and rejects ambiguity and other labels without transfer', () => {
    const hand = new SelectedHandContinuity();
    expect(hand.observe(anchor(), 'Left', 100, 100).valid).toBe(true);
    expect(hand.selectedHand).toBe('Left');
    expect(hand.observe(invalid, null, 110, 110).valid).toBe(false);
    expect(hand.observe(anchor(), 'Right', 120, 120).reason).toBe('different hand label');
    expect(hand.selectedHand).toBe('Left');
    expect(hand.observe(anchor(), null, 130, 130).valid).toBe(false);
    expect(hand.observe(anchor(), 'Left', 140, 140).valid).toBe(true);
  });
  it('rejects jumps exceeding .12 from the preceding valid anchor; invalids do not move that anchor', () => {
    const hand = new SelectedHandContinuity();
    hand.observe(anchor(0, 0), 'Left', 0, 0);
    expect(hand.observe(anchor(0.12, 0), 'Left', 10, 10).valid).toBe(true);
    expect(hand.observe(anchor(0.241, 0), 'Left', 20, 20).reason).toBe('hand anchor jump');
    expect(hand.observe(anchor(0.35, 0), 'Left', 30, 30).valid).toBe(false);
    expect(hand.observe(anchor(0.13, 0), 'Left', 40, 40).valid).toBe(true);
  });
  it(`declares loss ${HAND_LOSS_MS}ms after the last accepted result and requires explicit recent matching confirmation`, () => {
    const hand = new SelectedHandContinuity(); hand.observe(anchor(), 'Left', 100, 100);
    expect(hand.expire(100 + HAND_LOSS_MS - 0.001)).toBe(false); expect(hand.expire(100 + HAND_LOSS_MS)).toBe(true);
    const t = 100 + HAND_LOSS_MS;
    expect(hand.expire(t + 10)).toBe(false); expect(hand.confirm(t + 10)).toBe(false);
    expect(hand.observe(anchor(0.9), 'Right', t + 20, t + 20).valid).toBe(false); expect(hand.confirm(t + 20)).toBe(false);
    expect(hand.observe(anchor(0.9), 'Left', t + 30, t + 30).reason).toBe('confirm selected hand');
    expect(hand.confirm(t + 30 + CONFIRM_FRESH_MS)).toBe(false);
    hand.observe(anchor(0.9), 'Left', t + 600, t + 600); expect(hand.confirm(t + 610)).toBe(true);
    expect(hand.observe(anchor(0.91), 'Left', t + 620, t + 620).valid).toBe(true);
  });
  it('expires before processing a result that arrives after a long gap, and cannot confirm an ambiguous frame', () => {
    const hand = new SelectedHandContinuity(); hand.observe(anchor(), 'Left', 100, 100);
    expect(hand.observe(anchor(), 'Left', 100 + HAND_LOSS_MS + 1, 100 + HAND_LOSS_MS + 1).reason).toBe('confirm selected hand');
    hand.observe(invalid, null, 1200, 1200); expect(hand.confirm(1200)).toBe(false);
  });
  it('normal pipeline latency never declares loss (regression: palm calibration got 0 samples)', () => {
    // 15 fps results, each arriving 200 ms after capture; the watchdog ticks every 10 ms.
    const hand = new SelectedHandContinuity();
    let locked = false, valid = 0;
    for (let receipt = 300; receipt < 5000; receipt += 10) {
      if (hand.expire(receipt)) locked = true;
      if (receipt % 70 === 0 && hand.observe(anchor(0.5 + (receipt % 140) / 10000), 'Left', receipt - 200, receipt).valid) valid++;
    }
    expect(locked).toBe(false);
    expect(valid).toBeGreaterThan(60);
  });
  it('a confirm ~300 ms after the candidate is accepted and the lock does not return immediately', () => {
    const hand = new SelectedHandContinuity(); hand.setSelectedHand('Left');
    hand.observe(anchor(), 'Left', 900, 1000); // capture 900, received 1000
    expect(hand.confirm(1300)).toBe(true);
    for (let now = 1300; now < 1300 + HAND_LOSS_MS - 10; now += 10) expect(hand.expire(now)).toBe(false);
    expect(hand.observe(anchor(0.51), 'Left', 1250, 1350).valid).toBe(true);
  });
  it('saved selections require confirmation and cannot silently choose another label', () => {
    const hand = new SelectedHandContinuity(); hand.setSelectedHand('Right');
    expect(hand.observe(anchor(), 'Left', 100, 100).reason).toBe('different hand label');
    expect(hand.confirm(100)).toBe(false);
    expect(hand.observe(anchor(), 'Right', 110, 110).reason).toBe('confirm selected hand');
    expect(hand.confirm(110)).toBe(true);
    hand.setSelectedHand(null); expect(hand.observe(anchor(), 'Left', 120, 120).valid).toBe(true);
  });
});

describe('stale inference and preview', () => {
  it('rejects stale, future, out-of-order, duplicate, replaced-generation and mode results', () => {
    const gate = new SampleGate();
    expect(gate.accept(sample(), 4, 'palm', 100)).toBe(true);
    expect(gate.accept(sample(), 4, 'palm', 101)).toBe(false);
    expect(gate.accept(sample(2, 100), 4, 'palm', 110)).toBe(false);
    expect(gate.accept(sample(2, 101), 5, 'palm', 110)).toBe(false);
    expect(gate.accept(sample(2, 101), 4, 'head', 110)).toBe(false);
    expect(gate.accept(sample(2, 101), 4, 'palm', 351)).toBe(false);
    expect(gate.accept(sample(2, 400), 4, 'palm', 399)).toBe(false);
    expect(gate.accept(sample(2, 101), 4, 'palm', 350.999)).toBe(true);
    expect(gate.accept(sample(3, NaN), 4, 'palm', 400)).toBe(false);
  });
  it('flips the preview canvas exactly once without changing the inference source', () => {
    const context = { save: vi.fn(), translate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(), restore: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
    drawMirroredPreview(canvas, video);
    expect(context.scale).toHaveBeenCalledExactlyOnceWith(-1, 1);
    expect(context.translate).toHaveBeenCalledExactlyOnceWith(640, 0);
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(video, 0, 0, 640, 480);
    expect(context.restore).toHaveBeenCalledOnce();
  });
});

describe('preview overlay and hints', () => {
  const canvasWith = () => {
    const calls: { arc: number[][] } = { arc: [] };
    const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), stroke: vi.fn(), fill: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), arc: (x: number, y: number) => calls.arc.push([x, y]), strokeStyle: '', fillStyle: '', lineWidth: 0 };
    return { canvas: { width: 640, height: 480, getContext: () => context } as unknown as HTMLCanvasElement, calls, context };
  };
  it('mirrors landmarks once to match the mirrored preview', () => {
    const { canvas, calls } = canvasWith();
    drawLandmarkOverlay(canvas, { mode: 'palm', landmarks: [{ x: 0.2, y: 0.5 }], valid: true, receivedAt: 100 }, 150);
    expect(calls.arc[0]).toEqual([0.8 * 640, 0.5 * 480]);
  });
  it('draws nothing for a stale overlay and greys out rejected frames', () => {
    const stale = canvasWith();
    drawLandmarkOverlay(stale.canvas, { mode: 'palm', landmarks: [{ x: 0.2, y: 0.5 }], valid: true, receivedAt: 100 }, 400);
    expect(stale.calls.arc).toEqual([]);
    const rejected = canvasWith();
    drawLandmarkOverlay(rejected.canvas, { mode: 'palm', landmarks: [{ x: 0.2, y: 0.5 }], valid: false, receivedAt: 100 }, 110);
    expect(rejected.context.fillStyle).toBe('#A9B0B0');
  });
  it('explains rejections in plain language', () => {
    expect(rejectionHint('multiple subjects', 'palm')).toBe('Two hands in view — show only one');
    expect(rejectionHint('confirm selected hand', 'palm')).toContain('press Confirm');
    expect(rejectionHint('no subject', 'head')).toBe('No face in view');
    expect(rejectionHint('valid', 'palm')).toBeNull();
  });
});
