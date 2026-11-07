import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PolicyJa, SystemTimeSource } from '@llm-vap/contracts';
import type { MaaiFramesDropped, MaaiVapStateMessage, MaaiWorkerStatus } from '@llm-vap/contracts';
import { REPO_ROOT, type MaaiVapPolicy } from '../../src/maai';

export { SystemTimeSource };
export type { MaaiFramesDropped, MaaiVapStateMessage, MaaiWorkerStatus };

export function loadPolicyVapForTest(): MaaiVapPolicy {
  const policy = PolicyJa.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'policy.ja.json'), 'utf-8')));
  return policy.vap;
}
