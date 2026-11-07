# 既知の差と未解決の点

設計上の判断で残した差と、実測で分かった制約を置く。直したら項目ごと消す。

## 1. 準備の閾値の二重管理と正本

`policy.ja.json` には同じ意味の閾値が2か所にある。

| `turn.constants`（Appendix A の形） | 持ち主の節 | ja の値 |
|---|---|---|
| `TURNGPT_PREPARE_THRESHOLD` = 0.2 | `completion.thresholds[推定器].prepare_threshold` | `ja_rules_v1` は 0.3、`llm_completion_v1` は null |
| `SIMILARITY_PREPARE_THRESHOLD` = 0.8 | `similarity.threshold` | null（未校正） |

**判断: ja の正本は `completion` と `similarity` の節。** 読み口は `prepareThresholds(policy)`（`packages/contracts/src/policy.ts`）の1つにする。TurnManager は `turnConstants()` の同名の項目を読まない。

**理由:**

- 尺度が原著と違う。TurnGPT の確率と `ja_rules_v1` の p は別物で、推定器ごとに閾値が要る（計画 §4.4）。類似度も all-MiniLM-L6-v2 でなく文字 n-gram のコサインなので、0.8 をそのまま適用しない（計画 §4.1）。
- `turn.constants` は推定器を区別できず、未校正を null で表せない（型が `Probability`）。
- 節の持ち主は D で、校正の結果を書く場所もそこ（`policy.ts` の節の持ち主の注記）。

**HRI 2025 の再現:** `policy.hri2025.json` は変えていない。この方策には `completion` と `similarity` の節がなく、`prepareThresholds()` は `constants` の 0.2 と 0.8 を返す。値はスキーマのリテラルで固定している。

**残した差:**

- 後方互換のため、`policy.ja.json` の `turn.constants` の2項目は消していない（スキーマで必須）。値は読まれない。次に契約を壊してよい時期に ja から外す。
- ja の `similarity.threshold` は null なので `prepareThresholds()` も null を返す。**null の場合の準備の起動をどうするかは E1 が決めて記録する。** 0.8 へ黙って置き換えない。

## 2. `high_water` の安定テキストの解釈

実測の `long` では `stability` 0.9 の範囲が revision ごとに伸び縮みする（文字数 0→10→9→0→24→0→28→35→34→28→42→28）。文字は変わっていない。最新の revision の 0.9 の部分だけを見ると、ついさっき安定だった根拠が消えてしまう。

そこで `StableTranscriptView` の既定の `high_water` は次の解釈にしている（`apps/orchestrator/src/cognition/initiative/transcript_view.ts`）。

- 一度 0.9 になった範囲は、最新の全文がその接頭部を保つ間は安定のまま扱う。
- 全文が書き換わったら共通接頭部まで縮める。
- 0.01 の部分は安定に入らない。

これは**資料の定義ではなくこの実装の解釈**で、Google の `stability` の意味を保証しない。`literal` モードで最新の revision だけの比較もできる。

## 3. interim の末尾の「。」は文末ではない

`long` の interim は末尾の句読点が変動する（「国。」「国が？」）。`stability` 0.9 の瞬間の結果には必ず付く。interim の末尾の句読点を文末の根拠にしない。InitiativeMonitor は起動の判定と LLM への入力から除いている。ターン完了の推定器など、他の読み手も同じ注意が要る。

## 4. Google が間のない音声に自分で打つ final の直後の文字欠落

切れ目のない音声を流すと、Google は自分の判断で final を打つ。その直後の文字が次の結果に現れないことがある。**同じ文を繰り返す 6 分の音声で、3か所、計6文字。**

| final の位置（`audio_frame`） | final の末尾 | 次の final の先頭 | 欠けた文字 |
|---|---|---|---|
| 2400160（150 秒） | 問うのではなく。 | 国のために | あなたが（4文字） |
| 3839360（240 秒） | 問うのではなく、あなた。 | 国のために | が（1文字） |
| 5278560（330 秒） | 問うのではなく、あなた。 | 国のために | が（1文字） |

- 出所: `tools/provider_probe/out/stt-c-handover-2026-11-07T19-14-11-584Z.jsonl`。原稿との比較で、3か所とも同じストリーム（`gstt_2`）の中で起き、ストリーム切替の継ぎ目ではない。
- 間のない読み上げの音声での結果で、人の会話で同じ頻度かは未確認。
- 当方で直す手段がない。発話の根拠の検証（`evidence_span`）は認識文に対して行うので、欠けた語は根拠にならないだけで誤動作はしない。

## 5. 契約にあるが、まだ発行していない項目

後方互換の追加なので、発行側は未変更でも動く。下の項目はログに現れない。

| 項目 | 発行するはずの場所 | 状態 |
|---|---|---|
| `clock.report` | `apps/web/src/audio/transport.worker.ts`（A） | 未送信。受ける側の配線も J 待ち。`draftFromClockReport` は用意済み。これが入るまで `browser_rtt` の `clock.sync` は作れない |
| `audio.report` の `reconnects`、`orphan_pcm_frames`、`pcm_seq_gaps`、`render_lag_ms` | 同上 | Worker は値を持つが送っていない |
| `TrackSettings.latency` | `apps/web/src/audio/`（A） | 未送信 |
| `prefetch.started.trigger`、`prefetch.cancelled.discarded_chunks`／`discarded_samples` | `apps/orchestrator/src/cognition/prefetch/index.ts`（D） | 未発行。`discarded_*` は `SpeechStateChange` から個数を渡す変更も要る |
| `capabilities.ts` の型 | C | 契約と同じ形の型が残っている（`implements TtsConnection` の型検査で一致を確認）。契約の型へ置き換えられる |
