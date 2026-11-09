# 発話希望の二段判定（生成とタイミングの分離）の設計メモ

状態: セッション、交渉、開始画面、記録まで配線済み（既定は `llm`、会話の種類の既定は `joint_thinking`）。
**モデルの判断の妥当性は確かめていない。** 試験の LLM は台本で、手書きの素材での実 API の確認は動作確認のみ（§5）。

**ベースラインは未確定。** `v2`（1段判定）は比較と再現のために残すが、研究上の正式なベースラインとしては固定していない。条件 `reactive` の表示名「通常応答（ベースライン）」は、条件の名前であって、この判定方式の比較の基準を決めたものではない。

## 1. 決定

利用者の方針: `initiative-ja-v2` の (a)〜(c) は研究用の最終判定基準にしない。発話希望の生成と、申し出るタイミングを分離し、共同思考とコンパニオンの2種類の会話で検証可能にする。HRI 2025 系の基盤は維持する。回数ではなく、内容と申し出る時点の適切さを評価する。発生回数を増やすための調整はしない。

| 段 | 判定すること | 判定しないこと |
|---|---|---|
| 生成段（desire） | AI の側に言いたいことが生じたか（`NONE`／`NEW`）。保留中の希望があれば後続の発話で内容を再評価する（`KEEP`／`REVISE`／`WITHDRAW`）。意図の種類、言いたい内容、根拠（入力の逐語の抜き出し） | 今言うべきか。話の途中かどうか |
| タイミング段（timing） | 未解決の希望を「話の途中で申し出る」（`OFFER_NOW`）、「話し終わりまで待つ」（`WAIT_FOR_TURN_END`）に分け、その理由を書く。後続の発話ごとに判定し直す（`WAIT`→`OFFER_NOW` も可） | 内容の良し悪しと書き換え、撤回 |

2つの段はプロンプト、出力の形（`staged_output.ts`）、ログのイベント（`initiative.desire`、`initiative.timing`）を分ける。差し替えは版（`staged_prompt.ts` の `DESIRE_PROMPTS`、`TIMING_PROMPTS`）と方式で行う。

`initiative.decision` の `NONE/NEW/KEEP/REVISE/WITHDRAW` は、v2 仕様の正本としてそのまま残す（追補2）。二段の経路は E2a の入口（`applyModelDecision`）へ生成段の5値をそのまま渡す。`OFFER_NOW` と `WAIT_FOR_TURN_END` は別の軸の値で、E2a の状態も判定の基準も変えない（候補ごとの最新の判定として `InitiativeMonitor.latestTiming` に残すだけ）。未解決の希望があるときの `NONE` は `KEEP` として扱う。

**内容の撤回と「今は言わない」の区別。** 内容の撤回は生成段の `WITHDRAW` だけで、分類（`withdraw_kind`）と逐語の根拠が要る。タイミング段の `WAIT_FOR_TURN_END` は候補を消さない。ログでは次で別々に読める。

| 何が起きたか | 記録 |
|---|---|
| 内容の撤回 | `initiative.desire`（`desire: WITHDRAW`、`outcome: withdrawn`、`withdraw_kind`）、`candidate.state_changed`（モデル由来、`withdraw_kind`） |
| 今は申し出ない（WAIT） | `initiative.timing`（`timing: WAIT_FOR_TURN_END`）、合図のゲートの `timing_wait_for_turn_end`、通常応答の開始で持ち越したら `initiative.not_offered` |
| 通常応答に材料として渡した | `initiative.response_material`（版と文。**渡した事実だけ**） |
| 渡した応答を実際に話した結果（推定） | `initiative.response_reflection`（実際に話した部分だけと比べた `estimated_reflected` と根拠の値。**推定で確定ではない**。§9） |
| すでに話した内容なので撤回（コードの比較） | `candidate.state_changed`（コード由来の `already_said`）、`initiative.already_said`（比較の方法、値、基準、一致した文。§9） |
| 期限切れ | `candidate.state_changed`（コード由来の `expired`） |
| 音声が間に合わない、作れない | `candidate.state_changed`（コード由来の `audio_unavailable`）、`negotiation.decision` の `audio_abandoned` |

**撤回の分類（`withdraw_kind`）。** いずれも発話の逐語の根拠が必須で（人の今の発話、または直近の会話の AI の発話。§9）、分類が次のどれでもなければ棄却する（`withdraw_kind_invalid`）。

| 値 | 意味 |
|---|---|
| `question_resolved` | 聞こうとしていた疑問が、相手のその後の発話で解消した |
| `premise_changed` | 希望の前提になっていた事柄を、相手が変えた、または取り消した |
| `topic_moved` | 話題が移り、その希望が今の話と関係しなくなった |
| `already_said` | その内容を AI がすでに話した（`initiative-desire-ja-v3` から。根拠は AI の発話の逐語になることが多い） |

分類はモデルの判定で、コードは形式と根拠しか確かめない。分類が妥当かは確かめていない。同じ名前の `already_said` がコードの比較（`CandidateCause`）にもある。どちらが撤回したかは `candidate.state_changed` の `cause_source` で分かれる（§9）。

**REVISE の抑制。** `REVISE` でも `proposed_utterance` が前の版と実質同じなら作り直さず維持として扱う（小さな言い換えの繰り返しで音声を作り直さないため）。基準は「意図の種類が同じ」かつ「文字 2-gram のコサイン類似度が `revise_min_utterance_similarity` 以上」。`initiative.desire` の `revise_comparison` に方法、値、基準を残し、`outcome` は `revise_suppressed`。根拠の逐語照合は抑制の前に通す。REVISE の根拠は保留中の入力の範囲で検証する。

## 2. 方式

`timing_strategy`（`policy.initiative.staged`）:

| 方式 | 動き | 遅延 |
|---|---|---|
| `llm`（既定） | 未解決の希望があるときだけ2回目の LLM を呼ぶ。入力は生成段の後の最新の安定テキスト | 2回目のぶん増える。1回ごとに `latency_ms` を記録 |
| `immediate`（比較用） | LLM を呼ばず、希望が残っている間は `OFFER_NOW`（次の機会に申し出る）を記録する。**即時に音声で割り込まない。** 吸気で提示し、許可が出たら話す。保持中に人が話し続けたら `DEFERRED` | タイミング段の遅延なし |
| `v2`（比較・再現用。正式なベースラインとしては固定していない） | 既存の1段判定 `initiative-ja-v2` をそのまま。新しいイベントを出さない | 既存どおり |

`policy.initiative.staged` を置かない場合も既存の1段判定のまま。

選び方と記録: `?conversation_kind=` と `?timing_strategy=`（開始画面の選択と同じ。`CONVERSATION_KIND_FROM_CLIENT=0`、`TIMING_STRATEGY_FROM_CLIENT=0` で固定）。既定は環境変数 `CONVERSATION_KIND`／`TIMING_STRATEGY`、なければ `policy.initiative.staged`。適用したものだけを manifest の `initiative` に残す（`timing_strategy`、`conversation_kind`、`desire_prompt_version`、`timing_prompt_version`、`profile_version`、由来 `*_source`）。`v2` のときは会話の種類を適用していないので `conversation_kind` は null。

交渉（`control/negotiator.ts` の `timing_gate`）: 吸気の合図にはこの版のタイミング段の `OFFER_NOW` が要る。未判定（`timing_not_judged`）と `WAIT_FOR_TURN_END`（`timing_wait_for_turn_end`）は合図しない。タイミング段が未判定の間は候補を話さず通常の応答へ。音声の先行準備は吸気の対象になるとき（`OFFER_NOW`）に作る。`v2` は `timing_gate` なしで従来どおり。

**`WAIT_FOR_TURN_END` の扱い（`initiative_inhale`）。** 途中で吸気せず、候補の文をそのまま話さず、話し終わりは通常応答に回す（`selectSpeech` は `reasons: timing_wait_for_turn_end` で `response`）。候補は捨てない。通常応答の開始で撤回せず持ち越し（`carried_over`）、AI の発話の後も生成段が再評価する（維持、更新、撤回）。持ち越しの候補は次の発話の範囲に元の根拠がないので、根拠の残存と撤回根拠の位置の検査を免除する（逐語の照合は保つ）。segment の変更では消えないが、期限 `candidate_expiry_ms` は有効。`REVISE` で今の発話に根拠を得たら持ち越しの印を消す。`OFFER_NOW` で吸気した候補と未判定の候補は従来どおり通常応答の開始で撤回する。`initiative_no_cue` の振る舞いは変えない（`WAIT` は許可で話す。持ち越しも材料もない）。

**通常応答の材料。** 通常応答の準備の時点で手元にある未解決の `WAIT` の候補を、応答プロンプトに「自然に活かせるときだけ使ってよい材料」として渡す（`pending_material_v1`）。強制せず、応答を待たせない。

**合図への反応の記録。** 合図のあとの窓（`cue_reaction_window_ms`）の間、人の発話の有無と `p_now_ai` を tick ごとに見て、窓の満了、AI の発話の開始、候補の解決のどれかで `negotiation.cue_reaction` を1件出す。**「人が譲った」とは確定しない**（記録するのは止まるまでの時間などの観測値だけ）。

AI の開始の後に届いた前の segment の文は判定を起動しない（`InitiativeMonitor.noteAiStarted`。`segment_id` が進むのは AI の開始の tick だけで、そうした判定は E2a が `ai_started_speaking` で棄てるため）。実行中の要求の結果の扱いは変えていない。

タイミング段の判定は候補に結びつけて `InitiativeMonitor.latestTiming(candidate_id, candidate_version)` で読む（版が変われば前の判定は読めない）。合図の許可でも発声の許可でもない（want ≠ permitted ≠ speaking）。negotiator への接続は第2段階。

## 3. 会話の種類

`config/conversation_kind.joint_thinking.ja.json`（共同思考、一緒に考える相手）と `config/conversation_kind.companion.ja.json`（コンパニオン、寄り添う話し相手）。persona と、段ごとの観点と判定条件（`desire_lens.conditions`、`timing_lens.conditions`）を1ファイルにまとめる。生成とタイミングの条件は別々に編集でき、プロンプト本体に種類ごとの語を埋めない。発話希望の中身の例（共同思考は問い・異議・提案・補足・食い違いの指摘、コンパニオンは共感・気持ちの確認・自己開示・関連する話題）は**暫定の出発点**で、確かめていない。特定の議題の語は入れない。既存の `config/persona.ja.json` と `persona.ja.conversation.json` は残す。

**種類の足し方。** `config/conversation_kind.<id>.ja.json` を置くだけでよい（`id` は英小文字で始まる `[a-z][a-z0-9_]*`。コードと契約に列挙しない）。開始画面に出すには `NEXT_PUBLIC_CONVERSATION_KINDS` か `?conversation_kind=`。ファイルがない ID は採用しない。会話空間は確定していない（第三の種類はまだ足していない）。

## 4. 入力と根拠の範囲

- **入力:** 今話している側の安定テキスト（`StableTranscriptView`、既存の `high_water`）に加えて、直近の会話（人と AI の発話。今の segment より前。AI は実際に声に出た部分だけ）を `recent_context` の範囲で渡す。タイミング段にも同じ範囲を渡す。
- **根拠の範囲（決定）:** `evidence_span` は今話している側の入力にある必要がある（E2a の `verifyEvidence` と同じ照合。過去のターンにしかない語は通らない）。過去のターンは `prior_turn_evidence_span` で「根拠の一部」として示せるが、**単独では希望を成立させない**（今の発話の根拠が必須）。示された語が見せたターンに逐語でなければ、その希望ごと棄却する（追補1「入力と照合できない根拠は採用しない」）。一致したターンの位置と役割をコードが記録する（`prior_turn_evidence`）。今の発話の前半を誤ってここに書いても、実在するので棄却せず、過去の根拠としては数えない。
- E2a の根拠の照合は今の segment だけを見るので、過去のターンへ広げるなら E2a の変更が要る（今回はしない）。

## 5. 評価のための記録

`initiative.desire` と `initiative.timing` は段ごとに: `transcript_revision`（入力の版）、`history_version`、`input_segment_ids`、`recent_turn_count`、`model_version`、`prompt_version`、`conversation_kind`、`profile_version`、`sent_at`／`received_at`／`latency_ms`（実測）。LLM が書いた理由（`reason`、`why_now`、`cost_of_waiting`、`withdraw_reason`）は `ModelOutput` で包み、コードのゲートの結果（`gate`）と分ける。数値の話したい度合いは足さない（`urgency` と `expiry_policy` は候補の項目を埋めるコードの固定値で、モデルの判断ではない。生成段の出力にない）。

`initiative.timing` には直前の判定（`previous_timing`）と変化の有無（`timing_changed`）を残すので、発話中のタイミングの変化を時系列で読める。

研究者の評価（内容の妥当性、申し出る時点の適切さ）は、`initiative.desire` と `initiative.timing` を別々に読めばよい。`llm.request`／`llm.response` と `request_id` で結べる（タイミング段の `request_id` は `<生成段の id>_timing`）。

## 6. 暫定の値（どれも未検証）

- `recent_context`: `max_turns` 6、`max_chars_per_turn` 300（長いターンは後ろを残す）。根拠なし。
- `max_requests_per_session`（200）はタイミング段の呼び出しも数える。
- 起動の条件（`trigger` 24／12）と鮮度の上限は既存の値のまま（方式で変えない）。
- 実 API の遅延（`gemini-3.5-flash-lite`、`minimal`、手書きの短い素材の直列の実行、合計 36 回の呼び出しのうち判定 18 組）: 生成段 p50 1280ms、p95 1748ms（n=18）、タイミング段 p50 1187ms、p95 1883ms（n=18）。これは素材と環境を選んだ動作確認の値で、実音声の値ではない。

- `cue_reaction_window_ms`: 2000。根拠なしの観測窓。
- `revise_min_utterance_similarity`: 0.8。手書きの例（小さな言い換え 0.83／0.90、言い換え 0.63／0.64、別内容 0〜0.4）で置いた暫定値。
- `already_said_min_similarity`: 0.8（`revise_min_utterance_similarity` と別の項目）。発話の直前のガード、発話の後の照合、同内容の NEW の棄却の基準。手書きの例で置いた暫定値（§9）。未校正。
- `reflection_min_containment`: 0.5。反映の推定（内容の字を含む文字 2-gram の包含率）の基準。推定の記録にだけ使う暫定値。未校正。

## 7. 発声の失敗からの復帰

候補の発声が失敗しても、無理に声を出さず、聞き手の状態に戻す。

| 起きたこと | 状態 | アバター | 次 |
|---|---|---|---|
| 候補の音声が吸気・保持中に間に合わない | `audio_unavailable` で撤回、音声を破棄 | `breath.release(withdrawn)` | 許可があれば通常応答が既存の経路で始まる |
| `DEFERRED` で音声の生成に失敗 | 同上（`audio_abandoned`） | 同上 | 同上 |
| 再生の開始前に失敗、または 1 音も出ずに終わった（`speech_failed`／`speech_no_audio`） | 撤回。`SPEAKING` に残さない。TurnManager の開始の確認待ちはセッションが解く | 発話の開始で合図は閉じている | 人が待っていれば、その発話の文を `asr_result` へ戻して通常応答の準備を起こす（`normal_response_recovery`） |
| 一部を再生した後の失敗 | 撤回。履歴には実際に話した部分だけ | 同上 | 通常応答へ戻さない（`no_recovery`、`partly_spoken`）。話した続きを別の文で言い直すと不自然なため |
| 復帰の時点で人が話し始めた、新しい発話がある | 撤回 | 同上 | 戻さない（`no_recovery` に理由） |

候補の発声は再試行しない。原因は `candidate.state_changed` と `negotiation.decision`（`stage: candidate_audio`）に残す。Node からブラウザへのメッセージの形は変えていない。

## 8. 限界

- 自然な実音声での確認はこれから（利用者の方針）。手書きの素材と台本の LLM は妥当性の根拠にならない。
- タイミング段は生成段の後なので、希望の発生から `OFFER_NOW` までの遅れは2回の呼び出しの合計になる（実測は上記）。生成段と並列にする最適化はしていない。
- `active_candidate_exists` のとき E2a は新しい `NEW` を棄却する。2つ目の希望は `initiative.desire` の `rejected` として残るだけで、キューにはしない。
- タイミング段は最新の活動中の候補を1件だけ判定する（`max_active_candidates` が 1 の前提）。
- 反映の推定と「すでに話した内容」の照合は文字の一致なので、言い換えられた内容は「話した」にならない（§9）。候補が残り続けることがある（期限か生成段の撤回で消える）。
- 撤回の分類、`REVISE` の抑制の基準、合図の反応の窓はどれも未検証の暫定値。

## 9. 通常応答の材料の反映の確認と、重複発言の防止

利用者の方針: WAIT 候補の通常応答への反映は必須にしない。通常応答を遅延させず、間に合った候補だけを必要に応じて参照する。渡したか、実際の応答に反映されたかは確認できるようにする。すでに AI が発言した内容や、後続の会話で不要になった希望が残って重複発言につながらないようにする。発話希望の判定の妥当性は、実会話を通じて研究側で評価する（ここのコードは確かめない）。

**反映の確認（コード）。** 渡した事実は従来の `initiative.response_material`。通常応答の発話の終わりに `initiative.response_reflection` を1件出し、**実際に話した部分だけ**と渡した候補を比べた結果を残す。

- `spoken_outcome`: `spoken`（最後まで）、`partly_spoken`（割り込みで途中まで。話した部分だけで判定）、`not_spoken`（準備のまま取り消し、1 音も出なかった。比較しない）。材料を渡した準備が話されないまま取り消されたときも `not_spoken` で残す。
- `estimated_reflected` と `estimate`: 材料の文字 2-gram が話した文に含まれる割合（`containment`）と基準（`reflection_min_containment`）。ひらがなだけの 2-gram（です、ます、ください）は内容を示さないので、内容の字（漢字、カタカナ、英数字）を含む 2-gram を数える（`basis`。3 個未満なら全部の 2-gram）。コサインは参考の値（応答の長さで下がるので判定に使わない）。**推定で確定ではない**（言い換えは拾わない、同じ語を別の意味で使っても一致する）。
- 計算は発話の後の同期のコードで、応答の開始や準備を待たせない。LLM の自己申告は足していない（足すなら LLM 生成の別の項目にする）。
- 評価画面 `tools/initiative_review/` の判定の詳細に「渡した版、実際に話した文、推定の一致」を出す。

**重複発言の防止（層ごと）。**

| 層 | いつ | 何を比べるか | 記録 |
|---|---|---|---|
| 発話の直前のガード（コード） | 候補を話すと選んだ直後（`NegotiationWiring.select`）。**話す前の比較だけ**で通常応答を待たせない | 候補の文と、履歴の AI の発話（実際に話した部分）を、発話全体と文ごとの大きい方で文字 2-gram のコサイン。基準は `already_said_min_similarity` | 撤回の原因 `already_said`（`candidate.state_changed`）、`initiative.already_said`（`stage: before_speech`）、`negotiation.decision` の `already_said:similarity=…` |
| AI の発話の後の照合（コード） | AI の発話の終わり（通常応答でも候補でも、履歴へ確定した後） | 保留中の候補（SPEAKING 以外）と、**この発話で話した部分** | 撤回の原因 `already_said`、`initiative.already_said`（`stage: after_ai_speech`、`matched_origin`） |
| 同じ内容の新しい希望（NEW）（コード） | 生成段の結果を適用する前 | 提案の文と、履歴の AI の発話 | `initiative.desire` の `gate.reasons: already_said`、`already_said_comparison`、`outcome: gate_rejected`。E2a に渡さない |
| 後続の会話で不要になったもの（モデル、根拠はコード） | 生成段の `WITHDRAW` | 撤回の根拠は人の発話か、**生成段に見せた直近の会話の AI の発話**の逐語。どちらで確かめたかを `withdraw_evidence_source`（`user_utterance`／`ai_utterance`）に残す。AI の発話のときは E2a も照合し直す | `initiative.desire`、`candidate.state_changed` の `withdraw_evidence_source`。判定の条件の中身は変えず、`initiative-desire-ja-v3` で根拠の範囲の説明と分類 `already_said` だけを足した |
| 候補を話した後 | — | SPOKEN は終端で再開できない（再試行しない）。同じ文の再 NEW は上の NEW の棄却が受ける | 試験で固定 |

撤回の扱いはどの層も既存どおり（音声の破棄、合図中なら `breath.release(withdrawn)`）。WAIT の判断や `question_resolved` などの内容の撤回とは別の値で記録する。

**同内容の NEW の棄却は「AI がすでに話した内容」に限る。** 前の候補を撤回しただけで話していない内容は棄却しない（人の発話で状況が変わった場合を潰さない）。割り込みで途中までしか話していない内容も、話した部分との類似度が基準に届かない限り棄却しない。

**持ち越しの候補への `KEEP`。** 持ち越しの候補への `KEEP` は、AI の発話の開始をまたいでも `stale_segment` で棄却せず適用する（既知の問題の修正。`applyModelDecision`）。候補を変えないので安全で、判定の鮮度（`last_request_id`）が古いままにならない。

限界: どれも文字の一致で、言い換えは同じ内容として数えない。基準は手書きの例による暫定値で未校正。候補の文が短い（定型の短文）と、一致しやすい。発話の直前のガードと NEW の棄却はセッションの全部の AI の発話を見る（期間で切っていない）。これらの正しさは実会話で研究側が評価する。

## 10. 吸気の後の短い声（別モード）

研究の中心は声より前の身体の動きによる発話希望の表出なので、短い声は**別モード**にする。既定は `none`（無音の吸気のみ）で、`none` のときは配線自体を作らず、これまでの動作は変わらない。

| 設定 | 値 | 既定 |
|---|---|---|
| URL | `?vocal_cue=none\|pre_beginning\|backchannel` | — |
| 環境変数 | `VOCAL_CUE`（不正な値は `none`）、`VOCAL_CUE_FROM_CLIENT`（0 で URL を無視） | `none`、1 |
| 効く条件 | `initiative_inhale` のみ。他の条件は `none` として manifest の `vocal_cue_reason` に理由を残す | — |

**いつ鳴らすか。** 候補が `DEFERRED`（吸気の後も人が話し続けた）の間で、まだ発話の許可が出ていない短い切れ目。1 候補につき最大 1 回。AI の発話中と人の発話の継続中は鳴らさない。招待と直接の質問（通常応答が先）も鳴らさない。判定は `control/vocal_cue.ts` の純粋な関数。

| 種類 | 語 | 意味 | その後 |
|---|---|---|---|
| `pre_beginning` | 「あ、」（`pre_beginning_phrase` で「あの、」に切り替え） | 話し出しの声。発言の機会を提示する | 人が譲れば既存の許可の経路で候補を話す。話し続ければそこで止まり、延期のまま |
| `backchannel` | 「うん」のみ | 相づち。発言権を取りに行かない | 候補は延期のまま |

**音声の経路。** 語は事前に合成する（候補の先読みと同じ。空きの文脈があるときだけ作り、足りないときは先に捨てる。通常応答と候補の開始を遅らせない）。再生は通常の AI 発話と同じ経路で、VAP の AI チャネル、エコー判定、`turn.outcome`（`origin: vocal_cue`）の対象になる。人が話し始めたら既存の割り込みで止まる。

**履歴に入れない。** 語は会話の内容ではなく LLM の文脈を汚さないため、`conversation history` に入れず、`already_said` の照合にも使わない。`lastAiEnd` も更新しない（続く候補の発話が `spoke_twice` にならないように）。ただし `after_ai_speech.rebase_user_end_times` は他の AI の発話と同じく働く。

**暫定値（未校正）。** `config/policy.ja.json` の `initiative.negotiation.vocal_cue`。

| 項目 | 値 | 根拠 |
|---|---|---|
| `min_user_silence_ms` | 300 | 手で置いた暫定値。実会話で未校正 |
| `min_asr_quiet_ms` | 200 | 同上 |
| `max_vad_user` | 0.5 | 同上。3 つの閾値のどれかが `null`（未校正）なら声のモードは動かず、理由を manifest に残す |
| `observation_window_ms` | 2000 | 観測の窓の長さ。判定には使わない |

**分けて分析するための記録。** manifest の `initiative.vocal_cue`、`vocal_cue_requested`、`vocal_cue_source`、`vocal_cue_reason`。イベント `initiative.vocal_cue`（種類、語、候補、合図、切れ目の値、音声の開始と終了、その後の窓の間の観測）。人が譲ったかどうかは**断定せず**、観測の値（音声の終わりで話していたか、再開までの時間、窓の間に候補が話し始めたか）だけを残す。評価画面の「吸気の後の結末」に表示し、研究条件とは別に絞り込める。

**限界。**
- VAP が新しくないとき（劣化モード）は鳴らさない。VAP の助走（`vap_rewarm_ms` = 10 秒）の間もこれに当たるので、会話の開始から約 10 秒は声が鳴らない。
- 声の後は `rebase_user_end_times` で切れ目が測り直されるので、候補の発話の許可は声の長さと最小の間（約 900ms）の分だけ遅れる。
- 声の再生中に候補が撤回されても、声は止めない（短いので最後まで鳴る）。
- 声が ASR に拾われる（エコー）と、人の発話として扱われうる。エコー判定に任せており、実機では未確認。
- 実際の TTS での短い語の音質、抑揚は未確認（台本の TTS でしか通していない）。
- 声の間の視線と体の動きは既存の AI 発話の扱いのまま。声に合わせた調整はしていない。
- 上の暫定値はすべて未校正。妥当性は実会話で研究側が評価する。

## 11. 申し出の状況を生成段へ渡す

利用者の方針: OFFER の後の人の反応を踏まえて、AI が維持、内容の更新、撤回を判断できるようにする。渡すのは観測した事実だけで、コードは意思を推定しない。

**何を渡すか（`OfferView`、コードの値）。** 生成段に見せる未解決の希望ごとに、次を `PromptCandidate.offer` として渡す。

| 項目 | 値 | 意味 |
|---|---|---|
| `presentation` | `presented` | ブラウザが吸気を描いたと報告した（`signal.report`、`visible: true`） |
| | `sent_unconfirmed` | 送れたが、描いた報告がまだない |
| | `not_presented` | 送っていない、送れなかった、描かれなかった（背景タブ、アバターが受け付けなかった） |
| `elapsed_s` | 秒 | 描かれた時刻（未報告は送った時刻）から、判定を送った時点まで。`not_presented` は null と理由 |
| `follow_up` | `kept_talking`／`stopped`／`invited`／`unknown` | 合図の後の直近の tick の観測（`TurnManager` の `user_speaking` と招待の検出）。`stopped` は「今話していない」で、話し終えたという意味ではない |
| `cue_id` | | `negotiation.cue_reaction` と結ぶ ID |

`initiative_no_cue` と `reactive` は条件の名前で分岐せず、合図を送らないから `not_presented` になる（`OfferObservations`、入口は `NegotiationWiring` の送信と報告の経路だけ）。候補の状態も読まない（送信に失敗しても `BREATH_INHALE` へは進むため）。`invited` は合図の後に現れた招待だけで、合図より前からある招待は数えない。AI の発話中の人の声は振る舞いに数えない。`negotiation.cue_reaction`（窓つきの測定）とは別に持つ（窓の後の判定にも渡すため）。

**プロンプト（`initiative-desire-ja-v4`、`config/policy.ja.json` の既定）。** 未解決の希望の行に `／申し出: …` を足し、読み方の節だけを足した。NEW の説明と判定の条件は v3 と同じ（試験で固定）。古い版は選べて、申し出の状況を載せない。**話し続けることは拒否でも関心のなさでもない**（人は合図を見ていないかもしれず、応える義務もない）、KEEP／REVISE／WITHDRAW は人が実際に話した内容に基づく、振る舞いだけを理由に REVISE や WITHDRAW を選ばない、と書いている。回数を増やす、または減らす言い回しは入れていない。

**タイミング段には渡さない（版は `initiative-timing-ja-v2` のまま）。** タイミング段の判定が効くのは `INTENT_READY` の候補（合図の前）だけで（`signalGate`、`selectSpeech`）、合図の後の候補は `INTENT_READY` に戻らない（`REVISE` は再吸気しない）。合図の後の状況を見せても、使われる先がない。

**ゲート。** `WITHDRAW` は今までどおり発話の逐語の根拠が要る。申し出の欄の文は発話の区間にないので根拠にできない（試験で固定）。`REVISE` の根拠の照合も変えていない。コードは振る舞いを読まず、振る舞いだけを理由にした `REVISE` を機械的には弾けない（根拠の語がある限り通る）。そこはプロンプトの規則に頼っており、実際に守られるかは未確認。

**再判定は足さない（決定）。** 振る舞いだけが変わって新しい文字がないときは起動しない（`InitiativeMonitor` は増分でだけ起動する。`shouldRun` は新規の安定文字が 0 なら走らない）。理由:

- 振る舞いだけでは内容の判定を変えない方針なので、文字が同じなら再判定で正しく出せるのは `KEEP` だけで、候補も結果も変わらない。
- 合図の後に話し止んだ場合、話せるかは `TurnManager` の許可が決める（最小の間 `min_gap_ms` 900ms）。生成段とタイミング段の2回の呼び出し（手書きの素材で p50 およそ 1.3 秒と 1.2 秒）はその後に届くので、話し止みの直後の判断には間に合わない。
- 残りの文字は `stt.final` で判定が走り（`boundaryPending`）、そのときの最新の状況が渡る。呼び出しの回数（`max_requests_per_session`）を振る舞いの変化で使わない。

実行中の要求の後に状況が変わった場合、その判定は古い状況を見たままになる。何を見たかは次の記録で分かる。

**記録。** `initiative.desire` の `offer_views` に、その判定のプロンプトに載せた値（候補ごと、送った時点）を残す。載せない版は `value: null` と `prompt_version_does_not_show_offer`、古いログには項目がない。

**限界。** `stopped` は tick の瞬間の値で、話の途中の短い間でも `stopped` になる（平滑化の基準は足していない）。`presented` はブラウザが描いた報告で、人が見たかは分からない。モデルがこの欄をどう使うかは実 LLM で確かめていない。
