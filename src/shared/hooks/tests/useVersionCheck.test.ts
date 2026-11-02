import { describe, expect, it } from 'vitest';

import { compareVersions } from '@/shared/hooks/useVersionCheck';

/**
 * The update banner compares the running version against the upstream GitHub
 * release. Fork builds carry a `-fork.N` suffix: semver calls that a
 * prerelease, and the old splitter read `7-fork` as NaN → 0, so a fork of the
 * LATEST release (1.37.7-fork.1 vs 1.37.7) still reported "Update Available".
 */
describe('compareVersions', () => {
  it('treats a fork build of a release as equal to that release', () => {
    expect(compareVersions('1.37.7-fork.1', '1.37.7')).toBe(0);
    expect(compareVersions('1.37.7-fork.10', '1.37.7')).toBe(0);
  });

  it('still reports genuinely older fork builds', () => {
    expect(compareVersions('1.37.7', '1.37.7-fork.1')).toBe(0);
    expect(compareVersions('1.37.4-fork.9', '1.37.7')).toBeLessThan(0);
  });

  it('still reports genuinely newer releases', () => {
    expect(compareVersions('1.37.8', '1.37.7-fork.1')).toBeGreaterThan(0);
    expect(compareVersions('1.38.0', '1.37.7')).toBeGreaterThan(0);
  });

  it('compares plain releases and handles unequal lengths', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
  });
});
