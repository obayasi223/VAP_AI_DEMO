# 発話希望の二段判定（生成とタイミングの分離）の設計メモ

状態: セッション、交渉、開始画面、記録まで配線済み（既定は `llm`、会話の種類の既定は `joint_thinking`）。
**モデルの判断の妥当性は確かめていない。** 試験の LLM は台本で、手書きの素材での実 API の確認は動作確認のみ（§5）。

## 1. 決定

利用者の方針: `initiative-ja-v2` の (a)〜(c) は研究用の最終判定基準にしない。発話希望の生成と、申し出るタイミングを分離し、共同思考とコンパニオンの2種類の会話で検証可能にする。HRI 2025 系の基盤は維持する。回数ではなく、内容と申し出る時点の適切さを評価する。発生回数を増やすための調整はしない。

| 段 | 判定すること | 判定しないこと |
|---|---|---|
| 生成段（desire） | AI の側に言いたいことが生じたか（`NONE`／`NEW`／`REVISE`）、意図の種類、言いたい内容、根拠（入力の逐語の抜き出し） | 今言うべきか。話の途中かどうか |
| タイミング段（timing） | 未解決の希望を「話の途中で申し出る」（`OFFER_NOW`）、「話し終わりまで待つ」（`WAIT_FOR_TURN_END`）、「取り下げる」（`WITHDRAW`）に分け、その理由を書く | 内容の良し悪しと書き換え |

2つの段はプロンプト、出力の形（`staged_output.ts`）、ログのイベント（`initiative.desire`、`initiative.timing`）を分ける。差し替えは版（`staged_prompt.ts` の `DESIRE_PROMPTS`、`TIMING_PROMPTS`）と方式で行う。

`initiative.decision` の `NONE/NEW/KEEP/REVISE/WITHDRAW` は、v2 仕様の正本としてそのまま残す（追補2）。二段の経路は E2a の入口（`applyModelDecision`）へこの5値で渡す。生成段の `NEW`／`REVISE`／`NONE`、タイミング段の `WITHDRAW`／`KEEP`。`OFFER_NOW` と `WAIT_FOR_TURN_END` は別の軸の値で、E2a の状態を変えない（`KEEP` で判定の鮮度の基準を進めるだけ）。

## 2. 方式

`timing_strategy`（`policy.initiative.staged`）:

| 方式 | 動き | 遅延 |
|---|---|---|
| `llm`（既定） | 未解決の希望があるときだけ2回目の LLM を呼ぶ。入力は生成段の後の最新の安定テキスト | 2回目のぶん増える。1回ごとに `latency_ms` を記録 |
| `immediate`（比較用） | LLM を呼ばず、希望が残っている間は `OFFER_NOW`（次の機会に申し出る）を記録する | タイミング段の遅延なし |
| `v2`（比較と再現用） | 既存の1段判定 `initiative-ja-v2` をそのまま。新しいイベントを出さない | 既存どおり |

`policy.initiative.staged` を置かない場合も既存の1段判定のまま。

選び方と記録: `?conversation_kind=` と `?timing_strategy=`（開始画面の選択と同じ。`CONVERSATION_KIND_FROM_CLIENT=0`、`TIMING_STRATEGY_FROM_CLIENT=0` で固定）。既定は環境変数 `CONVERSATION_KIND`／`TIMING_STRATEGY`、なければ `policy.initiative.staged`。適用したものだけを manifest の `initiative` に残す（`timing_strategy`、`conversation_kind`、`desire_prompt_version`、`timing_prompt_version`、`profile_version`、由来 `*_source`）。`v2` のときは会話の種類を適用していないので `conversation_kind` は null。

交渉（`control/negotiator.ts` の `timing_gate`）: 吸気の合図にはこの版のタイミング段の `OFFER_NOW` が要る。未判定（`timing_not_judged`）と `WAIT_FOR_TURN_END`（`timing_wait_for_turn_end`）は合図しない。`WAIT_FOR_TURN_END` の候補は合図も準備動作もなく、話し終わりの許可（`selectSpeech`）で話す（吸気の条件でも `from:INTENT_READY`）。タイミング段が未判定の間は候補を話さず通常の応答へ。音声の先行準備は NEW の次の tick（方式によらず同じ。`WAIT_FOR_TURN_END` の候補も話すことがあるので作る）。`v2` は `timing_gate` なしで従来どおり。

AI の開始の後に届いた前の segment の文は判定を起動しない（`InitiativeMonitor.noteAiStarted`。`segment_id` が進むのは AI の開始の tick だけで、そうした判定は E2a が `ai_started_speaking` で棄てるため）。実行中の要求の結果の扱いは変えていない。

タイミング段の判定は候補に結びつけて `InitiativeMonitor.latestTiming(candidate_id, candidate_version)` で読む（版が変われば前の判定は読めない）。合図の許可でも発声の許可でもない（want ≠ permitted ≠ speaking）。negotiator への接続は第2段階。

## 3. 会話の種類

`config/conversation_kind.joint_thinking.ja.json`（共同思考、一緒に考える相手）と `config/conversation_kind.companion.ja.json`（コンパニオン、寄り添う話し相手）。persona と、段ごとの観点（`desire_lens`、`timing_lens`）を1ファイルにまとめる。発話希望の中身の例（共同思考は問い・異議・提案・補足・食い違いの指摘、コンパニオンは共感・気持ちの確認・自己開示・関連する話題）は**暫定の出発点**で、確かめていない。特定の議題の語は入れない。既存の `config/persona.ja.json` と `persona.ja.conversation.json` は残す。

## 4. 入力と根拠の範囲

- **入力:** 今話している側の安定テキスト（`StableTranscriptView`、既存の `high_water`）に加えて、直近の会話（人と AI の発話。今の segment より前。AI は実際に声に出た部分だけ）を `recent_context` の範囲で渡す。タイミング段にも同じ範囲を渡す。
- **根拠の範囲（決定）:** `evidence_span` は今話している側の入力にある必要がある（E2a の `verifyEvidence` と同じ照合。過去のターンにしかない語は通らない）。過去のターンは `prior_turn_evidence_span` で「根拠の一部」として示せるが、**単独では希望を成立させない**（今の発話の根拠が必須）。示された語が見せたターンに逐語でなければ、その希望ごと棄却する（追補1「入力と照合できない根拠は採用しない」）。一致したターンの位置と役割をコードが記録する（`prior_turn_evidence`）。今の発話の前半を誤ってここに書いても、実在するので棄却せず、過去の根拠としては数えない。
- E2a の根拠の照合は今の segment だけを見るので、過去のターンへ広げるなら E2a の変更が要る（今回はしない）。

## 5. 評価のための記録

`initiative.desire` と `initiative.timing` は段ごとに: `transcript_revision`（入力の版）、`history_version`、`input_segment_ids`、`recent_turn_count`、`model_version`、`prompt_version`、`conversation_kind`、`profile_version`、`sent_at`／`received_at`／`latency_ms`（実測）。LLM が書いた理由（`reason`、`why_now`、`cost_of_waiting`、`withdraw_reason`）は `ModelOutput` で包み、コードのゲートの結果（`gate`）と分ける。数値の話したい度合いは足さない（`urgency` と `expiry_policy` は候補の項目を埋めるコードの固定値で、モデルの判断ではない。生成段の出力にない）。

研究者の評価（内容の妥当性、申し出る時点の適切さ）は、`initiative.desire` と `initiative.timing` を別々に読めばよい。`llm.request`／`llm.response` と `request_id` で結べる（タイミング段の `request_id` は `<生成段の id>_timing`）。

## 6. 暫定の値（どれも未検証）

- `recent_context`: `max_turns` 6、`max_chars_per_turn` 300（長いターンは後ろを残す）。根拠なし。
- `max_requests_per_session`（200）はタイミング段の呼び出しも数える。
- 起動の条件（`trigger` 24／12）と鮮度の上限は既存の値のまま（方式で変えない）。
- 実 API の遅延（`gemini-3.5-flash-lite`、`minimal`、手書きの短い素材の直列の実行、合計 36 回の呼び出しのうち判定 18 組）: 生成段 p50 1280ms、p95 1748ms（n=18）、タイミング段 p50 1187ms、p95 1883ms（n=18）。これは素材と環境を選んだ動作確認の値で、実音声の値ではない。

## 7. 限界

- 自然な実音声での確認はこれから（利用者の方針）。手書きの素材と台本の LLM は妥当性の根拠にならない。
- タイミング段は生成段の後なので、希望の発生から `OFFER_NOW` までの遅れは2回の呼び出しの合計になる（実測は上記）。生成段と並列にする最適化はしていない。
- `active_candidate_exists` のとき E2a は新しい `NEW` を棄却する。2つ目の希望は `initiative.desire` の `rejected` として残るだけで、キューにはしない。
- タイミング段は最新の活動中の候補を1件だけ判定する（`max_active_candidates` が 1 の前提）。
