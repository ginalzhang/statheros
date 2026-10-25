import { expect, it } from 'vitest';
import { StillLift } from '../src/main/still-lift';

it('requires movement beyond 15 points and a full 1.2 second dwell', () => {
  const lift = new StillLift();
  expect(lift.update({ x: 0, y: 0 }, 0)).toBe(false);
  expect(lift.update({ x: 15, y: 0 }, 5000)).toBe(false);
  expect(lift.update({ x: 16, y: 0 }, 5001)).toBe(false);
  expect(lift.update({ x: 23.5, y: 0 }, 6200)).toBe(false);
  expect(lift.update({ x: 16, y: 0 }, 6201)).toBe(true);
});
it('restarts the dwell after movement outside its radius', () => {
  const lift = new StillLift();
  lift.update({ x: 0, y: 0 }, 0);
  lift.update({ x: 16, y: 0 }, 1);
  expect(lift.update({ x: 24, y: 0 }, 1200)).toBe(false);
  expect(lift.update({ x: 24, y: 0 }, 2399)).toBe(false);
  expect(lift.update({ x: 24, y: 0 }, 2400)).toBe(true);
});
it('cannot carry a dwell through a release, invalid frame, or new stroke', () => {
  const lift = new StillLift();
  lift.update({ x: 0, y: 0 }, 0); lift.update({ x: 16, y: 0 }, 1);
  lift.reset();
  expect(lift.update({ x: 16, y: 0 }, 2000)).toBe(false);
  expect(lift.update({ x: 16, y: 0 }, 10000)).toBe(false);
  lift.update({ x: 32, y: 0 }, 10001);
  expect(lift.update({ x: 32, y: 0 }, 11201)).toBe(true);
  expect(lift.update({ x: 32, y: 0 }, 15000)).toBe(false);
});
