import { describe, expect, test } from 'vitest';

import { NATIVE_SEARCH_WINDOW, toNativeSearchLimit } from './index';

describe('native search window', () => {
  test('"everything" becomes the largest window the native index accepts', () => {
    expect(toNativeSearchLimit(Infinity, 0)).toBe(NATIVE_SEARCH_WINDOW);
    expect(toNativeSearchLimit(Infinity, 9_000)).toBe(1_000);
  });

  test('small limits are kept and offsets past the window give nothing', () => {
    expect(toNativeSearchLimit(10, 20)).toBe(10);
    expect(toNativeSearchLimit(50, 9_990)).toBe(10);
    expect(toNativeSearchLimit(10, 20_000)).toBe(0);
  });
});
