/** 招待の語句検出。STT の文字列の照合で、語句は自作の案（実対話の誤検出率は未測定）。 */
import { describe, expect, it } from 'vitest';
import { detectInvitation } from '../../src/control';
import { Driver, T0, hri2025, ja, jaAppendixA, kinds, ready, turnAllowed } from './helpers';

const source = { segment_id: 3, transcript_revision: 42 };

describe('detectInvitation', () => {
  it.each([
    ['どうぞ', 'go_ahead', 'どうぞ'],
    ['お先にどうぞ。', 'go_ahead', 'どうぞ'],
    ['どうぞどうぞ', 'go_ahead', 'どうぞどうぞ'],
    ['話してください', 'go_ahead', '話してください'],
    ['何か言いたい？', 'go_ahead', '何か言いたい'],
    ['言いたいことありますか', 'go_ahead', '言いたいことありますか'],
    ['何かありますか', 'go_ahead', '何かありますか'],
    ['あなたはどう思いますか', 'direct_question', 'どう思いますか'],
    ['いかがでしょうか', 'direct_question', 'いかがでしょうか'],
    ['ちょっと教えて', 'direct_question', '教えて'],
    ['そちらの番です', 'other', 'そちらの番です'],
  ])('検出: %s', (text, kind, phrase) => {
    expect(detectInvitation(text, source).invitation).toEqual({ detected: true, kind, phrase, ...source });
  });

  it.each([
    ['どうぞよろしくお願いします'],
    ['どうぞって言ってない'],
    ['友達に話して'],
    ['私はそれを話したい'],
    ['何か言いたいです'],
    ['そこに何かある'],
    ['それはどう思っても'],
    ['もう昼ご飯食べた？'], // 上昇調でしか分からない質問は取らない
    ['ちょっと待って'],
    [''],
  ])('検出しない: %s', (text) => {
    expect(detectInvitation(text, source).invitation).toEqual({ detected: false });
  });

  it('語句が句読点や空白で割れても文末なら検出する', () => {
    expect(detectInvitation('お先に ど、うぞ', source).invitation.detected).toBe(true);
  });
  it('一致した規則の ID を返す', () => {
    expect(detectInvitation('どうぞ', source).rule_id).toBe('doozo');
  });
});

describe('TurnManager の招待', () => {
  const USER: [number, number, boolean] = [0.3, 0.3, false];

  it('ja: VAP が譲渡を示さなくても、発話終了から MIN_GAP 後に許可し、根拠を残す', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, { p: [0.3, 0.3, true], text: 'お先にどうぞ' });
    d.tick(T0 + 499, { p: USER });
    expect(d.state.permitted_to_speak).toBe(false);
    const decisions = d.tick(T0 + 500, { p: USER, prefetch: ready() });
    expect(kinds(decisions)).toContain('start_speech');
    expect(turnAllowed(decisions)).toMatchObject({
      turn_allowed: true,
      decision_source: 'invitation',
      invitation: { detected: true, kind: 'go_ahead', phrase: 'どうぞ', segment_id: 0, transcript_revision: 1 },
      reason: 'invitation:doozo',
      p_now: { value: 0.3 },
    });
  });
  it('ja: 利用者が話している間は許可しない', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, { p: [0.3, 0.3, true], text: 'どうぞ' });
    d.tick(T0 + 5000, { p: [0.3, 0.3, true] });
    expect(d.state.permitted_to_speak).toBe(false);
  });
  it('ja: 続きが認識されて文末でなくなれば取り消す', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, { p: [0.3, 0.3, true], text: 'どうぞ' });
    expect(d.state.invitation.detected).toBe(true);
    d.tick(T0 + 20, { p: USER, text: 'どうぞよろしく' });
    expect(d.state.invitation.detected).toBe(false);
  });
  it('ja: AI が話し始めたら招待は消える', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, { p: [0.3, 0.3, true], text: 'どうぞ' });
    d.tick(T0 + 200, { p: USER }); // 準備の起動
    d.tick(T0 + 500, { p: USER, prefetch: ready() });
    expect(d.state.segment_id).toBe(1);
    expect(d.state.invitation).toEqual({ detected: false });
  });
  it('hri2025: 招待は原著にないので記録するだけで許可しない', () => {
    const d = new Driver(hri2025());
    d.tick(T0, { p: [0.3, 0.3, true], text: 'どうぞ' });
    d.tick(T0 + 200, { p: USER }); // 準備の起動
    const decisions = d.tick(T0 + 500, { p: USER, prefetch: ready() });
    expect(d.state.invitation.detected).toBe(true);
    expect(kinds(decisions)).not.toContain('start_speech');
  });
});
