# 実装計画とタスク割り振り（仕様 v2 対応）

- 正本の仕様: `Claude_Code_HRI2025_MaAI_Initiative_Breath_Spec_v2.md`（以下「仕様」）＋`Claude_Code_v2_追補_発話希望判断.md`（以下「追補」）。旧仕様は参考扱い。
- 作成日: 2026-11-08。**この文書は計画であり、実装はまだ行っていない。**
- 状態の表記: 【実測】この環境で動かして確認／【原文】一次資料を読んで確認／【未確認】まだ確認していない／【暫定】実測で見直す初期値。
- 版: 第8版（第6版に Google STT と Gemini の実測を反映。第8版で Gemini TTS の代替をレーン C に追加。第5版以降の再点検は未実施）。詳細は `docs/provider_matrix.md` と `tools/provider_probe/out/`。
- 進め方: 利用者の指示（2026-11-08）により、確認が不要な作業は並列で先行し、§9 の項目だけ確認を待つ。

---

## 1. 計画の前提になった調査結果

### 1.1 判明したこと

| 項目 | 結果 | 状態 | 計画への影響 |
|---|---|---|---|
| MaAI 0.2.25 の実ロードと推論 | `MaaiInput.Chunk` で動作。MaAI 自己申告の RTF は `normal-ver2` 2ch 0.39／同 1ch 0.20／`normal` 2ch 0.17 | 【実測】公式 `test.wav`（モノラル、約12秒）の1回のみ。2ch 試験も第2チャネルは無音。`lang=jp` のみで `jp_kyoto` は未測定 | 2ch 本番構成の実証は R2 に残す |
| `pip install maai` | PyAudio（要 portaudio）と GUI 依存で素直に入らない。`--no-deps`＋必要分＋`pyaudio` スタブで動作 | 【実測】 | `Mic()` は使わない（仕様§6-2）。仕様§6-1 の `Mic()` 形式の smoke は未実施と記録 |
| MaAI の内部キュー | `start()` の worker は `qsize()>100` で**チャネルごとに別々に**キューを消す。結果の `t` は壁時計でフレーム番号なし。Mimi ONNX は最初の出力を捨てる。`process(x1, x2)` は直接呼べる | 【原文】ソース確認 | §3.3 のとおり公式スレッドを使わず番号を自前管理 |
| モデル種別の差 | 無音の第2チャネルの `vad` が `normal` で約 0.46、`normal-ver2` で約 0.02 | 【実測】数フレームの観察のみ | `normal-ver2`（12.5Hz）を第1候補に比較 |
| 重みのライセンス | `vap_jp`・`vap_mc_jp`・`vad_jp` は **CC-BY-NC-ND 4.0**、`vap_jp_kyoto`・`vap_mc_jp_kyoto` は **MIT**、Mimi ONNX は CC-BY-4.0。CPC は「原プロジェクトのライセンスに従う」 | 【原文】HF タグと README。CPC の内容は【未確認】 | 非営利と回答済み（§9）。既定は R2 の比較で決める。`*_kyoto` は 1ch なし。CPC は `normal` の比較に使う前に確認 |
| TurnGPT | 最終コミット 2022-10。リポジトリ内に重みなし。GPT-2／DialoGPT の英語ベース | 【原文】外部配布の有無は【未確認】 | 英語モデルの転用は成立しない見込み。代替を前提に計画（§4.4） |
| VAP-Realtime | README に「MaAI へ統合済み、いずれアーカイブ」 | 【原文】 | 採用しない |
| HRI 2025 Appendix A | 定数と擬似コード全行を確認（全文は R1 で `docs/hri2025_mapping.md` に転記） | 【原文】 | §4.1 |
| p 値の向き | 擬似コードは `p_now < 0.4` で割り込み、`> 0.5` で譲渡なので **p = ロボット側の確率**。V-A 本文は「両方がユーザー側を支持したら交替」 | 【原文】**論文内で不一致** | 擬似コードを正とし、MaAI 実出力で実測して確定（R2） |
| 擬似コードの細部 | `user_turn_end_time` は非発話中で条件が偽のときしか更新されず、話し終えた直後に p>0.5 なら 0ms で許可が出うる。割り込みの停止点は本文「次の語境界」、擬似コードは `stop_speaking()` のみで未規定 | 【原文】 | §4.1 で解釈を決める |
| 日本語 STT（開発用） | ReazonSpeech は `ja.wav` を正確に認識、8秒の再デコード 0.15秒。多言語ストリーミング版は誤認識が多い | 【実測】1ファイルのみ | キー不要の**開発用**として採用（受け入れには数えない） |
| Google STT v2 | `isFinal`・`stability`（既定0.0＝未設定）。Chirp 3 は ja-JP とストリーミング対応。**モデルごとの `stability`／`interim` 可否とストリーム時間上限は不明** | 【原文】一部【未確認】 | R4 で実呼び出し確認。切替と `stability` 不在時の代替を最初から設計 |
| Google STT v2 のモデル選定 | 8秒の `ja.wav` で比較（各1回）。**`chirp_3`（us）と `chirp_2`（asia-southeast1）は8秒間で interim が1回のみ、`stability` なし。`long`（asia-northeast1 = 東京）は interim 46 件、音声に対する遅れ p50 280ms／p95 340ms、`stability` は 0.01／0.9 の2値、interim に `resultEndOffset` あり、語時刻は final のみ**。`chirp_3` は東京では一覧にあるが「GA 終了」で拒否される | 【実測】短い1サンプルのみ | **既定を `long`＋`asia-northeast1` に変更。** 語時刻を得るため final で `enable_word_time_offsets` を有効に |
| interim の中身 | `stability` 0.9 の部分と 0.01 の部分に分かれて届く。末尾の句読点が変動する（「国。」「国が？」）。文字の書き直しは今回なし | 【実測】同上 | **安定テキスト＝`stability` 0.9 の部分**として InitiativeMonitor に渡す。比較と `evidence_span` の照合では句読点と空白を除く |
| Google STT v2 の呼び出し | `client.streamingRecognize()` は v2 に使えず `_streamingRecognize()` を使う（実測で動作）。20ms 送信は脚注の上限 3,000 要求/分に達する | 【原文＋実測】 | Node→Google は 40ms に束ねる |
| Gemini の遅延 | `gemini-3.5-flash-lite` は判定まで p50 620〜890ms、最大 1.4秒（各 n=10）。`gemini-3.8-flash` は p50 2.2〜3.2秒。`generateContent` が Interactions よりやや速い。テスト文1種では flash-lite が 40/40 件 `NONE`、3.8-flash は `generateContent` で 5/6 件 `NEW` | 【実測】プローブの仮のプロンプト。判定の質は未評価 | **速度は flash-lite が適合。ただし判定の質はモデルで大きく違う可能性があり、S の反例で比較する** |
| ElevenLabs | `eleven_flash_v2_5`、`multi-stream-input`（1接続5文脈、無通信の上限は最大180秒）。`alignment` は語単位でなく**文字単位の配列でチャンク相対の時刻**（スキーマ上）。`auto_mode` か `flush` がないと音声が始まらない | 【原文】PCM の可否、日本語の単位、遅延は要測定 | §4.3 |
| Gemini の API と規約 | `generateContent` は legacy 扱いで推奨は Interactions API（既定で要求を保存するので `store: false` 必須）。中断しても課金は止まらない | 【原文】 | §9 の有料キーの項を参照 |
| SDK の Node 要件 | `@google-cloud/speech` 8.2.1、`@google/genai` 3.0.0 は Node 22 以上 | 【実測】npm view | **Node 24 に統一**（nvm に v24.21.0 あり） |
| 費用の見積もり | 5分の対話1回あたり約 $0.33（flash-lite 構成） | 【推定】LLM 180 回などの仮定に基づく。`chirp_3` の単価も仮定 | 実測で置き換える |
| Gemini | `gemini-3.5-flash-lite` は Stable。`gemini-3.8-flash` も掲載 | 【原文】実呼び出しは未検証（キーなし） | 既定は flash-lite、実測で選定 |
| VRM モデル | `Sendagaya_Shino`・`HairSample_Female` の埋め込みメタが CC0。`upperChest`・肩・首と a/i/u/e/o/blink あり | 【実測】メタのみ。VRoid 公式ページは取得できず（403） | 第1候補は `Sendagaya_Shino`。公式確認は NOTICES の残件 |
| 実ブラウザ試験 | Playwright Chromium で WebGL2（ソフトウェア描画）動作 | 【実測】フェイクマイクの実音声投入は【未確認】 | E2E は可能な見込み |

### 1.2 環境

Ryzen 7 7735U（16論理コア）、WSL2、メモリ 9GB、NVIDIA GPU なし、sudo はパスワード必須、Node 20、Python 3.12。マイクは Windows 側 Chrome から取得し、WSL の backend へ `localhost` で接続する想定。

### 1.3 旧仕様の作業の残存物

| 残存物 | 扱い |
|---|---|
| `.venv/`（2GB、Kokoro 等を含む） | F と R2 の完了後に統括が削除し、`workers/maai/` 用に lock から作り直す（承認済み） |
| `models/`（1.1GB） | ReazonSpeech と Silero を流用。多言語版は R2 の完了後に統括が削除（承認済み） |
| 旧デモ一式 | F の完了後、最初の commit の前に統括が `legacy/` へ移動（承認済み） |
| `~/.cache/huggingface/` の `Kokoro-82M` | 削除済み |
| AivisSpeech のダウンロード（1.6GB。起動は権限判定で拒否され**未実行**） | 削除済み |

---

## 2. 再利用と再実装の仕分け（仕様§11）

| 対象 | 判定 | 理由 |
|---|---|---|
| MaAI | **利用**（`process()` を直接呼ぶ） | §3.3 |
| HRI 2025 の制御フロー | **再実装**（公式コード一式は確認できず） | Appendix A を純粋な TS 関数へ写す |
| TurnGPT | **検証のみ**、不適なら代替 | §4.4 |
| three-vrm | **利用** | 胸郭は追加リグが必要（§4.7） |
| 旧デモ | **使わない**（`legacy/` へ） | 仕様の冒頭どおり |
| ErikEkstedt/VAP | **参照のみ** | projection window の理解 |
| VAP-Realtime | **不採用** | MaAI に統合済み |
| `InitiativeMonitor`／吸気信号 | **新規**（論文にない） | 仕様§2 |

---

## 3. 構成

### 3.1 ディレクトリと持ち主

仕様§3 の推奨スタックに従う。**全ファイルに持ち主を1レーン割り当てる。** レーンの内容は §5.1。

| パス | 内容 | 持ち主 |
|---|---|---|
| ルートの設定、各 `package.json`、`.env.example`、Python の lock、`pyaudio` スタブ | monorepo の土台 | F |
| `packages/contracts/` | zod スキーマ、生成 JSON Schema、バイナリ枠 | F（変更は統括経由） |
| `config/policy.hri2025.json` | 原著値（変更しない） | F |
| `config/policy.ja.json` | 日本語調整値。雛形とスキーマは F、節ごとの持ち主は `turn`・`gaze` が E、`similarity`・`completion` が D、`initiative` が G | 節ごと |
| `legacy/` | 旧デモ一式 | F |
| `workers/maai/`（`probes/` 除く） | MaAI ワーカー、WAV リプレイ | B |
| `workers/maai/probes/`、`docs/maai_output_schema.json` | 出力と向きの実測 | R2 |
| `tools/turngpt_probe/`、`docs/turngpt_validation.md` | TurnGPT 検証 | R3 |
| `tools/provider_probe/`、`docs/provider_matrix.md` | API 検証 | R4 |
| `docs/hri2025_mapping.md`、`docs/related_work_notes.md` | 論文との対応、関連研究の注意（RESPOND、Jarvis） | R1 |
| `apps/web/src/audio/`、`apps/web/public/worklets/`、ブラウザの WS クライアント、`apps/web/app/dev/audio/`（試験ページ） | 全二重音声 | A |
| `apps/orchestrator/src/providers/{stt,tts}/` | STT、TTS | C |
| `apps/orchestrator/src/providers/llm/`、`src/cognition/{prefetch,completion,similarity}/`、`src/speech/`（SpeechGenerator） | 応答生成、推定器、音声先行生成 | D |
| `apps/orchestrator/src/control/` | TurnManager（準備の判断を含む）、視線判断、Negotiator、招待検出、候補の状態（正本）と ID・版の採番 | E |
| `apps/orchestrator/src/cognition/initiative/`（判定関数とプロンプト）、`config/persona.ja.json`（AI の役割・関心・会話目的） | InitiativeMonitor。**S が先に作り、波2で G へ移管**（移管後の持ち主は G） | S → G |
| `tools/initiative_spike/`（実行器と収録スクリプトのみ）、`fixtures/initiative/`（§3.5 の `stt.*` 形式の素材） | 先行スパイク、反例の素材 | S |
| `apps/web/src/avatar/`、`apps/web/app/lab/`、`apps/web/public/models/` | アバター | H |
| `apps/orchestrator/src/logging/`、`apps/orchestrator/src/recording/`、`apps/web/app/researcher/`、`tools/anonymize/` | ログ、録音、研究者画面、リプレイ UI、匿名化 | I |
| `apps/orchestrator/src/{server.ts,session/,maai_client/}`、`apps/web/app/(participant)/`、`e2e/` | WS サーバー、配線、**会話履歴の保存**、参加者画面、E2E | J |
| `README.md`、`DEPENDENCIES_LOCK.md`、`THIRD_PARTY_NOTICES.md`、`docs/architecture.md`、`docs/acceptance_results.md`、`docs/known_gaps.md` | 提出文書 | K（統括）。各レーンは完了報告で材料を渡す |

### 3.2 全二重音声

- **`AudioContext` は 48kHz を要求**し、実際のレートをログへ。再生帯域を落とさないため 16kHz 動作にはしない。
- **1つの AudioWorklet** でマイク入力と再生出力を同じレンダー量子で処理し、**同一の polyphase FIR で両チャネルを 16kHz へ変換**する（群遅延を揃える）。TTS の PCM も再生前にこのレートへ揃える。
- **フレーム番号 `audio_frame`** は 16kHz サンプルの連番に統一。送信単位は 20ms（320サンプル）を初期値とし、**MaAI の frame 周期の約数に限る**（10Hz、12.5Hz のどちらでも割り切れる）。
- **system チャネルは「出力へ書き込み済みのサンプル」**。物理的に聞こえた時刻とは `outputLatency` 分ずれる。`baseLatency`、`outputLatency`、`getOutputTimestamp()` を定期記録し、**履歴の「発話済み」の計算では差し引く**。ログには `system_ch_source: "written"` を残す（仕様§3）。ループバックで往復差を測り、許容遅延を G1 で決める。Bluetooth は推奨しない。
- **`getUserMedia` は `echoCancellation/noiseSuppression/autoGainControl` をすべて `false` で明示**し、`track.getSettings()` をセッションログへ。ヘッドホン＋近接マイクを必須とする（論文と同じ）。スピーカー＋AEC は Phase 1 の範囲外。
- **WS は専用 Worker で処理する。** Worklet の MessagePort を Worker へ渡し、主スレッドを経由しない。受信 PCM はジッタバッファを持ち、アンダーランは回数と長さを記録する。
- 再生は `audio_playback_id` と世代番号で管理し、未再生分を即時破棄でき、位置をサンプル単位で返す。
- **開始操作:** 自動再生の制限があるので「はじめる」1回のみ許容（以後の操作は不要）。`AudioContext` の `statechange` と `visibilitychange` を記録し、研究者画面に警告を出す。

### 3.3 MaAI ワーカーと Audio RPC

- 経路: Browser → Node → 【mic のみ】STT／【両方】Python。Node↔Python は localhost の WS。
- **`start()` のスレッドを使わず、ワーカーの1スレッドが `process(x1, x2)` を直接呼ぶ。** `audio_frame` と結果を自前で対応づける。
- **ネットワーク欠損**は該当番号をゼロ埋めする。**過負荷**では2チャネル同時に捨てて `process` を呼ばず、欠損として記録する（滞留を解消するため）。チャネルずれを検出する試験を入れる。
- `VAP_STATE{t, audio_frame, p_now, p_future, user_speaking, system_speaking, model_variant, channel_layout, raw}` へ正規化。1ch と 2ch は別型にし、同じしきい値を流用できないようにする。
- 契約: バイナリ枠は `{version, audio_frame, sample_count, format=Int16LE, mic[], sys[]}`。MaAI へ渡す直前に Float32 へ変換。Google へは LINEAR16 をそのまま渡す。メッセージは zod から JSON Schema を生成し、Python でも検証する。
- MaAI 停止時は `VAP_STATE` が鮮度切れとなり、§4.1 の表に従う。**RMS 等で VAP を偽装しない。**

### 3.4 時刻と相関 ID

`t_monotonic_ms` と WallClock を orchestrator が発行し、ブラウザのイベントは往復計測で補正する（ブラウザ側は A、サーバー側は J）。STT、VAP、再生の時間軸は `audio_frame` で結ぶ。

プロセスごとのローカル単調時計は**直接比較しない**（追補2）。ブラウザは往復補正、Python ワーカーは `audio_frame` と受信時刻で orchestrator の基準へ写し、補正の推定誤差もログへ残す。

全レーンは F の `emit()` と時刻源のインターフェースを通してイベントを出す。`emit` の本体は Node にあり、**Browser と Python は契約のメッセージで Node へ転送**する（受ける配線は J）。書き出しの実装は I1 が持つので、波1aでは F の仮実装を使う。

**Browser↔Node の制御メッセージ（F の契約）:** 下りは gaze、signal、alignment（語時刻）。上りは描画時刻（rAF）、health、時計差の推定（`clock.report`。`browser_rtt` の `clock.sync` の元）。

**2種類の区間 ID:** `segment_id` は AI の発話開始で増えるターン単位の世代で、§4.1 の `ASR.reset` に使う。`asr_segment_id` は final 単位または `audio_frame` 範囲の ASR 区間で、`evidence_segment_ids` と撤回の後続区間 ID はこちらを指す（人が長く話しても根拠と解消を区別できる）。

### 3.5 イベントと必須項目（F の契約。欠落はスキーマ試験で検出）

**全イベント共通:** `t_monotonic_ms`, `wall_clock`, `session_id`, `condition`, `event`。

**値がない場面の規則:** 種別ごとの判別共用体にする（`NONE` に `candidate_id` は不要、など）。値が本来ありうるのに得られないとき（推定器なしの `completion_p`、初回の `similarity`）は、`null` と理由を記録する。偽の値は入れない。

| イベント | 追加の必須項目 | 発行 |
|---|---|---|
| `stt.interim/final` | `text`, `segment_id`, `asr_segment_id`, `transcript_revision`, `stability`, `audio_frame_end`, `provider`, `model_version` | C |
| `stt.handover` | `provider`, `model_version`, `from_stream`, `to_stream`, `cause`, `h_frame`, `a_age_ms`, `overlap_ms`, `drain_ms`, `a_final_synthesized`, `first_b_emit_ms`, `stripped_chars`, `strip_method`, `b_first_lag_ms` | C |
| `llm.request/response` | 用途（`prefetch/initiative/completion`）、入力、出力、`transcript_revision`, `sent_at`, `received_at`, `model_version`（リプレイの注入元） | D、G |
| `vap.state` | §3.3 の項目 | B |
| `prefetch.started/cancelled/ready` | `segment_id`, `transcript_revision`, `audio_playback_id`, `similarity`, `similarity_method`, `model_version` | D |
| `initiative.decision`（`NONE/NEW/KEEP/REVISE/WITHDRAW`）。`NEW` は `decided_at`、他は `updated_at`／`withdrawn_at`。ID と版は E が採番 | `candidate_id`, `candidate_version`, `segment_id`, `transcript_revision`, `intent_type`, `evidence_span`, `evidence_valid`, `evidence_segment_ids`, `reason`, `why_now`, `cost_of_waiting`, `proposed_utterance`, `expiry_policy`, `urgency`, `sent_at`, `received_at`, `model_version`。`WITHDRAW` は `withdraw_reason` と判断に使った後続区間の ID も必須。**モデル出力（`reason`, `why_now`, `cost_of_waiting`, `withdraw_reason`）と実測・検証結果を項目の型で区別する** | G |
| `initiative.discarded`、`initiative.aborted` | 理由、revision 差 | G |
| `candidate.state_changed` | `candidate_id`, `from`, `to`, `cause`（コード由来: 期限切れ、活動中の候補あり、通常応答の開始など。モデル由来の `WITHDRAW` と区別） | E |
| `clock.sync` | `offset`, `error`, `source` | A、J |
| `signal.sent/started/ended` | `candidate_id`, `phase`, パラメータ値。**`started_at` は最初に描画した rAF の時刻**。背景タブなら `visible=false` | E、H |
| `turn.allowed` | `turn_allowed`, `decision_source`（vap／fallback／invitation／completion_timeout）, `invitation`, `user_speaking`, `p_now`, `p_future`, `fallback_energy`, `completion_p`, `gap_ms`, `priority`, 使った方策 | E |
| `speech.started/ended/interrupted` | `speech.started_at`, `audio_playback_id`, `candidate_id`, `candidate_version`, `audio_frame`, 発話済みテキスト, 精度 | E、D、A |
| `gaze.decision` | `reason`, `p_now`, `p_future`, 発話内ポーズの状態 | E |
| `audio.health` | 欠損、アンダーラン、レイテンシ、`getSettings`, `system_ch_source` | A、B |
| `provider.status` | `provider`, `ok/degraded/down`, 理由, 再試行 | 各プロバイダ |
| `cost.usage` | プロバイダ、数量、推定費用 | C、D、G |
| `woz.override` | 操作内容、操作者 | J |

### 3.6 遅延の区間の定義（仕様§5）

| 時刻 | 計算元 |
|---|---|
| `t_content_evidence` | `evidence_span` の末尾が音声に現れた時刻。`chirp_3` はストリーミングで語時刻を出せないので、**正式な値は保存音声の事後整列**で求める。オンラインの値は「その span を初めて含む revision の `resultEndOffset`」の近似として、区分つきで別に記録する |
| `t_transcript` | 同じ span を初めて含む interim の受信時刻 |
| `t_initiative_decision` | `decided_at` |
| `t_breath_start` | `signal.started_at`（rAF） |
| `t_speech_start` | 最初の PCM を書き込んだ時刻＋`outputLatency` |

平均でなく分位点と、取消率・空振り率を報告する。追補の `decision_at`／`cue_at`／`speech_at` は、それぞれ `decided_at`、`signal.started_at`、`speech.started_at` の別名として分析ビューで出す（時刻を二重に持たない）。

---

## 4. 主要モジュールの設計

### 4.1 TurnManager（Appendix A）

原著値は `config/policy.hri2025.json`（**英語 Furhat の値であり、日本語で最適とは主張しない**）:

```text
TURNGPT_PREPARE_THRESHOLD 0.2 / ASR_PREPARE_TIMEOUT 200ms / SIMILARITY_PREPARE_THRESHOLD 0.8
VAP_PNOW_INTERRUPT 0.4 / VAP_PFUT_INTERRUPT 0.4 / VAP_PNOW_YIELD 0.5 / VAP_PFUT_YIELD 0.5
MIN_GAP_TIME 500ms / YIELD_TIMEOUTS {0.3:500, 0.2:1000, 0.1:2000, 0.0:3000}
```

- **契約:** `step(state, inputs, now) -> {state, decisions[]}` の純粋関数。session が固定周期（20〜50ms【暫定】）で tick するので、VAP が止まっても時間は進む。
- **向き:** `p_now_ai = p_now[1]`、`p_future_ai = p_future[1]`（ch1=user、ch2=AI）を仮置きし、**R2 の実測後に確定**。
- **`user_speaking`** は VAP の `vad[0]` としきい値（`policy.ja.json`）。
- **準備の判断（A44〜54 相当）は E1 の `decisions[]` に含める。** D は `prepare/cancel` を実行するだけ。Appendix A の分岐試験の範囲に入る。`step` の入出力型は F の契約で波1aの前に固定する。
- **解釈の決定:**
  - `user_turn_end_time` は**発話中の分岐でも更新**する（話し終えた直後の 0ms 許可を防ぐ）。原文どおりの挙動は設定で切替可能にし、差分を `hri2025_mapping` に記録して試験に入れる。
  - **`ASR.reset()`** は「AI が話し始めたら `segment_id` を増やす」と定義する。Google のストリームは切らない。所属は到着順でなく**音声位置で決める**: `audio_frame_end` が境界より前なら旧 segment へ入れ（語尾を失わない）。語時刻がないので、境界時点の revision のスナップショットとの差分で分け、接頭部の差し引きは未確定部分にだけ適用する（final 済みの部分は次の interim に含まれない）。実挙動を `provider_probe` で確定する。担当は E（決定）、C（反映と試験）、J（配線）。
  - **停止点**は語境界を既定とし、上限時間（200ms【暫定】、原著にない値）を超えたらフェードで止める。語境界の判定は D、停止の実行は A。即時停止は設定で切替。
  - **擬似コードを写すと不具合になる点の補正（`hri2025_mapping.md` の U 項目）:** 話し始めの条件に AI 非発話を加える（U-1）。AI 発話中の準備は抑止し、`cancel` は未再生の準備だけを対象にして、割り込み確定後に準備を再開する（U-2）。`segment_id` が変わったら `asr_result`、`last_sent_asr_result`、`turngpt_output` を初期化する（U-4、「はい」→「はい」で準備が起動しない問題の防止）。`Similarity(x, none)` は 0 とし、初回は必ず起動する（U-5）。準備の条件の比較は擬似コードの `>` に合わせる。いずれも `original` との差分として記録する。
- **類似度:** 既定は文字 n-gram のコサイン（D が実装、Node 内で完結）。all-MiniLM-L6-v2 は英語中心なので、原著値の 0.8 をそのまま適用しない。手法と閾値を原著と別に管理し、ログへ残す。
- **VAP の鮮度切れ:** 最新の `VAP_STATE` の `audio_frame` が、受信済み音声の先頭より一定時間（500ms【暫定】）遅れた状態と定義する。代わりの入力として、J の session が音声枠から計算する `fallback_energy`（`step` の入力型は F）を `degraded` 時専用に使う。**VAP とは別名で記録し、VAP として扱わない。**

| 状況 | 動作 |
|---|---|
| AI 待機中 | 発話開始は `fallback_energy` の無音時間の上限と明示の招待のみに限定し、`degraded` を表示 |
| AI 発話中 | 割り込みは `fallback_energy`＋`stt.interim` の新しい内容（語数の下限あり、相槌で止めない）で判定し、VAP 由来の判断とは区別してログへ |
| 視線 | VAP に基づく制御を止め、既定の注視に戻す |
| 復帰時 | ワーカー再起動後は文脈が空なので、助走（10秒【暫定】、原著の文脈は30秒、MaAI の既定は20秒。足りるかを R2 で実測）が過ぎるまで VAP の値を制御に使わない |

### 4.2 Self-monitoring（視線）

- `gaze_decision` を TurnManager の出力に含める。AI 発話中のポーズ（system チャネルの無音）で、**VAP が「誤って譲渡と受け取られうる」と予測したときに視線を逸らして発話権を保持**し、譲渡されないと予測したポーズでは逸らさない（原著 V-D を原文で確認）。
- 原著に数値の閾値はなく、p_now と p_future のどちらで判定するかも書かれていないので、`policy.ja.json` の設定にする。発話開始前に視線を逸らす動作（Fig. 1 の読み取りのみが根拠）を入れるかは E1 で決めて記録する。原著の視線は**自分のターンの保持**が目的で、発話希望の吸気とは別の機能として実装する。
- 波1で最小の視線を動かす。

### 4.3 SpeechGenerator（先行生成の持ち主）

`prepare / cancel / is_ready / start / stop` を D が担当する。ResponsePrefetch と発話候補の両方がこれを使う。

- **`is_ready` の定義:** 最初の PCM が一定量（【暫定】200ms）バッファされた状態。
- **世代管理:** LLM → ElevenLabs → Node → Worklet の全段で `audio_playback_id`＋世代番号を持ち、古いチャンクは各段で棄てる。
- **候補との対応:** 候補は `candidate_version` を持ち、**再生開始時に版と PCM の一致を検証**する。`REVISE`・`WITHDRAW` のどちらでも旧 PCM を破棄する（仕様§5 の「一対一」）。
- **接続:** `multi-stream-input` で**セッションに1接続**、候補や応答ごとに文脈を分けて取消する（`close_context` 後も音声が届くかは要測定なので、世代番号の棄却は残す）。保持中の PCM は Node 側に置く。
- **語境界:** 文字単位の `alignment` を累積し、`Intl.Segmenter` で語境界を作る。発話済みテキストは再生位置とこの時刻から求め、精度を明記。

### 4.4 TurnCompletionEstimator

独立インターフェース `estimate(history, partial) -> p`。順に試す。

1. **TurnGPT の検証（R3）:** 重みの入手可否、ライセンス、日本語サンプル。入手不可または不合理なら「不適」と記録して終了。
2. **代替 A:** 日本語の文末形態（終助詞、言い切り、接続助詞）によるルール基準。
3. **代替 B:** LLM または小型日本語モデル。A と比較し、モデル名と精度を開示。

- 代替は **TurnGPT 再現とは呼ばない。** `docs/turngpt_validation.md` に3種のサンプル（意味が続く／文法的に終わるが続きがある／明確に終わる）の結果を残す。
- 推定器ごとに閾値表を持つ（代替の p の尺度は TurnGPT と一致しない）。`policy.ja.json` で校正する。
- 推定器なしでも動く（仕様§7-4）。その場合 VAP が譲渡を示さなければ上限 3000ms 待つことになり、HRI 近似度が下がると明記する。

### 4.5 InitiativeMonitor と候補の判定

- **判定基準（追補1）。** 入力は安定した逐次 ASR、AI の役割・関心・会話目的（`persona.ja.json`）、未解決の候補。列挙値は `NONE/NEW/KEEP/REVISE/WITHDRAW` のみで、`NO_INTENT` などは導入しない。`NEW` の前に順に検討する。
  1. **内容価値:** AI 自身の立場で具体的な質問・異議・提案の理由があるか。相槌、一般的な質問、介入のための介入は `NONE`。役割と無関係なら無理に生成しない。
  2. **今申し出る理由:** 話し終わるまで待っても変わらないなら、原則 `NONE` として `ResponsePrefetch` に任せる。
  3. **後続での解消:** 人間がまもなく説明や自己修正をする可能性があるか。新しい音声情報ごとに `KEEP/REVISE/WITHDRAW` を更新する。
  4. **発声との分離:** `NEW` は吸気の強制開始でも発話許可でもなく、合図のゲートと TurnManager に委ねる。
- **`reason`、`why_now`、`cost_of_waiting` は説明であって正解ではない。** 内的動機や適時性の根拠として扱わず、ゲートの判定に使わない。入力の ASR と照合できない根拠は棄却する。人間の感情や意図を事実として書かせない。
- **`ResponsePrefetch` と起動条件を共有しない。** 内容の増分（安定した新規テキストの量または文節境界）で起動。ターン完了確率に依存させず、固定周期で起動しない。
- **実行方式:** 実行中の要求は**最後まで走らせ**、完了後、**新しい増分があれば**最新の入力で1回実行する（話し続けている間に毎回中断すると完了しなくなるため）。初期は途中の中断をしない。
- **鮮度は revision の完全一致で判定しない**（interim ごとに増えるので、完了時には常に古くなる）。次の全部を満たす結果だけを有効とする: (1) `evidence_span` が最新の安定テキストに残っている、(2) 入力以降の新規安定テキスト量と経過時間が上限以内（`policy.ja.json` の `initiative` 節に【暫定】値を置き、S と G で同じ値を読む。経過時間の上限は LLM 遅延の p95 以上にする）、(3) `candidate_id` と版が一致。超えた結果は合図せず、最新の入力で再判定する。「すでに解消したか」は次の実行の LLM が判定し、`WITHDRAW` を出す。この解釈（仕様§5 の「比較と破棄」の具体化）は `docs/known_gaps.md` に記録し、取消率と空振り率で検証する。
- **決定的な検証:** `evidence_span` が入力に実在しなければ棄却。`evidence_segment_ids` の実在と span の包含も確認する（G には ASR 区間を番号つきで渡す）。`stability` が低ければ合図を出さない。`stability` は 0.0 が「未設定」の印なので nullable にし、`stability_source` を記録する。取れないモデルでは「連続 N revision で不変かつ一定時間経過した接頭部」で代替する。
- **逐次精製:** 新しい部分文が来たら、候補について仕様§5 の (a)〜(d) を同じ要求または軽量な要求で判定。
- **項目の使い方:** `expiry_policy` は再判定の契機に使う。`intent_type` はログと発話の組み立てに使う。**`urgency` はログのみ**とし、`turn_allowed` の優先度に入れない（仕様§4 は「発言の緊急性ではない会話上の優先度」と規定）。`priority` は `intent_type` ごとの固定の規則で決め、モデルの説明文は使わない（E3 で定義。それまでは null と理由を記録）。
- 回数と費用を記録し、上限に達したら研究者画面に出す。
- 責任の分離: G は LLM の判定イベントの発行まで。**候補の状態の正本と ID・版の採番は E**（仕様 JSON の `candidate_id` は LLM が生成せず、E が振る）。**F の候補ストア IF**（登録して ID と版を返す、一覧、更新）と test double を S、G、E2a が共通で使う。`initiative.decision` の `NEW` は採番の後に emit する。

### 4.5a 反例テストと先行スパイク（追補3・4）

Phase 1 と**並行して**、録音済み音声の逐次 ASR をリプレイして `InitiativeMonitor` だけを検証する軽いスパイク（S）を行う。独自の発話希望判断の失敗を早く見つけるためで、会話体験の完成とは見なさない。

| 反例（追補3） | 期待 | 検証の層 | 関門 |
|---|---|---|---|
| 長いが言う価値のない説明 | `NONE`、合図の要求なし | LLM（実モデル） | S と G2 |
| 途中の疑問を数秒後に本人が解消 | `WITHDRAW`、古い TTS を破棄 | LLM＋破棄はコード | S と G2 |
| ASR の誤認だけで矛盾が見える | 証拠不安定として合図の要求を抑止 | コードのゲート＋LLM | S と G2 |
| 重要な異議だが話し終わってからで十分 | 通常の応答待ち、途中の合図なし | LLM | S と G2 |
| 役割・関心と無関係な話題 | 候補を生成しない | LLM | S と G2 |
| 吸気後も人間が話し続ける | 引き延ばさず自然に戻る、発声しない | 状態機械（E2）。波2までは吸気がないので対象外 | **G3** |

**素材の取得経路:** 反例の音声は利用者が収録する（§9）。S の収録スクリプトが WAV を C の Google プロバイダへ実時間で流し、`stt.*` の JSONL を `fixtures/initiative/` へ保存する。リプレイはこの JSONL を読み、波4の J の注入も同じ形式を読む（基盤を2つ作らない）。`stability` の有無もこの経路で確かめる。

**判定の置き場:** 判定関数、プロンプト、persona は S の時点から `cognition/initiative/` に置き、`tools/initiative_spike/` は実行器だけにする。**S で通した結果が本実装にそのまま当てはまるようにする。** プロンプトには版を付けて記録する。

**2段の関門:**
1. **波2の着手条件:** S の素材と固定したプロンプト版で、LLM 層の反例が実モデルを通過する。
2. **G2:** 同じ素材を本実装で再実行する。

S の実モデル試験は C（Google プロバイダ）、Gemini プロバイダ、キー、収録に依存する。

- **コードで判定できる層は test double で自動試験する。LLM の判断の層は実モデルでしか合否を出さない。** test double の結果を LLM の性能として報告しない。キー受領までは「未検証」と記録する。
- **合格は理由文のもっともらしさで決めない。** 時刻つきの実音声と逐次 ASR のリプレイで、研究者が「内容の妥当性」「今申し出る必要性」「待機・撤回の妥当性」を**別々に**評価できる記録を出す（評価欄は3列に分ける）。
- 検討事項: `NEW` の後に自己修正を待つ明示的な段を設けるか。Jarvis はターン単位の持続カウントで待つが、話の途中ではターン数を使えないので値は流用しない。反例2の結果を見て S で判断する（`related_work_notes.md`）。

### 4.6 InitiativeNegotiator（状態機械）

仕様§4 の遷移に従う純粋関数。**`want_to_speak`・`permitted_to_speak`・`speaking` は別の変数で持つ。**

| 論点 | 決定 |
|---|---|
| 吸気の回数 | 候補につき1回で完結。ループしない |
| 人間が話し続けた場合 | 短い準備姿勢 → `DEFERRED`（脱力）。長時間の保持はしない |
| 合図のゲート（signal gate、E2 が担当） | 次を全部満たすときだけ合図: `NEW` の鮮度と検証に合格、AI 非発話、合図の冷却時間を超過、活動中の候補が1つまで。**活動中に来た別の `NEW` は棄却し、理由を `candidate.state_changed` に残す**（吸気の連続を防ぐ） |
| 候補の期限 | `policy.ja.json` の `initiative` 節（秒数または `segment_id` の変更）。`expiry_policy` は再判定の契機で、期限とは別 |
| `REVISE` | 再吸気しない |
| 再合図 | 新しい根拠があり、冷却時間を超えた場合だけ（既定は無効で開始） |
| 吸気中に発話機会が来た場合 | 吸気を完了してから話す（通常応答も含めて開始を保留。この調停は E2 に入れる）。**開始の直前に許可を再評価**し、ユーザーが再開していたら `DEFERRED` へ |
| `DEFERRED` の出口（仕様の図になく、計画で補う） | 許可が出たら `SPEAKING`（再吸気しない。短い発話直前の準備動作のみ）。内容が無効になれば `WITHDRAWN`。候補の期限切れで `WITHDRAWN`。この決定は G4 の観察で見直す。**波3の暫定:** E3 まで発話には進めず、通常応答の開始または期限で撤回する（E2 に実装） |
| `turn_allowed` | 招待、音声状態、VAP、テキスト完了、優先度の全入力をログへ（仕様§4）。譲渡を確定的に知ったとは表示しない |
| 招待の検出 | STT の語句検出（誤認しうる）を E の入力関数として実装 |
| 候補と先行応答の選択 | 招待の種類で分ける。「どうぞ」なら候補。**直前の発話が直接の質問なら応答または両者の統合**。**招待のない自然な譲渡**では、候補が有効なら候補を話す（判定が古くない場合に限る）。**通常応答を話し始めたら残っている候補は撤回**し、`candidate.state_changed` に記録する（必要なら次のターンで再判定）。選択理由をログへ |
| 破棄 | 撤回・改訂時に対応する未再生 PCM を同時に破棄 |

研究条件は `reactive`／`initiative_no_cue`／`initiative_inhale`。候補生成までは同じ経路を通し、違いは制御器の設定だけにする。Wizard-of-Oz の上書き（UI は I、入力は E、配線は J）は別イベントで記録する。

### 4.7 吸気アバター

- 通常呼吸と準備吸気を**別パラメータ**で実装（深さ、速度、保持、頭部姿勢を連続値で）。
- **胸郭:** 読み込み時に生成する専用モーフを中心にする（胸骨付近のスキンウェイトと位置から変位を計算、服も同じ関数で変形）。`upperChest` のスケールを使う場合は子ボーンへの継承を逆補正する。
- **関門:** 録画で体積変化が足りない、または頭部や腕が歪むなら Blender のリグ調整へ（環境に Blender はなく、その場合は相談）。
- 肩・鎖骨の小さな挙上、首・頭の微小な姿勢変化、口の準備、表情を時系列で協調。吸気音は別パラメータで既定オフ。視線も切替可能にして吸気の効果と分離。
- **待機動作:** 瞬きと微小な姿勢変更を実装する。吸気と紛らわしい動き（肩の挙上など）は使わず、吸気の前後では抑える。録画で区別を確認。
- **口形:** 語単位の時刻＋音量包絡。発話停止と同時に閉じる。
- `/lab/breath` で単体調整と録画比較を行う。

### 4.8 障害時の振る舞い

各プロバイダと MaAI の状態を研究者画面へ出す（最小表示は波1から）。擬似結果へ黙って切り替えない。開発用プロバイダや test double を使うセッションはログと画面に明示し、受け入れの証拠に数えない。

### 4.9 録音とリプレイ

- 録音はオプトイン（既定オフ、同意の設定あり）。mic と system の WAV を `audio_frame` つきで保存。担当は I（波2の I2）、配線は J。
- リプレイは2段: **VAP は WAV から再計算**、**STT と LLM は記録を注入**。制御器を同じ入力で再実行し、イベント列を比較する。担当は B（VAP）、J（注入）、I（UI）。
- 提出ログは `tools/anonymize/` を通す（transcript は個人情報を含みうる）。

---

## 5. タスクの割り振り

実装エージェントの同時実行は**最大4本**（メモリ 9GB）。S は重い処理を持たないので数に入れない。1レーンは §3.1 の持ち物のみ触る。統括は契約の受け渡し、統合、関門の判定を担当する。

### 5.1 レーン

| レーン | 成果物 | 主な試験 |
|---|---|---|
| **F 土台** | monorepo、§3.3 の RPC 契約、**Browser↔Node の双方向契約**（下りの PCM 枠、世代番号、停止命令、再生位置の報告）、§3.5 のイベントスキーマ、`emit()` と時刻源、`step` の入出力型、**STT／TTS／LLM プロバイダの TS インターフェースと test double**、会話履歴の参照・更新インターフェース、**候補ストア IF と test double**、**制御メッセージと Browser/Python からの emit 転送**（§3.4）、`asr_segment_id`、**偽サーバー一式**（ブラウザ音声エコー、MaAI RPC、Google、ElevenLabs、Gemini）、`policy.hri2025.json`、`policy.ja.json` の雛形、Python lock | スキーマの必須項目と往復、Python 側の検証 |
| **R1 論文対応** | Appendix A の全文転記、節ごとの再現／差分、機材差、§4.1 の解釈の記録、RESPOND と Jarvis の注意（新規性を確定しない） | 統括が原文と照合 |
| **S 先行スパイク** | 判定関数とプロンプト（`cognition/initiative/`）、persona、リプレイ実行器、収録の手順とスクリプト、3列の評価記録。波2で G へ移管 | コード層は test double、LLM 層はキーと収録の後に実モデル |
| **R2 MaAI 検証** | **2ch 実音声**での出力スキーマ、**p の向き**、`jp`／`jp_kyoto`、`normal`／`normal-ver2` の比較、G0 用の負荷ページ（Three.js） | 既知の音声で向きを固定する試験 |
| **R3 TurnGPT 検証** | §4.4 の 1 の判定 | 再現手順 |
| **R4 プロバイダ検証** | Google／ElevenLabs／Gemini の機能、制限、料金、モデル ID。実呼び出しはキー受領後 | 検証スクリプト |
| **A ブラウザ音声** | §3.2 全部 | フェイクマイク往復、変換の周波数特性、ずれと欠損の測定 |
| **B MaAI ワーカー** | §3.3、WAV リプレイ、未稼働の明示 | 2ch 投入、チャネルずれ、遅延時の同時破棄、停止通知 |
| **C STT／TTS** | Google v2（ストリーム切替時の revision 順序の規則つき）、ElevenLabs、`segment_id`。開発用のローカル STT は、本番 STT が実測で動いたので**作らない**（E2E は Scripted プロバイダを使う）。Gemini TTS を `TtsConnection` の代替として足す（第8版。ElevenLabs のキーが無くても実音声で試すため。既定は ElevenLabs の認証情報があれば ElevenLabs、無ければ Gemini。字単位の alignment が無ければ口の同期は推定値で、推定と明記する。利用可否は【未確認】） | 偽サーバーで切断・遅延・再接続、切替時の順序。Gemini TTS は実 API で利用可否と初音までの時間を確認 |
| **D 応答と音声** | Gemini、ResponsePrefetch、SpeechGenerator、類似度、推定器 | 取消の連鎖、世代違いの棄却、`is_ready` |
| **E 制御** | E1: TurnManager、準備の判断、視線、鮮度切れ、招待の語句検出／E2a: 候補の状態と採番／E2: 合図のゲートと遷移、吸気中の発話保留、波3の暫定の出口／E3: 発話開始の交渉、`DEFERRED` の出口、候補と応答の選択、条件切替と WoZ の入力、`priority` の規則 | **Appendix A の分岐ごとの表形式試験**、状態遷移の全経路 |
| **G 発話希望** | §4.5 | 古い応答、`evidence_span` 不在、`NONE` の多さ、実行方式 |
| **H アバター** | H1: VRM 読み込みと音量の口、最小の視線／H2: §4.7 | 実ブラウザで録画、モーフの適用 |
| **I 研究者機能** | I1: JSONL、時刻、費用、状態の最小表示／I2: 候補イベントのライブ表示、p の時系列、分位点、取消・空振り率、自由回答、録音、条件切替と WoZ UI／I3: リプレイ UI、匿名化 | 記録からの再描画、匿名化の確認 |
| **J 統合** | WS サーバー、Node の MaAI クライアント、配線（波2の InitiativeMonitor と研究者画面への配信を含む）、会話履歴、参加者画面、E2E、WoZ の配線、STT/LLM の注入 | フェイクマイクの実音声 |
| **K 文書（統括）** | §7 の提出物 | 手順どおりに起動できるか |

### 5.2 順番

```text
波0 調査と土台 : F → 並行で R1 R2 R3 R4                → 関門G0
波1a Phase 1  : A B C D                               （4本）＋ S（並行、軽量）
波1b Phase 1  : E1 I1 H1 → J（配線）                    → 関門G1 ★5分対話
   着手条件   : S の LLM 層の反例が実モデルを通過（§4.5a）
   現状       : 手書き ASR の予備実行のみ（C1〜C4、C6 が想定どおり、各 n=1、C5 は未実行）。実音声と実 ASR と研究者の評価は未実施で、この条件は未通過。11-08 夜の自動実行では利用者の収録を待てないため暫定的に実装を進める。G2 の判定はこれで緩めない
波2 Phase 2   : G（S から移管） I2 E2a → J（接続）       → 関門G2
波3 Phase 3   : H2 E2 → J（接続）                       → 関門G3
波4 Phase 4   : E3 I3 → J（WoZ、注入）                  → 関門G4
```

- 依存: 全レーンが F に依存。E1 は R2 の向きの確定に依存。C と D は R4 に依存（キーが遅れても偽サーバーで進められる）。
- 波1aのレーンは J を待たず、F の偽サーバーと test double で単体確認する（A は `app/dev/audio/` で実ブラウザ確認）。
- **G1 を通るまで吸気の作り込みはしない**（H1 は最小限）。
- 契約を変える必要が出たら、レーンは統括へ連絡し、統括が F の契約を更新して関係レーンへ伝える。

### 5.3 関門（通るまで次へ進まない）

| 関門 | 通過条件 | 確認者 |
|---|---|---|
| **G0** | 2ch の実音声で**5分以上**、既定候補の重みで、RTF の p95 < 0.7【暫定】、キュー滞留なし、ブラウザ描画を同時に動かした負荷でも維持。p の向きを実測で確定。TurnGPT の判定を記録。依存とライセンスを記録 | 統括＋独立レビュー |
| **G1** | 自動: E2E、切断試験、割り込み時に発話済み部分のみ履歴へ、JSONL のスキーマ検証、VAP の値が system チャネルの AI 音声に反応している、AI 発話中のポーズで `gaze.decision` が発生して描画に反映される。**実機: 利用者がヘッドセットで5分対話し、ログを確認** | 利用者＋統括 |
| **G2** | **§4.5a の関門 G2 の反例5件を同じ素材と本実装で再実行して通過**。長い発話の途中で異なる内容の `NEW` が理由と断片つきで発生。撤回が機能。固定周期でないことをログで確認（増分駆動なので、起動間隔が LLM 遅延と増分の両方に従うことを分布で確認）。この段階は研究者画面にのみライブ表示 | 利用者の実音声＋統括 |
| **G3** | **反例「吸気後も人間が話し続ける」を通過。** 実制御の遷移で吸気、準備姿勢、脱力が破綻しない。**発声と吸気の時刻が一致しない場面**（吸気の途中で発話機会が来る、吸気の後に長く待つ）でも破綻しない。体積変化が見え、頭部が歪まない。待機動作と区別できる。**自然さの判断は利用者が録画で行う** | 利用者 |
| **G4** | §6 の全項目、3条件の切替、WoZ、提出物 | 利用者＋3観点の独立レビュー |

各波の終わりに、実装者とは別のエージェントが読むだけの点検を行う（かみ合わせ／責任の分離／仕様の全行とエッジケース）。重大・中が 0 になるまで直す。

---

## 6. 受け入れ基準の対応表（仕様§10）

| 仕様§10 の項目 | 担当 | 証拠 | 自動で足りるか |
|---|---|---|---|
| 5分ハンズフリー | A C J | 実セッションのログ、途切れの計測 | **不足、利用者の実機が必要** |
| 発話途中の `initiative.NEW` | G | ログ（時刻、理由、断片） | 不足、実 LLM が必要 |
| 音声認識・LLM・アニメの遅延分布 | C G H I | §3.6 の全区間の分位点。未計測は「未計測」と表示 | 実機の値が必要 |
| 解消時に `WITHDRAW`、古い音声が出ない | E G D | 試験＋ログ | 論理は自動、実機確認も必要 |
| 「どうぞ」で開始、理由をログ | E J | `turn.allowed` のログ | 不足 |
| 割り込みで再生と口形が停止、発話済みのみ履歴 | A D E H | 試験＋ログ | 論理は自動、実機確認も必要 |
| 真の MaAI、2ch 時系列プロット | B I | 実ログ、プロット | 自動で可 |
| TurnGPT または代替の検証 | R3 D | `turngpt_validation.md` | 自動で可 |
| 吸気の同期と自然さ、相槌・待機呼吸との区別 | H I | 録画、自由回答 | **不足、人の評価が必要** |
| 部分障害の可視化 | 各プロバイダ I | 障害注入の試験 | 自動で可 |
| 音声ログのリプレイ | B J I | §4.9 の2段リプレイの比較 | 自動で可 |
| 未実証の結論を書かない | 統括 | 完成報告の点検 | 人の確認 |

---

## 7. 提出物の担当（仕様§10 末尾）

材料を出すレーンが書き、K（統括）が波ごとにまとめる。

| 提出物 | 材料 |
|---|---|
| `README.md`（旧デモの内容を置き換え）、起動手順 | J、K |
| `.env.example`、切替設定 | F、C、D |
| `DEPENDENCIES_LOCK.md`（commit SHA、バージョン、checkpoint） | F、R2、R3、R4 |
| `THIRD_PARTY_NOTICES.md`（CPC、VRM の公式確認を含む） | F、R2、H |
| `docs/architecture.md` | F、K |
| 匿名の実ログ | I（`tools/anonymize/`） |
| 録画または動作確認の手順 | H、J |
| `docs/acceptance_results.md`（結果表） | 全レーン、K |
| `docs/known_gaps.md`（未完了一覧、HRI との差分） | 全レーン、R1、K |

---

## 8. 主なリスク

| リスク | 影響 | 対処 |
|---|---|---|
| キー未提供 | Phase 1 の実機確認が止まる | 偽サーバーと開発用 STT で配線まで進める。**受け入れには数えない** |
| LLM が発話途中に必要な速さで有意義な候補を出せない | 研究の中心現象が成立しない | G2 で最初に測る。§4.5 の実行方式の影響と切り分ける。モデルと入力量を調整。成立しなければ報告して相談 |
| `long` の認識精度が会話で足りない | 候補の質が落ちる | 反例の収録音声で確認。代替は `gpt-live-transcribe`（`chirp_3` と `chirp_2` は interim の頻度で不適と実測） |
| Google STT のストリーム上限 | **302秒に `ABORTED: Max duration of 5 minutes` で切れると実測**（`long`、東京）。5分対話の途中で切れる | 240 秒で重ね始め、期限 285 秒、切替点は無音に置く |
| `stability` が得られない | 誤認識に反応した吸気 | §4.5 の代替 |
| 2ch の VAP 値が日本語で譲渡判定に効かない | 発話開始が遅い／誤る | 原著値と調整値を比較。VAP の主張範囲は超えない |
| AEC なしの運用 | スピーカーでは自己音声が混入 | ヘッドセット必須と案内。研究者画面で入力の設定を表示 |
| 胸郭の変形が見えない | 吸気が伝わらない | §4.7 の関門で Blender へ |
| ElevenLabs の語境界が日本語で粗い | 履歴と口形の精度が落ちる | 文字単位や時間比例で補間し、精度を明記 |
| API 費用（先行生成の破棄分も課金されうる） | 想定外の請求 | 記録と上限。起動条件を調整 |
| 描画が音声を妨げる | 音切れ | §3.2 の Worklet と Worker で主スレッドから分離 |

---

## 9. 利用者に決めてもらうこと・お願いすること

### 確認なしで先行する範囲

調査（R1〜R4）、土台（F）、波1a（A〜D）、スパイク（S）のうち、キーと実機が不要な部分。実 API の呼び出しと人の評価は用意の後に行う。旧デモの移動、`.venv` の削除、最初の commit は §1.3 の順で統括が行う。

### 判断の結果（2026-11-08 回答）

- 利用区分は**非営利**。`jp` 系（CC-BY-NC-ND）を使ってよい。既定は R2 の比較で決める。重みは再配布・改変しない。
- ローカル `git init` する（push なし、波の区切りで commit）。旧デモを `legacy/` へ移す。旧仕様の取得物を削除する。移動と `.venv` の削除は、使用中のレーンが終わってから実施する。

### 回答前の判断材料（記録）

1. **MaAI の重みの利用区分。** 営利目的と見なされる可能性があるなら `*_kyoto`（MIT）を既定に。純粋な非営利研究なら `jp` も使える。README はシステム開発や共同研究について井上昂治氏への連絡を案内している。推奨: **既定を `jp_kyoto`** とし、`jp` は区分を確認してから比較。
2. **ローカル `git init`（push なし）の可否。** 波の区切りを commit できると統合と巻き戻しが安全になる。推奨: する。
3. **旧デモの `legacy/` への移動**（削除はしない）。推奨: する。
4. **旧仕様の作業で私が取得した物の削除**（§1.3: `.venv`、多言語 STT モデル、Kokoro キャッシュ）。推奨: 削除。

### 用意

**早い方が良いもの（S の実モデル試験の前。発話希望の判断の失敗を早く見つけるため）**

| 用意するもの | 用途 |
|---|---|
| `GEMINI_API_KEY`（**他者の発話を送る前に有料ティアにする**。規約上、無料枠の入出力は改善に使われ人のレビュー対象になりうる。自分の収録だけの開発段階で無料枠を使うかは利用者の判断） | LLM |
| Google Cloud プロジェクト＋ Speech-to-Text API 有効化＋認証情報 | 本番 STT、反例素材の逐次 ASR |
| 反例6種の音声の収録（手順とスクリプトは S が用意） | §4.5a の素材 |

**G1 の前まで**

| 用意するもの | 用途 |
|---|---|
| `ELEVENLABS_API_KEY` と日本語の声の `voice_id` | TTS |
| 有線のヘッドセット（近接マイク） | 実機試験 |
| 実機試験の時間（G1〜G4 で各回、数分〜数十分） | 人の確認が必要な関門 |

キーは `.env` にのみ置き、コミットしない。
