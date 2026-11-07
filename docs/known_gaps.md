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
- ja の `similarity.threshold` は null なので `prepareThresholds()` も null を返す。null の場合の扱いは §6。0.8 へ置き換えない。

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

## 6. 準備の閾値が null のときの扱い（E1 の判断）

実装は `apps/orchestrator/src/control/prepare.ts`。`policy.hri2025.json` の 0.2 と 0.8 は変えていない。

| null の項目 | 動作 |
|---|---|
| `similarity.threshold` | 類似度では準備を止めない。**正規化後の文字列が同じ（類似度 1）ときだけ止める** |
| `completion.thresholds[推定器].prepare_threshold`、または推定器なし | L46 の第1条件は常に偽。`ASR_PREPARE_TIMEOUT`（更新が 200ms 止まる）だけで起動する |

**`similarity.threshold` の理由:**

- 止める側に倒すと、未校正の間は応答がまったく準備されない。起動する側なら、失うのは費用だけで会話は動く。
- 0.8 は尺度が別物（all-MiniLM-L6-v2）で流用できない。別の数値を選ぶ根拠もない。
- 類似度 1 は文字 n-gram の尺度に依存せず「同じ入力」を意味する。interim の末尾の句読点だけの変動（§3）で作り直さないために、これだけは止める。

**代償:** 未校正の間は、文字が少しでも変わるたびに LLM と TTS が再起動しうる。

実 ASR のログを `step` に流して `prepare` を数えた（`ja_rules_v1`、準備は常に idle、利用者は発話中のまま、LLM と TTS は呼ばない）。素材は同じ文を間なく読み上げる音声で、人の会話の頻度ではない。

| `similarity.threshold` | 25 秒の素材 | 376 秒の素材 |
|---|---|---|
| null（今の動作） | 40 回 | **669 回（約 107 回／分）** |
| 0.99 | 20 回 | 20 回 |
| 0.9 | 7 回 | 7 回 |
| 0.8 | 5 回 | 5 回 |

- **null のまま長く話されると費用が大きい。** 校正まで実セッションの費用を見る必要がある。
- **数値の閾値にも逆の危険がある。** 長い素材で回数が頭打ちなのは、比較する文が累積で、同じ文の繰り返しだと類似度が 1 に近づくため。閾値があると、話が伸びても準備が古い入力のまま残りうる。校正では長い発話の末尾が応答へ届くかも確かめる。

判定の根拠は `TurnState.last_prepare_gate`（`basis` が `uncalibrated_text_differs` または `uncalibrated_same_text`）に残す。`prepare` の決定に閾値の状態を書く項目はない。

## 7. TurnManager（E1）の暫定と、原著にない判断

| 項目 | 現状 | 理由、残る問題 |
|---|---|---|
| p の向き | **暫定。** `p_ai = p[1]`。変換は `control/vap_direction.ts` の1か所 | R2 の実測は「添字 i はチャネル i の話者」まで。AI を ch2 に置く配線は契約上の前提で、B と J の実物は未確認 |
| 視線の設定 | `policy.ja.json` の `gaze` が null の間は逸らさない | 原著に数値がない。null を別の値へ置き換えない。**値が入るまで視線は動かない** |
| 視線の判定の向き | `p_ai < p_threshold` のポーズで逸らす | V-D。閾値ちょうどは逸らさない。同じポーズの中では向きを保つ（原著にない、行き来を防ぐため） |
| 発話開始前に視線を逸らす動作 | 入れない | 根拠が Fig. 1 の読み取りのみ。V-D に記述がなく、IV-B はベースラインの説明 |
| 鮮度切れの定義 | `audio_frame` の遅れ（計画）に加えて受信時刻の遅れも見る | 音声そのものが止まると frame の差が開かず、古い p を fresh と扱うため |
| hri2025 の鮮度と助走 | ja と同じ 500ms と 10 秒をコードで持つ | 方策に項目がなく、原著にもない。原著再現の根拠にしない |
| 復帰時の計時 | fresh に戻ったら L57 と L71 の時計を現在時刻にする | VAP がなかった間の値で L74 が即時に真になるのを防ぐ。原著にない |
| degraded 中の開始と割り込み | `fallback_silence_max_ms`、`fallback_interrupt_min_words` が null の間は、招待以外で開始せず、割り込みもしない | **未校正のまま VAP が止まると AI は止められない。** `fallback_energy` の単位と無音の閾値も契約にない（`createTurnManager` の引数で渡す。未指定なら使わない） |
| `start_speech` 後の待ち | 再生の報告を 1000ms 待つ【暫定】（`START_ACK_TIMEOUT_MS`） | 方策に項目がない。報告が遅いと重ならないが、それ以上遅れると U-1 の防止が切れる |
| 準備の喪失 | ja のみ、準備が再生に入らず消えたら同じ文で1回だけ再試行 | L45 が偽のままになり、応答が永久に準備されないため。`hri2025_mapping.md` にない追加 |
| AI の発話が自然に終わった後の相槌 | 発話中の「うん」も次の入力として準備し、許可が出れば応答する | U-2 は割り込み後の再開だけを決めている。相槌に応答しうる。G1 の観察で見直す |
| 招待の語句 | 文末固定の自作の表（`control/invitation.ts`）。hri2025 では記録のみ | 誤検出率は未測定。句読点を根拠にしないので、上昇調でしか分からない質問は取らない。再開の待ちは Jarvis の 400ms でなく `MIN_GAP_TIME` |
| `YIELD_TIMEOUTS` の尺度 | ja でも TurnGPT の表をそのまま使う | 推定器ごとの表は `prepare_threshold` しかない。`ja_rules_v1` の p は別の尺度で、L74 の意味は原著と同じでない |
| `final_transcript` の起動 | 使わない | Appendix A にない。final でも L46 の条件を待つ（最大 200ms 遅れる） |
| WoZ の入力 | `inputs.woz` を読まない | E3 の範囲。**J が渡しても効かない** |

## 8. 統括が入れた暫定の値（波1の配線のため。根拠なし、未校正）

`config/policy.ja.json`:

- `gaze`: `signal=p_now`、`p_threshold=0.5`、`pause_min_ms=200`。null のままだと視線が動かないため。人の評価も実対話での確認もしていない。
- `similarity.threshold=0.9`。null だと実 ASR ログの再生で 376 秒に 669 回の準備になった（同じ文の連続読み上げで、人の会話の頻度ではない）。0.9 では 7 回。比較する文が累積なので、長い発話の末尾が応答に届かない危険がある。校正のときに確かめる。

