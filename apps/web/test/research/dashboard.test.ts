// vitest の include は *.test.ts だけなので、JSX を使わずこの拡張子にしている。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createFakeEventScript } from '../../src/research/fake_events';
import { ResearchDashboard } from '../../src/research/ResearchDashboard';
import { ResearchViewStore } from '../../src/research/view_store';

function render(store: ResearchViewStore): string {
  return renderToStaticMarkup(createElement(ResearchDashboard, { snapshot: store.snapshot() }));
}

describe('ResearchDashboard', () => {
  it('偽データの間は明示する', () => {
    const store = new ResearchViewStore({ kind: 'fake', label: '偽', synthetic: true });
    for (const event of createFakeEventScript()) store.event(event);
    const html = render(store);
    expect(html).toContain('data-testid="fake-banner"');
    expect(html).toContain('偽データの表示です');
    // 接続、プロバイダ、現在の状態、費用、遅延の 5 つの見出しすべて
    expect(html.match(/偽データ<\/span>/g)).toHaveLength(5);
  });

  it('実データの口では偽データと表示しない', () => {
    const html = render(new ResearchViewStore({ kind: 'ws', label: 'ws', synthetic: false }));
    expect(html).not.toContain('fake-banner');
    expect(html).not.toContain('偽データ');
  });

  it('データがなければ未計測と書き、0 を出さない', () => {
    const html = render(new ResearchViewStore({ kind: 'none', label: 'なし', synthetic: false }));
    expect(html).toContain('未計測（cost.usage なし）');
    expect(html).toContain('未計測（対象のイベントなし）');
    expect(html).toContain('未計測（事後整列が未実施）');
    expect(html).toContain('時計差: 未計測');
    expect(html).not.toMatch(/\$0\.0000/);
    expect(html).not.toMatch(/<td[^>]*>0<\/td>/);
  });

  it('費用は推定と書き、不明を含むなら下限と書く', () => {
    const store = new ResearchViewStore({ kind: 'fake', label: '偽', synthetic: true });
    for (const event of createFakeEventScript()) store.event(event);
    const html = render(store);
    expect(html).toContain('請求額ではありません');
    expect(html).toMatch(/推定 \$0\.\d{4}/);
    expect(html).toMatch(/不明 \d+ 件を含まない下限/);
    expect(html).toContain('rate_not_in_provider_matrix');
  });

  it('test double を含む実データの口では証拠に数えないと出す', () => {
    const store = new ResearchViewStore({ kind: 'jsonl', label: 'a', synthetic: false });
    for (const event of createFakeEventScript()) store.event(event);
    const html = render(store);
    expect(html).toContain('not-evidence-banner');
    expect(html).toContain('受け入れの証拠に数えません');
  });

  it('不合格の件数を出す', () => {
    const store = new ResearchViewStore({ kind: 'ws', label: 'ws', synthetic: false });
    store.event({ broken: true });
    expect(render(store)).toContain('1 件');
  });
});
