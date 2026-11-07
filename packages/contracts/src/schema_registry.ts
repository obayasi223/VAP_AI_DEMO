/**
 * JSON Schema を生成する対象の一覧。名前が schemas/<name>.schema.json になる。
 * Python 側は同じ名前で読み込む（workers/maai/contract/validator.py）。
 */
import { z } from 'zod';
import { BrowserToNode, NodeToBrowser } from './browser_rpc';
import { ResearchEvent } from './events';
import { MaaiNodeToWorker, MaaiWorkerToNode } from './maai_rpc';
import { PolicyHri2025, PolicyJa } from './policy';
import { TurnInputs, TurnStepOutput } from './turn';
import { VapState } from './vap';

export const SCHEMAS = {
  'maai_rpc.node_to_worker': MaaiNodeToWorker,
  'maai_rpc.worker_to_node': MaaiWorkerToNode,
  'browser_rpc.browser_to_node': BrowserToNode,
  'browser_rpc.node_to_browser': NodeToBrowser,
  events: ResearchEvent,
  vap_state: VapState,
  'turn.inputs': TurnInputs,
  'turn.step_output': TurnStepOutput,
  'policy.hri2025': PolicyHri2025,
  'policy.ja': PolicyJa,
} as const;

export type SchemaName = keyof typeof SCHEMAS;

export function toJsonSchema(name: SchemaName): Record<string, unknown> {
  const schema = z.toJSONSchema(SCHEMAS[name], {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
  }) as Record<string, unknown>;
  return { $id: `${name}.schema.json`, ...schema };
}
