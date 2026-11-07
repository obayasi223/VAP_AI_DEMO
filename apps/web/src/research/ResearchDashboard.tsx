/**
 * 研究者向けの最小の状態表示（I1）。表示だけで、データの取得は feed.ts の口に任せる。
 * 規則: 未計測は 0 と書かず「未計測」、推定は「推定」と書く。偽データの間は常に明示する。
 * I2 で p の時系列、候補のライブ表示、準備・割り込みの率、研究者のメモを足した（LivePanels.tsx）。
 * 録音、条件切替、WoZ は波4（E3、J）の範囲で、置き場だけある。
 */
import type { CostSummary, LatencyRow } from '@llm-vap/analysis';
import { CandidatePanel, NotePanel, OutcomePanel, TimelinePanel } from './LivePanels';
import styles from './research.module.css';
import type { CurrentState, ResearchSnapshot } from './view_store';

const CONNECTION_LABEL: Record<ResearchSnapshot['connection']['state'], string> = {
  idle: '未接続',
  connecting: '接続中',
  open: '接続済み',
  closed: '切断',
  error: 'エラー',
};

const HEALTH_LABEL: Record<string, string> = { ok: '正常', degraded: '低下', down: '停止' };

const REASON_LABEL: Record<string, string> = {
  no_samples_in_log: '対象のイベントなし',
  posthoc_alignment_not_in_log: '事後整列が未実施',
  endpoint_clock_uncorrected: '時計差が未補正',
  no_audio_frame_time_anchor: '音声位置と時刻の対応なし',
  audio_frame_anchor_too_far: '音声位置の基準点が遠い',
  evidence_invalid: '根拠の検証が不合格',
  evidence_span_not_found_in_stt: '根拠が STT に見つからない',
  signal_not_visible: '背景タブで未描画',
  signal_sent_missing: 'signal.sent なし',
  output_latency_unknown: '出力遅延が不明',
};

function reasonText(reason: string): string {
  if (reason.startsWith('all_excluded:')) {
    const parts = reason.slice('all_excluded:'.length).split(',');
    return `全件除外: ${parts.map((p) => REASON_LABEL[p] ?? p).join('、')}`;
  }
  return REASON_LABEL[reason] ?? reason;
}

function ms(value: number): string {
  return value.toFixed(0);
}

function Chip({ synthetic }: { synthetic: boolean }) {
  return synthetic ? <span className={styles.fakeChip}>偽データ</span> : null;
}

function Section({ title, synthetic, children }: { title: string; synthetic: boolean; children: React.ReactNode }) {
  return (
    <section className={styles.card}>
      <h2 className={styles.heading}>
        {title} <Chip synthetic={synthetic} />
      </h2>
      {children}
    </section>
  );
}

function yesNo(value: boolean | null): string {
  return value === null ? '不明' : value ? 'はい' : 'いいえ';
}

function CurrentPanel({ current }: { current: CurrentState }) {
  const rows: [string, string][] = [
    [
      'VAP',
      current.vap === null
        ? '未受信'
        : `利用者の発話 ${yesNo(current.vap.user_speaking)} / AI の発話 ${yesNo(current.vap.system_speaking)}（${current.vap.channel_layout}, ${current.vap.model_variant}, frame ${current.vap.audio_frame}）`,
    ],
    [
      '発話の判定',
      current.turn === null
        ? '未受信'
        : `${current.turn.allowed ? '許可' : '不許可'}（${current.turn.source}, VAP ${current.turn.freshness}）${current.turn.reason}`,
    ],
    [
      'AI の発話',
      current.speech === null
        ? '未受信'
        : `${{ speaking: '発話中', ended: '終了', interrupted: '割り込みで停止' }[current.speech.state]}（id ${current.speech.playback_id}, ${current.speech.origin}）`,
    ],
    ['視線', current.gaze === null ? '未受信' : `${current.gaze.target}（${current.gaze.reason}）`],
    [
      '音声',
      current.audio === null
        ? '未受信'
        : `${current.audio.context} / ${current.audio.visibility}、欠損 ${current.audio.frames_lost}、アンダーラン ${current.audio.underrun_count}、出力遅延 ${current.audio.output_latency_ms === null ? '不明' : `${current.audio.output_latency_ms}ms`}`,
    ],
    [
      'マイク処理',
      current.audio === null
        ? '未受信'
        : `AEC ${yesNo(current.audio.echo_cancellation)} / NS ${yesNo(current.audio.noise_suppression)} / AGC ${yesNo(current.audio.auto_gain_control)}`,
    ],
  ];
  return (
    <dl className={styles.list}>
      {rows.map(([label, value]) => (
        <div key={label} className={styles.listRow}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function CostPanel({ cost }: { cost: CostSummary }) {
  if (cost.status === 'no_usage') return <p className={styles.unmeasured}>未計測（cost.usage なし）</p>;
  return (
    <>
      <p className={styles.note}>定価から計算した推定で、請求額ではありません。</p>
      <p className={styles.total} data-testid="cost-total">
        {cost.estimated_usd === null ? '不明' : `推定 ${usd(cost.estimated_usd)}`}
        {cost.status === 'partial' ? (
          <span className={styles.warnText}>（不明 {cost.unknown_count} 件を含まない下限）</span>
        ) : null}
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>プロバイダ</th>
            <th>推定</th>
            <th>数量</th>
            <th>不明</th>
          </tr>
        </thead>
        <tbody>
          {cost.by_provider.map((row) => (
            <tr key={row.provider}>
              <td>{row.provider}</td>
              <td>{row.estimated_usd === null ? '不明' : `推定 ${usd(row.estimated_usd)}`}</td>
              <td>{row.quantities.map((q) => `${q.quantity} ${q.unit}`).join('、')}</td>
              <td>
                {row.unknown_count === 0
                  ? '0'
                  : `${row.unknown_count}（${Object.keys(row.unknown_reasons).join('、')}）`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const INTERVAL_LABEL: Record<string, string> = {
  content_evidence_to_transcript: '内容の根拠 → 文字起こし',
  content_evidence_to_decision: '内容の根拠 → 判断',
  content_evidence_to_speech: '内容の根拠 → 発声',
  transcript_to_decision: '文字起こし → 判断',
  decision_to_breath: '判断 → 吸気開始',
  breath_to_speech: '吸気開始 → 発声',
  decision_to_speech: '判断 → 発声',
  llm_roundtrip: 'LLM の往復',
  audio_to_stt_arrival: '音声位置 → STT 受信',
  signal_sent_to_first_render: '合図の指示 → 最初の描画',
};

function breakdownText(breakdown: string | null): string {
  if (breakdown === null) return '';
  if (breakdown.startsWith('online:')) return `オンライン近似 ${breakdown.slice('online:'.length)}`;
  if (breakdown.startsWith('official:')) return '正式（事後整列）';
  return breakdown;
}

function LatencyTable({ rows }: { rows: LatencyRow[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>区間</th>
          <th>区分</th>
          <th className={styles.num}>p50</th>
          <th className={styles.num}>p90</th>
          <th className={styles.num}>p95</th>
          <th className={styles.num}>n</th>
          <th className={styles.num}>誤差 ≤</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const stat = row.stat;
          const key = `${row.id}/${row.breakdown ?? ''}`;
          return (
            <tr key={key}>
              <td>{INTERVAL_LABEL[row.id] ?? row.id}</td>
              <td>{breakdownText(row.breakdown)}</td>
              {stat.status === 'unmeasured' ? (
                <td colSpan={5} className={styles.unmeasured}>
                  未計測（{reasonText(stat.reason)}）
                </td>
              ) : (
                <>
                  <td className={styles.num}>{ms(stat.p50)}</td>
                  <td className={styles.num}>{ms(stat.p90)}</td>
                  <td className={styles.num}>{ms(stat.p95)}</td>
                  <td className={styles.num}>{stat.n}</td>
                  <td className={styles.num}>
                    {stat.uncertainty_ms_max === null ? '不明' : stat.uncertainty_ms_max.toFixed(1)}
                  </td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ResearchDashboard({
  snapshot,
  onSendNote,
}: {
  snapshot: ResearchSnapshot;
  onSendNote?: (text: string) => { ok: true } | { ok: false; reason: string };
}) {
  const synthetic = snapshot.feed.synthetic;
  const health = snapshot.connection;
  return (
    <main className={styles.page}>
      {synthetic ? (
        <div className={styles.fakeBanner} role="alert" data-testid="fake-banner">
          偽データの表示です。すべての値は表示確認用の作り物で、実測ではありません。
        </div>
      ) : null}
      {!synthetic && snapshot.not_evidence_reasons.length > 0 ? (
        <div className={styles.warnBanner} role="alert" data-testid="not-evidence-banner">
          受け入れの証拠に数えません: {snapshot.not_evidence_reasons.join('、')}
        </div>
      ) : null}
      <h1 className={styles.title}>研究者画面</h1>

      <Section title="p の時系列" synthetic={synthetic}>
        <TimelinePanel live={snapshot.live} direction={snapshot.direction} />
      </Section>

      <div className={styles.columns}>
        <Section title="発話希望の候補" synthetic={synthetic}>
          <CandidatePanel candidates={snapshot.live.candidates} />
        </Section>
        <div>
          <Section title="準備の取消・空振り、割り込み" synthetic={synthetic}>
            <OutcomePanel prepare={snapshot.live.prepare} interrupts={snapshot.live.interrupts} />
          </Section>
          <Section title="研究者のメモ" synthetic={synthetic}>
            <NotePanel notes={snapshot.notes} canSend={snapshot.can_send_notes && onSendNote !== undefined} {...(onSendNote ? { onSend: onSendNote } : {})} />
          </Section>
        </div>
      </div>

      <Section title="接続" synthetic={synthetic}>
        <p>
          データ源: {snapshot.feed.label} / 状態: <strong>{CONNECTION_LABEL[health.state]}</strong>
          {health.detail ? `（${health.detail}）` : ''}
        </p>
        <p>
          セッション: {snapshot.session_ids.join(', ') || 'なし'} / 条件: {snapshot.condition ?? '不明'} / 最終イベント:{' '}
          {snapshot.last_at_ms === null ? 'なし' : `${ms(snapshot.last_at_ms)}ms`}
        </p>
        <p data-testid="event-counts">
          受信 {snapshot.accepted} 件 / 不合格{' '}
          <span className={snapshot.invalid > 0 ? styles.warnText : undefined}>{snapshot.invalid} 件</span>
          {snapshot.last_invalid ? `（最後: ${snapshot.last_invalid}）` : ''}
        </p>
        {snapshot.clocks.length === 0 ? (
          <p className={styles.unmeasured}>時計差: 未計測</p>
        ) : (
          snapshot.clocks.map((clock) => (
            <p key={clock.source}>
              時計差 {clock.source}: {clock.offset_ms.toFixed(1)}ms（誤差 {clock.error_ms.toFixed(1)}ms
              {clock.rtt_ms === null ? '' : `、RTT ${clock.rtt_ms.toFixed(1)}ms`}）
            </p>
          ))
        )}
      </Section>

      <Section title="プロバイダの状態" synthetic={synthetic}>
        {snapshot.providers.length === 0 ? (
          <p className={styles.unmeasured}>provider.status 未受信</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>プロバイダ</th>
                <th>状態</th>
                <th>区分</th>
                <th>理由</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.providers.map((row) => (
                <tr key={row.provider}>
                  <td>{row.provider}</td>
                  <td className={styles[`health_${row.status}`]}>{HEALTH_LABEL[row.status] ?? row.status}</td>
                  <td>{row.provider_class}</td>
                  <td>
                    {row.reason ?? ''}
                    {row.retry_attempt > 0 ? `（再試行 ${row.retry_attempt}）` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="現在の状態" synthetic={synthetic}>
        <CurrentPanel current={snapshot.current} />
      </Section>

      <Section title="費用" synthetic={synthetic}>
        <CostPanel cost={snapshot.cost} />
      </Section>

      <Section title="遅延の分位点（ms）" synthetic={synthetic}>
        <LatencyTable rows={snapshot.latency.rows} />
      </Section>

      <section className={`${styles.card} ${styles.placeholder}`} data-testid="wave4-placeholder">
        <h2 className={styles.heading}>録音・条件の切替・WoZ</h2>
        <p className={styles.unmeasured}>まだありません。波4（E3 と J）でここに追加します。</p>
      </section>
    </main>
  );
}
