# 時間軸の監査（2026-11-09）

全イベントを orchestrator の単調時計（ms）の 1 本の軸で分析できるかの点検。「確定」はログで確かめたもの、「推定」は根拠があるが直接は確かめていないもの。

## 1. `signal.started` が `signal.sent` より前になる問題

`signal.started.started_at`（ブラウザの rAF 時刻を `mapping.toServerMs` で写した値）と `signal.sent.sent_at` を `parameters.cue_id` と `phase` で組にして、E2E のログと実 API の 2 セッションを点検した。対象の E2E のログは 52 セッションあり、mtime の最後は 03:33:42 で、コミット 125f689（03:34:46）より前。作業中のツリーに修正が入っていた回もあるので、**修正の有無はログの値で判定した**（`clock.sync` の `error_ms − rtt_ms/2` が軸の誤差。0 なら `ThreadAxisEstimator` のない版）。

負の値の原因は 3 種類で、別の問題だった。

### 1.1 -2770ms: 組み合わせの誤り（確定、バグではない）

同じ `cue_id` の `relax` を 2 回送る回がある（解除と脱力の再送）。キーの衝突で最後の `signal.sent` と組にすると、最初の描画との差が負になる（例: 送信 4624 と 7435、最初の描画 4666。-2769ms）。送信順に組にすれば消える。残りの解析とツール（`tools/latency_initiative`）は吸気（1 候補につき最初の合図）だけを数える。

### 1.2 -1.2 秒: timeOrigin の引き算（確定、修正済み）

`docs/overnight_verification.md` §4 のとおり。`T0sd5l` の 2 セッションと実 API の 1 セッション（`9d1d67`）で -978〜-1321ms。全て軸の誤差 0（推定器のない版）で、WSL の時計の飛びがページの読み込みと Worker の生成の間に入ったときに出る。

### 1.3 -1〜-81ms: 軸の推定の偏りが時計差に固定される（確定、今回直した）

`ThreadAxisEstimator` のある版（54 件）で、負の値は 15 件、最小 -81ms。原因はログで確かめた。

- 読み込み直後は主スレッドが詰まり、最初の `axis_pong` の RTT が約 160〜240ms。往復の中点で軸を決めるので、主スレッドの時刻が遅れて押される片側の偏りで、軸の差が **RTT/2（約 +80〜+120ms）過大**になる。
- `clock.ping` の時刻をこの軸で主スレッドへ写していたので、`ClockEstimator` は「偏りを持つ軸で測った標本」を受ける。RTT が最小の標本を 60 秒の窓で採るので、偏った標本が残り続け、**軸の推定が後で良くなっても時計差が直らない**（例: 軸の誤差が 1.8ms まで下がっても時計差は -85ms ずれたまま）。報告の誤差は 2.2ms と小さく、誤差も正直でなかった。
- 根拠: 軸の推定が入った瞬間の時計差の変化が、軸の誤差と一致する（時計の飛びのない 18 回で、時計差の変化の絶対値と軸の誤差の差は中央値 0.5ms、最大 6.9ms。例: -90.5 と 90.2、-98.2 と 98.7）。飛びのあった回は、変化が飛びの分（約 +1.2 秒）だけ正にずれる。
- 推定: 偏りの分を戻すと 54 件全てが正になる（最小 +6.8ms）。吸気の中央値は 132ms で、推定器のない回の吸気の中央値（59ms）より大きいので、戻し方が過大な回がある可能性は残る（未確認）。

**修正**（`apps/web/src/audio/transport.worker.ts`、`clock_sync.ts`）:

- `clock.ping` の時刻を Worker の `performance.now()` のままにし、時計差（Worker → orchestrator）と軸（Worker → 主スレッド）を別々に推定する。`clock.report` のたびに `composeMainThreadClock` で合成するので、軸の推定が良くなれば過去の標本にも効く。
- 軸の推定が前より 1ms 以上動いたら、`clock.pong` を待たずに `clock.report` を送り直す。
- 起動時に軸の往復を 25ms 間隔で 20 回測り、偏りの残る時間を短くする。軸の推定が入るまで `clock.report` を出さない（timeOrigin の代用では 1 秒以上ずれうる）。`clock.report` の誤差は「時計差の誤差 + 軸の誤差」のまま。

### 1.4 rAF の時刻について

`docs/overnight_verification.md` §4 で「rAF のフレーム開始の分」とした負の値（-67ms まで）は、§1.3 の偏りで説明がつく。ブラウザ内で測った rAF の前倒しは -19〜-1ms で、これより大きい負の値は rAF では説明できない。rAF の時刻はフレームの開始で、実際に画面へ出る時刻はそれより後（少なくとも 1 フレーム）だが、その分は測っていない（`started_at` の誤差に入らない）。

負の値はクランプしない。`signal.started` の `time_basis.uncertainty_ms` は「時計差の誤差 + 軸の誤差」で、rAF の分を含まない。`tools/latency_initiative` は `-(誤差 + 20ms)` より前の値を時間軸の異常の疑いとして集計から外す（20ms は rAF の実測に合わせた暫定値）。

修正後の負の値は未確認。§1.3 の修正は単体試験（合成の式）までで、修正後の Worker を実ブラウザで動かしたログはまだない。次の E2E で `npm run latency:initiative` の時間軸の異常の数と、`clock.sync` の `offset_ms` が軸の推定の改善に追従するかを見る。

## 2. 遅延の連鎖の時刻

| 段 | 時刻 | 軸 | 誤差 |
|---|---|---|---|
| 発話の音声 | `audio_frame_end`（STT が返す 16 kHz のフレーム番号） | 音声のフレーム（時刻ではない） | `timing_precision` が区別する（`result_end_offset`、`posthoc_alignment`）。語の境界ではなく結果の末尾。 |
| 音声 → 時刻の写像 | `vap.state` の `audio_frame` と `t_monotonic_ms` の対 | orchestrator（`worker_audio_frame` で写した） | `time_basis.uncertainty_ms`（受信と Worker 時刻の差の幅）。**一方向の固定の遅れ（WS）とモデルの処理の遅れは含まない**ので推定値は実際より遅い側に数十 ms ずれる（未測定）。 |
| STT の受信 | `stt.*` の `t_monotonic_ms` | orchestrator | 0（受信時刻。STT の内部の遅れは測れない）。 |
| 発話希望 | `initiative.desire` の `sent_at`／`received_at`／`latency_ms` | orchestrator | 0（イベントループの遅れは含む、E2E の監視で最大 106ms）。 |
| タイミング | `initiative.timing` の `sent_at`／`received_at`（`immediate` は LLM なしで `t_monotonic_ms` のみ） | orchestrator | 0。 |
| 合図の送信 | `signal.sent.sent_at` | orchestrator（判定の tick の `now`） | 0。実際に WS へ書く時刻との差は tick 内で小さい（測っていない）。 |
| 合図の描画 | `signal.started.started_at`（rAF → `mapping.toServerMs`） | browser_rtt | `time_basis.uncertainty_ms`（§1.4）。rAF の時刻はフレームの開始。 |
| AI の発話 | `speech.started.started_at` | **browser_rtt で写した値だが、イベントの `time_basis` は `orchestrator`（誤差 0）のまま** | 実際の誤差は近い `clock.sync` の `error_ms` と同じ。`first_pcm_written_at` も同じ。 `output_latency_ms` を足して `started_at`（ブラウザの報告がなければ足さない）。修正していない（別の担当の作業と重なるので記録だけ）。 |

`wall_clock` は WSL の飛び（`docs/overnight_verification.md` §0）を含むので遅延の計算に使わない。

## 3. ツール

`npm run latency:initiative -- <sessions の親 | セッション | events.jsonl | glob>... [--json]`

候補ごとの区間と中央値を出す。本文は出力せず、根拠の照合にだけ使う。読めない段は null と理由を返す。`SUSTAINED_SILENCE_MS`（700ms、暫定）は話し止みの判定の値で、短い無音と話し止みの区別に使う（無音が 700ms 続くか、無音の間に `stt.final` が届いたら話し止み）。台本の STT（E2E）では受信の時刻が台本で決まるので、音声 → ASR の推定は負になりうる（実測の -40ms 程度）。実 STT の区間だけを読む。
