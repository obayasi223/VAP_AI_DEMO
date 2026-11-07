import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_NOT_WIRED } from '../src/index';

describe('orchestrator scaffold', () => {
  it('resolves contracts through the workspace and declares itself unwired', () => {
    expect(ORCHESTRATOR_NOT_WIRED).toBe(true);
  });
});
