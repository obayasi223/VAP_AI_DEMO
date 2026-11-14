/** 印のボタン（docs/design/two_ai/03 §3.2、§5.1）。discussion の間だけ、押すと two_ai.marker を 1 件、反応は両条件で同じ。 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TwoAiMarker } from '@llm-vap/contracts/browser_rpc';
import { MARKER_FLASH_MS, MarkerButton } from '../../src/session/two_ai_marker';
import { TwoAiScreen } from '../../app/(participant)/two_ai/TwoAiScreen';
import { conditionRun, harness, markerHtml } from './two_ai_harness';

describe('MarkerButton', () => {
  it('有効でなければ送らない。押すと client_t_ms つきの two_ai.marker を返し、短く光る', () => {
    let now = 1000;
    const button = new MarkerButton({ now: () => now, newId: () => 'mk_1' });
    expect(button.press()).toBeNull();
    button.setEnabled(true);
    const message = button.press();
    expect(message).toEqual({ type: 'two_ai.marker', marker_id: 'mk_1', client_t_ms: 1000 });
    expect(TwoAiMarker.safeParse(message).success).toBe(true);
    expect(button.flashing()).toBe(true);
    now += MARKER_FLASH_MS;
    expect(button.flashing()).toBe(false);
  });

  it('連打も 1 回ずつ送る（間隔の下限は Node が決める）', () => {
    const button = new MarkerButton({ now: () => 5 });
    button.setEnabled(true);
    expect([button.press(), button.press(), button.press()].every((m) => m !== null)).toBe(true);
    expect(button.presses).toBe(3);
  });
});

describe('controller の印', () => {
  it('discussion の間だけ出て、押すと two_ai.marker を 1 件送る。discussion の外では送らない', () => {
    const h = harness();
    h.deliver({ type: 'two_ai.phase', phase: 'intake', instruction_key: 'intake', labels: null });
    h.controller.mark();
    expect(h.sentOf('two_ai.marker')).toHaveLength(0);
    expect(h.controller.current().markerEnabled).toBe(false);
    h.deliver({ type: 'two_ai.phase', phase: 'discussion', instruction_key: 'discussion_a', labels: null });
    expect(h.controller.current().markerEnabled).toBe(true);
    h.controller.mark();
    expect(h.sentOf('two_ai.marker')).toHaveLength(1);
    expect(h.controller.record.markers).toHaveLength(1);
    h.deliver({ type: 'two_ai.phase', phase: 'response', instruction_key: 'response', labels: null });
    h.controller.mark();
    expect(h.sentOf('two_ai.marker')).toHaveLength(1);
  });

  it('押しても AI の表示（視線、話している AI、口）を変えない', () => {
    const h = harness();
    h.deliver({ type: 'two_ai.phase', phase: 'discussion', instruction_key: 'discussion_b', labels: null });
    const before = h.controller.current();
    h.controller.mark();
    const after = h.controller.current();
    expect(after.gaze).toEqual(before.gaze);
    expect(after.speaking).toBe(before.speaking);
    expect(h.avatars.A.calls.filter((c) => c.startsWith('gaze'))).toEqual([]);
  });

  it('光る反応の DOM は両条件で同じ', () => {
    const htmlA = markerHtml(conditionRun('discussion_a'));
    const htmlB = markerHtml(conditionRun('discussion_b'));
    expect(htmlA).toBe(htmlB);
    expect(htmlA).toContain('data-flash="yes"');
  });

  it('discussion の外では印のボタンを描かない', () => {
    const h = harness();
    h.deliver({ type: 'two_ai.phase', phase: 'intake', instruction_key: 'intake', labels: null });
    const html = renderToStaticMarkup(
      createElement(TwoAiScreen, { view: { ...h.controller.current(), lifecycle: 'running' }, instructionCard: false, markerFlash: false, syncFlash: false }),
    );
    expect(html).not.toContain('marker-button');
  });
});
