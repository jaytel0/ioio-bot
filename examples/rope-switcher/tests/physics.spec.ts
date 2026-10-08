import { test, expect } from '@playwright/test';
import { Spring, CABLE_SPRING, PLUG_SPRING, COLOR_SPRING } from '../src/physics';

test('spring return is consistent at 30, 60 and 120 Hz', () => {
  for (const dynamics of [CABLE_SPRING, PLUG_SPRING, COLOR_SPRING]) {
    const values = [30, 60, 120].map(hz => {
      const spring = new Spring(320, dynamics);
      spring.target = 142;
      for (let i = 0; i < hz / 2; i++) spring.step(1 / hz);
      return spring.value;
    });
    expect(values[0]).toBeCloseTo(values[1], 5);
    expect(values[1]).toBeCloseTo(values[2], 5);
  }
});

test('a settled spring sleeps, then wakes for a new destination', () => {
  const spring = new Spring(0, CABLE_SPRING);
  spring.target = 200;
  for (let i = 0; i < 600 && !spring.settled; i++) spring.step(1 / 60);
  expect(spring.settled).toBe(true);
  expect(spring.value).toBe(200);
  spring.step(1 / 60);
  expect(spring.value).toBe(200);
  spring.target = 60;
  expect(spring.settled).toBe(false);
  spring.step(1 / 60);
  expect(spring.value).toBeLessThan(200);
  expect(spring.value).toBeGreaterThan(60);
});

test('grabbing a returning plug resets velocity; reduced motion settles immediately', () => {
  const spring = new Spring(300);
  spring.target = 142;
  spring.step(1 / 60);
  spring.jump(spring.value);
  expect(spring.velocity).toBe(0);
  expect(spring.settled).toBe(true);
  spring.target = 348;
  spring.step(1 / 60, true);
  expect(spring.value).toBe(348);
  expect(spring.settled).toBe(true);
});
