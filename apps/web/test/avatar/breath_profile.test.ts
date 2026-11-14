import { describe, expect, it } from 'vitest';
import { DEFAULT_PREP_BREATH } from '../../src/avatar/breath';
import { BREATH_PROFILES, parseBreathProfile } from '../../src/avatar/breath_profile';

describe('吸気の動きの大きさの切り替え', () => {
  it('未指定と不正な値は既定', () => {
    expect(parseBreathProfile(null)).toBe('default');
    expect(parseBreathProfile('strong')).toBe('default');
    expect(parseBreathProfile('weak')).toBe('weak');
  });

  it('既定は動きを変えない', () => {
    expect(BREATH_PROFILES.default).toEqual({});
  });

  it('振幅は 既定 > original > weak の順', () => {
    const size = (id: 'original' | 'weak', key: 'depth' | 'shoulderDeg') => BREATH_PROFILES[id][key] as number;
    for (const key of ['depth', 'shoulderDeg'] as const) {
      expect(DEFAULT_PREP_BREATH[key]).toBeGreaterThan(size('original', key));
      expect(size('original', key)).toBeGreaterThan(size('weak', key));
    }
  });
});
