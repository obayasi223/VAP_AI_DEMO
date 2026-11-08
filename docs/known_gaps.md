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

## 5. 契約にあるが、まだ置き換えていない項目

`clock.report`、`audio.report` の任意4項目、`TrackSettings.latency`、`prefetch.started.trigger`、`prefetch.cancelled.discarded_*` は波1bで発行するようになった（E2E で確認）。残りは次の1つ。

| 項目 | 場所 | 状態 |
|---|---|---|
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
| p の向き | `p_ai = p[1]`（`policy.ja.json` の `direction_status` は `measured`）。変換は `control/vap_direction.ts` の1か所 | R2 の実測で「添字 i はチャネル i の話者」。AI を ch2（sys）に置く配線は E2E で確認（AI の再生中に `vad[1]` が上がる） |
| 視線の設定 | `policy.ja.json` の `gaze` が null の間は逸らさない | 原著に数値がない。null を別の値へ置き換えない。**値が入るまで視線は動かない** |
| 視線の判定の向き | `p_ai < p_threshold` のポーズで逸らす | V-D。閾値ちょうどは逸らさない。同じポーズの中では向きを保つ（原著にない、行き来を防ぐため） |
| 視線の保持時間（**原著にない追加**） | ja は `gaze.hold_away_min_ms`=600、`gaze.re_avert_min_ms`=1000【暫定、根拠なし、未校正】。hri2025 は保持なし（方策に項目がなく、`controlSettings` で null、原著どおり）。`control/gaze.ts` の `applyHold` | E2E で、200ms のポーズで逸らした 70〜180ms 後に AI が話し続けて user へ戻る短い逸らしが複数出た（目がちらつく）。規則: 逸らした後 600ms までは user へ戻さない。**ただし人が話している（`user_speaking`）、割り込み中、AI の発話の終わり、VAP の鮮度切れのときは保持より優先して直ちに戻す**（相手の発話や受け渡しへの反応を遅らせない。理由は `user_speaking:…` のように頭に付けて残す）。戻した後 1000ms までは再び逸らさない（例外なし。そのポーズの最初の判定は `re_avert_min_ms<1000:…` の理由で残す）。保持中に AI が話し続けると、ポーズが終わってもしばらく逸れたまま。値の妥当性は人の評価で見ていない |
| 発話開始前に視線を逸らす動作 | 入れない | 根拠が Fig. 1 の読み取りのみ。V-D に記述がなく、IV-B はベースラインの説明 |
| 鮮度切れの定義 | `audio_frame` の遅れ（計画）に加えて受信時刻の遅れも見る | 音声そのものが止まると frame の差が開かず、古い p を fresh と扱うため |
| hri2025 の鮮度と助走 | ja と同じ 500ms と 10 秒をコードで持つ | 方策に項目がなく、原著にもない。原著再現の根拠にしない |
| 復帰時の計時 | fresh に戻ったら L57 と L71 の時計を現在時刻にする | VAP がなかった間の値で L74 が即時に真になるのを防ぐ。原著にない |
| degraded 中の開始と割り込み | `fallback_silence_max_ms`、`fallback_interrupt_min_words`、`fallback_energy_silence_dbfs` のどれかが null なら、招待以外で開始せず、割り込みもしない。ja は §8 の暫定値と §12 の安全側の判断（`turn.vap_unavailable`）で有効 | `fallback_energy` は mic の RMS（dBFS、session が計算）。閾値は方策の `turn.fallback_energy_silence_dbfs` を session が `createTurnManager` へ渡す。値は未校正 |
| 再生を始められないとき | `TurnInputs.start_blocked_reason`（切断中、別の音声がまだ終わっていない）がある間は L78 を偽にし、segment を進めない。両方の方策 | 原著の `is_ready` に「出力できる」を含めた解釈。入力で止められなかった拒否は session が前進を取り消す（`start_rolled_back`） |
| `set_degraded` の出し直し | degraded のまま理由の種類（down／warming_up／stale）が変わったときも出す | 画面の「助走中」と、助走後の down を正しく出すため。原著にない |
| 境界の後に届いた旧い発話の書き直し | final の語時刻が本文と合えば、境界より前に終わった語を旧 segment へ。なければ境界より前の revision の長さまでを旧 segment とし、伸びた分だけを新 segment へ（`providers/stt/assembler.ts`） | 共通接頭部で分けると、書き直された語尾が新しい利用者発話になり、AI の発話の後に2回目の応答が出る。語時刻のない interim では近似で、境界の直前の語尾が遅れて認識されると新 segment に入りうる。TurnManager（Appendix A）は変えていない |
| ブラウザの再生の報告の期限 | 開始 3000ms、停止は猶予＋2000ms、再接続後は残りの長さ＋3000ms【暫定】。接続中だけ数え、過ぎたら終わりを代行（`speech_generator.ts` の `REPORT_TIMEOUTS_MS`） | 方策に項目がない。切断では代行せず、再接続後のブラウザの報告を正とする |
| `start_speech` 後の待ち | 再生の報告を 1000ms 待つ【暫定】（`START_ACK_TIMEOUT_MS`） | 方策に項目がない。報告が遅いと重ならないが、それ以上遅れると U-1 の防止が切れる |
| 準備の喪失 | ja のみ、準備が再生に入らず消えたら同じ文で1回だけ再試行 | L45 が偽のままになり、応答が永久に準備されないため。`hri2025_mapping.md` にない追加 |
| AI の発話が自然に終わった後の相槌 | ja は AI の発話中に始まり話し終えた時点で止んでいる短い断片（4 文字以下か相槌の語句だけ）に応答しない（§10）。hri2025 は発話中の「うん」も次の入力として準備し、許可が出れば応答する | U-2 は割り込み後の再開だけを決めている。ja の規則は原著にない。AI の発話の後に来た相槌（AI が黙ってから言った「はい、そうですね」）には今も応答する |
| 招待の語句 | 文末固定の自作の表（`control/invitation.ts`）。hri2025 では記録のみ | 誤検出率は未測定。句読点を根拠にしないので、上昇調でしか分からない質問は取らない。再開の待ちは Jarvis の 400ms でなく `MIN_GAP_TIME` |
| `YIELD_TIMEOUTS` の尺度 | ja でも TurnGPT の表をそのまま使う | 推定器ごとの表は `prepare_threshold` しかない。`ja_rules_v1` の p は別の尺度で、L74 の意味は原著と同じでない |
| `final_transcript` の起動 | 使わない | Appendix A にない。final でも L46 の条件を待つ（最大 200ms 遅れる） |
| WoZ の入力 | `inputs.woz` を読まない | E3 の範囲。**J が渡しても効かない** |

## 8. 統括が入れた暫定の値（波1の配線のため。根拠なし、未校正）

`config/policy.ja.json`:

- `gaze`: `signal=p_now`、`p_threshold=0.5`、`pause_min_ms=200`。null のままだと視線が動かないため。人の評価も実対話での確認もしていない。`hold_away_min_ms=600`、`re_avert_min_ms=1000` は短い逸らしのちらつきを防ぐための保持時間（§7、原著にない）。
- `turn.fallback_silence_max_ms=1500`、`turn.fallback_interrupt_min_words=3`、`turn.fallback_energy_silence_dbfs=-45`。VAP の鮮度切れのときの代替（計画 §4.1 の表）。null のままだと MaAI が落ちたとき AI は割り込まれても止まらず、待機中は招待以外で話し始めない。-45 dBFS は有線ヘッドセットの近接マイクを想定した値で、実機の雑音の大きさは測っていない。語数は `Intl.Segmenter` の語で数え、「うん」「はい」（1語）の相槌では止めない。
- `similarity.threshold=0.9`。null だと実 ASR ログの再生で 376 秒に 669 回の準備になった（同じ文の連続読み上げで、人の会話の頻度ではない）。0.9 では 7 回。比較する文が累積なので、長い発話の末尾が応答に届かない危険がある。校正のときに確かめる。


## 9. 発話希望（G と E2a）の規則と残した差（波2）

実装は `apps/orchestrator/src/cognition/initiative/`（G）と `apps/orchestrator/src/control/candidates/`（E2a）。値はどれも【未検証の暫定値】。

| 項目 | 規則 | 理由、残る問題 |
|---|---|---|
| 話の後に届いた `NEW` | 人の `user_speaking` 偽が `post_turn_silence_ms`（J は MIN_GAP_TIME を渡す）続いた後に届いた `NEW` は、候補にせず E2a が保留する（`candidate.rejected` の `post_turn_new_held`、G の `initiative.discarded` に写し）。**保留中に人が話を再開したら、その間は話の途中だったとみなし、保留を棄てずに `promoteHeld` で根拠（最新の安定テキスト）と順序（segment、`transcript_revision`）を照合し直して候補にする**（G が採番の後に `initiative.decision` の `NEW` を出す。`decided_at` は候補にした時刻、`received_at` は応答を受けた時刻）。照合に通らなければ棄てて `candidate.rejected` に理由を残す（`details` の先頭が `promote`）。**人が再開しないまま通常の応答が始まったら棄てる**（`held_dropped:normal_response_started`）。segment の変更、新しい `NEW`、期限、根拠の消失でも棄てる | 「話の後」を無音の長さだけで決めているので、話の途中の長い間に届いた `NEW` も保留に入る。人が続けたことが「途中だった」の唯一の手がかり。保留から候補にするときに鮮度（`max_result_age_ms`、新規の安定文字数）は見直さない。間が長いほど古い判定が候補になりうる。E3 の調停は未実装 |
| 判定の入力の範囲 | LLM に渡すのは今の segment（AI が最後に話し始めた後の利用者の発話）の安定テキストだけ。前のターン（利用者と AI の両方）は渡さない（`transcript_view.ts` の `snapshot`）。長い話は古い区間から落とすが、未解決の候補の根拠の区間は落とさない | 意図どおり。根拠の照合は今の segment の中だけで行い、前のターンの語は根拠にならない。そのため「さっき言ったことと矛盾する」のような前のターンに跨る申し出は出せない。persona の役割と関心は system 側で渡している |
| 起動とターンの終わり | 新規の安定文字が `trigger.min_new_stable_chars` 以上、文中の区切りの後に `min_new_chars_at_boundary` 以上、または **final を受けたとき（増分が1文字以上なら文字数によらず1回）**。リプレイの `finishInput` も入力の終わりを final とみなす同じ規則 | final を文字数で止めると、ターンの終わりの判定（撤回の機会）が抜けていた。Google は話の途中の間にも final を打つので、その分の要求は増える |
| 判定の失敗の後 | 失敗した要求の入力は判定済みにしない。待ち（2秒から倍、上限30秒）が明けたら、新しい増分がなくても J の tick（`poll`）で同じ入力から判定し直す | 失敗した入力が判定済みになると、話が止まった後は二度と判定されなかった |
| 撤回の根拠の位置 | 候補の根拠が入力に見つからなければ、撤回の根拠が後ろかを確かめられないので撤回を棄却する（`candidate_evidence_not_in_input`） | 入力の上限で落ちた区間の候補を、前の発話で撤回させないため |
| 区間（`segment_id`）をまたいで届いた判定 | `segment_id` は TurnManager が AI の発話を開始する tick（L80）でだけ進む。つまり「区間が変わった」は「AI が話し始めた」と同じ。LLM の往復（実測の中央値 1.3 秒、§11 の遅延の表）の間に区間が変わるのは普通に起きる。**区間が変わっただけでは捨てない:** `NONE` は記録するだけで `candidate.rejected` に数えない（`initiative.decision` の `NONE` になる）。`NEW`／`REVISE`／`KEEP` は、入力の後に AI が話し始めていれば棄却し、`candidate.rejected` の `reason=stale_segment` の `details` の先頭に `ai_started_speaking`（と区間、開始の時刻）を残す。**NEW** はこの条件で棄却するので、実セッションでは区間をまたいだ NEW は候補にならない（§4.6「通常応答を話し始めたら残っている候補は撤回」と同じ扱い）。区間が判定の側で進んだだけの経路（リプレイ）は、根拠の照合と新規の安定文字数（`max_new_stable_chars_since_input` を区間をまたいで数え直す。`details` の先頭が `too_many_new_stable_chars`）を見て受理する。経過時間（`max_result_age_ms`）は G のゲートが先に見る（`stale_result_too_old`）。`WITHDRAW` は候補を減らすだけなので区間をまたいでも適用する（ただし AI の開始で候補はすでに撤回されていることが多く、その場合は `state_not_applicable`）。順序（`transcript_revision`）の検査は `NEW`／`KEEP`／`REVISE`／`WITHDRAW` に残す | `s20261108T045055-ca6e12` の破棄 4 件は全部 `NONE` で、3 件は `stt.final` の到着が AI の発話開始より 0.4〜0.9 秒遅く、要求を送った時点で AI はもう話していた。1 件は interim で送った要求が往復の間に追い越された。`NONE` が棄却に数えられていたのは計測の誤りとして直した。残る問題: AI の開始の後に届く final の判定は LLM の呼び出しの無駄（G の側で起動を止められるが、この節の作業では `cognition/initiative/` を変えていない）。`candidate_expires_on_segment_change` が `false` のときだけ KEEP／REVISE が届く |
| 保留中の希望の更新（二段判定） | 生成段が増分ごとに内容を再評価（`KEEP`／`REVISE`／`WITHDRAW`）。撤回には分類 `withdraw_kind` が必須。`REVISE` は内容が実質同じなら維持として扱う（`revise_suppressed`）。タイミング段は `OFFER_NOW`／`WAIT_FOR_TURN_END` だけで、撤回しない。`docs/initiative_v3_design.md` §1 | 分類と抑制の基準（`revise_min_utterance_similarity` 0.8）は未検証の暫定値 |
| プロバイダの状態の名前 | 判定用の Gemini は `provider.status` を `gemini:initiative` で出す（応答用は `gemini`）。要求の上限の報告は `initiative_monitor` の行。`cost.usage` と `llm.*` の `provider` は両方とも `gemini` のままで、用途は `purpose`（`initiative`）で分ける | 研究者画面の行は provider 名で引くので、同じ名前だと取り違える。`packages/analysis` の単価の照合は `provider` で引くので `cost.usage` の名前は変えない |

## 10. 実機の対話で見つかった開始の早さ（ja、原著にない追加）

2026-11-08 の実機の対話（有線ヘッドセット、Windows の Chrome、`sessions/s20261108T045055-ca6e12`）で「だいぶ割り込まれる」と報告された。同じ日の1つ目のセッション（`s20261108T044950-631c07`）はヘッドセットを使っておらず、AI の声がマイクに入って自分の声に応答していた。仕様の前提（ヘッドセット）から外れるので、**1つ目は評価にも試験の素材にも使っていない**（エコーの抑制は入れていない）。

**ログで確かめたこと（2つ目のセッション）:**

- 開始の大半が利用者の声の終わり（`vad[0]` < 0.5）から 0.6〜0.7 秒で、`gap_ms` ≈ 503ms の L74（`ja_rules_v1` の p 0.65〜0.85 で待ちは 500ms）か L67。`ja_rules_v1` は話の途中の言い切り（「〜ですね」「〜しています」）にも 0.65〜0.75 を返すので、L74 が実質 500ms の固定の待ちになっている。
- 50.26s の開始（L74、p_now_ai 0.66）は、利用者の声の終わりから 0.57 秒。開始の 0.15 秒後に利用者が「で」と続けた（`vad[0]` 1.0、AI の声は ch2 だけで ch1 に入っていない）。利用者の話の途中での開始。
- 18.50s にも、「そうですね」の後 0.5 秒で L74（p_now_ai 0.06）の許可が出て、0.16 秒後に利用者が続けた。準備が間に合わず開始しなかっただけ。
- 33.0s の開始（統括の分析で途中とされた）は、直後の final が同じ文の確定で、新しい文字も声もなかった。この指標（下）では途中に数えていない。
- 58.08s の2回目の発話: AI の発話中に利用者が「で」と言い（`segment_id` 3）、AI の発話の終わり（57.40s）で U-2 の抑止が解けて「で。」を準備し、L74（利用者の最後の声から 7 秒、p=0.1 で待ちは 2000ms）がすでに満ちていたので、準備ができた 0.65 秒後に話した。

**入れたもの（ja のみ。hri2025 は `controlSettings` で null、原著どおり）:** `config/policy.ja.json` の値はどれも【暫定、根拠は今回の1セッションのみ】。

| 項目 | 値 | 動作（`control/turn_manager.ts`） |
|---|---|---|
| `turn.start_guard.min_gap_ms` | 900 | L67、L74、招待のどの経路でも、利用者の発話の終わりから 900ms 未満では許可しない（`MIN_GAP_TIME_MS` と大きい方） |
| `turn.start_guard.completion_timeout_min_p_ai` | 0.5 | L74 で許可するとき、`p_now_ai` がこれ未満（VAP が AI 側を支持しない）なら次の待ちを要求する |
| `turn.start_guard.completion_timeout_low_p_min_ms` | 1500 | 上の場合の L74 の最小の待ち。原著の表の待ちが長ければそちら（p=0.1 は 2000ms のまま） |
| `turn.after_ai_speech.rebase_user_end_times` | true | AI の発話が終わった tick（`playing`／`stopping` から無音）で `user_speak_end_time` と `user_turn_end_time` を終わりの時刻へ数え直す。AI が話し終えた直後に続けて話さない |
| `turn.after_ai_speech.fragment_max_chars` | 4 | AI の発話中に始まり、AI が自然に話し終えた時点で止んでいる利用者の断片が、正規化後これ以下なら応答の準備をしない（`TurnState.ignored_fragment`）。そこから文が伸びたら通常どおり |
| `turn.after_ai_speech.backchannel_phrases` | 「うん」「はい」「そうですね」「なるほど」など 33 語 | 正規化後の全体がこの語句の繰り返しだけなら、文字数によらず同じ扱い |

- 延ばした待ちで許可したときは `turn.allowed.reason` に `start_guard:wait=1500ms` を足す。断片を外している間の許可には `ignored_ai_speech_fragment:short:chars=1` を足す。契約（イベントの項目）は変えていない。方策のスキーマは任意の項目の追加だけ。
- 断片は履歴（`SessionHistory`）には利用者の発話として残す。次の応答の文脈には入る。発話希望（InitiativeMonitor）への入力も変えていない。
- 割り込みで AI を止めた後（`stopping` から無音）は断片として外さない。人が発話権を取ろうとしたため。

**実ログの再生（`apps/orchestrator/test/control/replay_session_2.test.ts`）:** 変更前は Appendix A のままの ja、変更後は config の ja。「途中」は、開始（または許可）の後 1.5 秒以内に、開始より後の音声の新しい文字が ASR から来たもの。遅れは利用者の最後の `vad[0]` ≥ 0.5 から開始まで。

| 区間 | 実際 | 変更前の再生 | 変更後の再生 | 変更後の理由 |
|---|---|---|---|---|
| E1 挨拶と研究の紹介 | 11.13s（遅れ 650ms） | 11.12s（636ms） | 11.46s（976ms） | L67＋L74、最小の間 900ms |
| E2 研究の焦点 | 33.09s（687ms） | 33.09s（686ms）。途中の許可 1 回（18.50s） | 33.37s（966ms）。途中の許可 0 回 | L67＋L74、最小の間 900ms |
| E3 オンラインの利点 | 50.28s（598ms、**途中**） | 50.26s（568ms、**途中**） | 51.85s（939ms）。「で」の後 | L67 |
| E4 AI の発話中の「で」 | 58.08s（**連続の2回目**） | 58.06s（**連続の2回目**） | 開始なし（65 秒まで） | 断片を外した |
| E5 「はい、そうですね」 | 67.60s（715ms） | 67.59s（708ms） | 68.45s（1568ms） | L74、p_now_ai 0.31 なので 1500ms |

- 途中での開始: 変更前 1 件（E3）、変更後 0 件。途中に出た許可: 変更前 1 回（E2）、変更後 0 回。連続の2回目: 変更前 1 件、変更後 0 件。
- 正当な開始（E1、E2、E5。E3 は途中、E4 は連続のため除く）の遅れの中央値: 変更前 686ms、変更後 971ms（変更後は E3 を含む4件）。E5 のように VAP が AI 側を支持しないときは約 1.6 秒になる。
- hri2025 の再生は変更前のコードと同じ結果（試験で固定）。

**再生の限界:**

- 1セッション、5区間だけ。値を選んだのと同じ素材で評価しているので、過学習の評価になっている。別のセッションで確かめる必要がある。
- 実際の AI の発話の始まりより後は、VAP の ch2 に実際の AI の声が入っている。その後は p を直前の値で止め、`vad[0]` だけ実測を使った。変更後の E3 は「で」の後に始めたが、実際の利用者は AI の声を聞いて黙ったので、AI が黙っていたら続けたかは分からない。
- 準備（LLM と TTS）は呼ばず、実際に同じ revision で準備したときの遅れ（なければ中央値 706ms）で近似した。類似度は文がないので計算せず、実際に準備した revision でだけ準備させた。
- fixtures には利用者の発話文を置いていない（`fixtures/turn_replay/`。時刻、VAP の値、STT の結果ごとの正規化後の文字数、抜き出しのときに実際の文で求めた `ja_rules_v1` の p だけ）。抜き出しは `tools/turn_replay/extract_fixture.ts`。
- 最小の間を延ばしても、利用者が 0.9 秒より長く間を置いてから続ける話には効かない。VAP が AI 側を支持する（p_now_ai ≥ 0.5）ポーズでは L67 と L74 は 900ms で許可する（`docs/maai_validation.md`: ポーズでも `p_now[1]` が 0.5 を超える割合は `jp_kyoto` で 16%）。


## 11. 発話希望を振る舞いにつなぐ（E2 の合図のゲートと E3 の交渉、波3）

実装は `apps/orchestrator/src/control/negotiator.ts`（純粋関数）と `apps/orchestrator/src/session/negotiation_wiring.ts`（配線）。TurnManager（E1）は変えていない。値はどれも【未検証の暫定値】で、測ったものはない。

**条件ごとの動き**

| 条件 | 判定（G） | 候補の音声 | 吸気の合図 | 候補を話すか |
|---|---|---|---|---|
| `reactive`（通常応答、ベースライン） | 動く（ログと研究者画面だけ） | 作らない | 出さない（`negotiation.decision` に `condition:reactive`） | 話さない。通常の応答だけ |
| `initiative_no_cue`（吸気なし） | 動く | `proposed_utterance` をそのまま TTS | 出さない | `INTENT_READY` のまま、許可で話す |
| `initiative_inhale`（吸気あり、提案） | 動く | 同上 | ゲートを通れば `breath.cue`（吸気 `inhale_ms`） | 吸気の後（`BREATH_HOLD_OR_READY` か `DEFERRED`）、許可で話す |

**規則**

| 項目 | 規則 | 理由、残る問題 |
|---|---|---|
| 合図のゲート | 条件が `initiative_inhale`、活動中の候補が1つ、合図中でない、AI が話していない、アバターが使える、冷却時間（`signal_cooldown_ms`）を超えた（null は未校正として合図しない）、判定の入力の後の新しい安定文字が上限以下（入力が分からなければ合図しない。上限 null は `max_new_stable_chars_since_input` を使う）、判定からの経過が上限以下（null は `max_result_age_ms`）、候補の音声が用意できる（`preparing` か `ready`。作れない `none`／`failed` では合図しない）。止めた理由は全部 `negotiation.decision`（stage `signal_gate`）に残す（同じ理由の繰り返しは数字を除いた鍵で1回）。合図の理由に `candidate_audio_preparing`／`candidate_audio_ready` が残る | 音声の完成を待たず、NEW の次の tick で合図と TTS の準備を同時に始める（吸気の 700ms の間に作る）。吸気の後に間に合わないときの振る舞いは下の「音声が間に合わない」 |
| 音声が間に合わない（合図と TTS の同時開始の帰結） | 吸気の後の `BREATH_HOLD_OR_READY` で音声が `preparing` のあいだは `candidate_audio_wait:<cue_id>` で通常応答も含めて開始を保留し、許可が出ても選択は `wait`（理由 `candidate_audio_preparing`）。`hold_max_ms`（吸気の完了から 800ms）を過ぎても来なければ候補を撤回する（`candidate.state_changed` の `expired`、`negotiation.decision` の stage `candidate_audio`、outcome `audio_abandoned`、理由 `audio_not_ready_by_deadline:hold_ms=…`）。`breath.release` は `withdrawn`。人が話していて期限に達したら撤回せず既存の `DEFERRED`。音声の失敗（`failed`、`none`）は期限を待たず同じ撤回。撤回と改訂で準備中の音声を棄てるのは既存の E2a の `discardCandidate` | 吸気を見せた後に話さないことが起きうる（候補を話さない撤回 1 件）。期限 `hold_max_ms` は `DEFERRED` の暫定値を流用しており、音声待ちの値としては測っていない。全体の猶予は吸気 700ms ＋ 保持 800ms = 1.5 秒で、その間に TTS（現状の ElevenLabs の実測はこのログにない）が間に合わないと引き下がる |
| 吸気の長さと完了 | Node が `inhale_ms` を決めて `breath.cue` で送り、完了は Node の時計で判定する（ブラウザの報告は待たない）。`signal.sent` の `parameters.inhale_completion` は `orchestrator_clock` | 描画の遅れや背景タブで完了が遅れないため。`signal.started` は描画の rAF の時刻で別に残す |
| 吸気中の許可 | 吸気中は `start_blocked_reason`（`candidate_inhale_in_progress:<cue_id>`）で通常応答も含めて開始を止める。吸気を終えた tick で許可を見直して話す | 計画 §4.6 のとおり |
| `DEFERRED` | 吸気の後 `hold_max_ms` を過ぎても人が話していれば `DEFERRED` へ移り `breath.release`（`deferred`）。人が黙っていれば保持を続ける（許可か期限まで）。`DEFERRED` から再吸気しない | 人が黙っていて許可が出ないとき、Node 側の保持は期限（15 秒）まで続くが、アバターは自分の上限（`HOLD_MAX_MS`=1500）で自動で脱力する。見た目と状態がずれる |
| 候補と通常応答の選択 | 許可が出た tick で: 直前の発話が直接の質問（招待の種類 `direct_question`、または「ですか」「かな」「なんですか」「どう」で終わる）なら通常応答。そうでなく候補が話せる状態で、音声が準備済みで、判定が古くなければ候補（招待「どうぞ」なら原因 `invitation`、ほかは `turn_allowed`）。理由は `negotiation.decision`（stage `speech_selection`） | 計画の「応答または両者の統合」の統合はしていない（応答だけ）。直接の質問の判定は語尾の規則で、誤認しうる |
| 候補の話し方 | `proposed_utterance` をそのまま TTS に渡して話す。履歴には AI の発話（`origin: candidate`）として残る | 判定の時点の文なので、話す時点の文脈では不自然になりうる（言い換えはしていない）。直前の通常応答の準備は使わない |
| 撤回 | 通常応答を話し始めたら撤回（E2a）。ただし `initiative_inhale` で二段判定の `WAIT_FOR_TURN_END` の候補は撤回せず持ち越し、後続の会話で再評価する（`initiative.not_offered`、`docs/initiative_v3_design.md` §2）。期限 `candidate_expiry_ms` でも撤回。どちらも合図中なら `breath.release`（`withdrawn`）。未再生の PCM は E2a の `discardCandidate` が棄てる | 破棄は JSONL のイベントにしていない（`negotiation_wiring` の `discardedAudio` とプロバイダの取り消しだけ）。後から破棄を確かめるには `candidate.state_changed` と `speech.*` の欠けから推すしかない |
| `REVISE` | 再吸気しない。古い版の PCM は棄て、新しい版の文で音声を作り直す | 作り直しの間に許可が出ると、候補の音声がないので通常応答が勝つことがある |
| 二つ目の `NEW` | 活動中の候補があれば E2a が棄却（`active_candidate_exists`） | 波2のまま |

**話し終わりの後の `NEW`（§4.6 の表に照らして）:** 区間をまたぐ NEW は上の規則で棄却するので、話し終わりの後の候補ができるのは同じ区間の中だけ。無音が `post_turn_silence_ms`（`MIN_GAP_TIME_MS` 500ms）未満に届いた `NEW` は `INTENT_READY` になり、AI が話していなければ合図のゲートを通る（試験で固定）。吸気して（`candidate_inhale_in_progress` で通常応答も保留）、許可が出たら候補を話す。§4.6 の「吸気中に発話機会が来た場合」「招待のない自然な譲渡」のとおりで、negotiator の変更は要らない。無音が 500ms 以上の `NEW` は従来どおり保留（§9 の表）で、人が再開しなければ通常応答の開始で棄てる。`start_guard` の最小の間（900ms）との間は通常応答が先に始まれば捨てられる（E3 の調停は未実装のまま）。

**遅延の表（`npx tsx tools/latency_report/cli.ts <セッション>`、`packages/analysis/src/initiative_chain.ts`）:** `s20261108T045055-ca6e12`（`reactive`、判定 10 回: final 起動 4、interim 起動 6、n は段ごとに下）。値は 1 セッションだけの実測。

| 段 | n | 中央値 | 最大 | 備考 |
|---|---|---|---|---|
| 元の音声（起動の revision の `audio_frame_end`）→ ASR 結果の受信 | 10（final 4、interim 6） | 255ms（final 766ms、interim 242ms） | 952ms | `audio.health`（ブラウザ、`browser_rtt`）を基準点にした換算 |
| 文字が揃う → 安定（`stable_text` に入る） | 10 | 589ms（final 1193ms、interim 577ms） | 1470ms | Google の `stability` の経路。`stable_prefix_*` は使っていない |
| 受信 → 判定の送信 | 10 | 0ms | 1ms | STT の受信と同じ tick で起動 |
| 判定の送信 → LLM の応答 | 10 | 1294ms | 1524ms | 最初の本文の断片は 817ms（中央値） |
| LLM の応答 → 候補の記録 | 0 | - | - | NEW が 0 件 |
| 候補の記録 → 合図の送信 | 0 | - | - | 同上。`reactive` なので合図もない |
| 合図の送信 → 描画の開始 | 0 | - | - | 同上。`signal.started` がない |
| 候補の音声の準備 → 完成 | 0 | - | - | `reactive` は TTS を作らない。`negotiation.decision`（stage `candidate_audio`）で今後測れる |

`initiative_inhale`／`initiative_no_cue` の実セッションがまだないので、候補より後の段は未測定。このセッションでは判定の遅れの大部分は LLM の往復（1.3 秒）で、起動の条件（24 文字、区切りの 12 文字）を変えたときの効果はこの段からは分からない（測っていない）。

**暫定の値（`config/policy.ja.json`）**

- `initiative.candidate_expiry_ms`: null → 15000。`max_result_age_ms`（8 秒）の約2倍で、話の途中で出た候補をターンの終わりまで持たせる程度。測っていない。
- `initiative.signal_cooldown_ms`: null → 4000。吸気の連続を防ぐ。決めた時点の吸気 0.45 秒＋保持 1 秒に約 2 秒の間を足した程度（現在は吸気 0.7 秒＋保持 0.8 秒）。測っていない。
- `initiative.negotiation.inhale_ms`: 700。Torreira et al. 2015 の答えの前の吸気の中央値 0.72s（日本語ではない、`docs/breath_evidence.md`）に寄せた。このシステムでの計測はない。
- `initiative.negotiation.hold_max_ms`: 800。人が話し続けているときに引き下がるまでの時間で、根拠のない暫定値。アバターの `HOLD_MAX_MS`（1800）は解除が来ないときだけの安全上限で、人が黙って許可を待つ間は脱力させない。
- `initiative.negotiation.max_new_stable_chars_since_judgement` と `cue_max_judgement_age_ms`: null（G の鮮度の値をそのまま使う）。

**条件の選び方と、参加者に見せない運用**

- 開始画面に条件の選択（「通常応答（ベースライン）」「吸気あり（提案）」「吸気なし」）を置き、選んだ条件を WS の URL の `?condition=` で送る。初期値は URL の `?condition=`、なければ `NEXT_PUBLIC_DEFAULT_CONDITION`、なければ `reactive`。
- 本番の参加者実験では条件を参加者に見せないこと: web は `NEXT_PUBLIC_HIDE_CONDITION_PICKER=1`（選択を隠し、条件を送らない。表示名も出さない）、orchestrator は `CONDITION_FROM_CLIENT=0`（画面の求めを無視して `CONDITION` に固定）。今は既定で選択を見せている（予備体験用）。
- 研究者画面の設定の表示（`research.config` の condition）は起動時の `CONDITION` のままで、セッションごとの条件を映していない。JSONL の各行の `condition` と manifest はセッションの条件。

**persona**

- 既定の `PERSONA_FILE` を `config/persona.ja.conversation.json`（自由な会話の聞き手、`conversation_partner`）にした。暫定で、関心の項目は確かめていない。展示会の同僚は `PERSONA_FILE=config/persona.ja.json`。判定のプロンプト（`initiative-ja-v2`）の基準は変えていない。

**E2E の台本（`SCRIPTED_INITIATIVE=new_on_input`）**

- 台本の STT が interim をすべて安定テキストとして出し、判定の LLM が入力の最後の区間から根拠を抜き出した `NEW`（候補があれば `KEEP`）を返す（`app/scripted.ts`）。reactive のセッションの STT の台本は変えない。配線を通すためだけのもので、発話希望の判断ではない。既定は `none`。

## 12. VAP が使えない、信用できないときの開始と割り込み（ja、原著にない）

実装は `apps/orchestrator/src/control/turn_manager.ts` の `decideVapUnavailableStart` と `fallbackInterruptHold`、`control/vap_freshness.ts` の `VapTrustSettings`。ja の `turn.vap_unavailable` のときだけ動く。hri2025 は `controlSettings` で null で、判断も理由も変わらない（`test/control/vap_unavailable.test.ts` の末尾で固定）。値はどれも【暫定、根拠は実機の1セッションのみか、なし】。

**規則: VAP を信用できない間は、人の発話が確かに終わったと音声と ASR で言えるまで開始しない。** 次の全部を満たす tick でだけ許可する（どれか欠けたら `turn.allowed` の `reason` に `degraded:<縮退の理由>|<止めた理由>`）。

1. エネルギーが読める。`fallback_energy` があり、**受信済み音声の先頭が `vap_stale_ms` 以内に進んでいる**（上りが止まると session の `lastMicDbfs` は最後の値のままで、無音の根拠にならない）。止まっていた間は無音に数えない。
2. 応答の対象の文がある（`asr_result` が null でない）。文のない許可を出さない（発話候補も `permitted_to_speak` で話し始める）。
3. **今の segment で人の声を観測している**（VAP の `vad[0]`、または `fallback_energy` が閾値以上）。声の裏付けのない ASR の文に応答しない。
4. 声の無音: `fallback_last_voiced_at` から `vapUnavailableStartWaitMs`（`fallback_silence_max_ms`、`start_guard.min_gap_ms`、`start_guard.completion_timeout_low_p_min_ms` の最大。今は 1500ms）。招待は `start_guard` の最小の間（900ms）。VAP が AI を支持していないのと同じ扱いにする。
5. ASR の静止: 最後の更新が final なら `asr_quiet_after_final_ms`、final でなければ `asr_quiet_without_final_ms`。final の後に interim が来れば final でないに戻る。

割り込み（`fallbackInterruptHold`）は今までの条件（声のエネルギーと語数）に加えて、**ASR の更新が `interrupt_asr_recent_ms` 以内**（新しい内容がある）、**相槌だけでない**（`after_ai_speech` の語句）。止めなかったときは `reason` に `interrupt_held:asr_not_recent:…`、`interrupt_held:backchannel_only:…`。

信用できない入力として次も追加した（`assessVapFreshness` の第4引数、`VapFreshness` の種類は増やさず `stale` と理由で区別）: 値の異常（NaN、範囲外、受信より先の `audio_frame`、`invalid_vap_value:…`）、`vap.direction_status` が `provisional`（`direction_provisional`）。AI の音声の参照（`ai_reference_missing_ms`、再生中の sys の無音）は実装したが **config は null で検査していない**。session の試験の素材（`test/session/helpers.ts`）が再生中も `sys` を無音で送っており、値を入れると `L59` の試験が赤になるため。実機の sys は揃っている（下）。試験の素材を直してから値を入れる。

回復（`fresh`）では `applyFreshness` のとおり `user_speak_end_time` と `user_turn_end_time` を回復の時刻に数え直し、通常の分岐（L67、L74、`start_guard`）に戻る。縮退に戻ったら無音はそこから数え直す。

| 項目 | 値 | 根拠 |
|---|---|---|
| `turn.vap_unavailable.asr_quiet_after_final_ms` | 300 | 根拠なし。final の後の確定の余裕 |
| `turn.vap_unavailable.asr_quiet_without_final_ms` | 1200 | `s20261108T045055-ca6e12`: 1つの ASR 区間内の更新の間隔は p99 と最大が約 1000ms。それより長くした |
| `turn.vap_unavailable.interrupt_asr_recent_ms` | 1000 | 上と同じ分布。発話中の更新は 1000ms 以内に来る |
| `turn.vap_unavailable.ai_reference_missing_ms` | null | 未校正（上）。同セッションの AI の発話中の sys の無音（`vad[1]` < 0.5）の最長は 160ms |

実ログの再生（`test/control/replay_vap_outage.test.ts`、全区間でワーカーの停止として再生、エネルギーは `vad[0]` からの近似）: 変更前（`vap_unavailable` なし）と変更後で話の途中の開始はどちらも 0 件。開始までの遅れ（E3 は 1539→2299ms、E5 は 1568→1968ms、ASR の final を待ったため）。E1、E2 は変わらず。

**限界:**

- すべての条件はエネルギーの閾値（-45 dBFS）に依存し、閾値は未校正。**実機のログにマイクのエネルギーの連続した記録がない**（`turn.allowed` に `fallback_energy` の値が残るのは縮退中の判断のときだけで、既存の2セッションでは各1点、どちらも -40.8 dBFS。声か環境音かは不明で、閾値の -45 より大きい）。環境音が閾値を超える環境では、エネルギーが「声あり」のままで fallback の開始が永久に許可されない（助走の 10 秒は VAP の回復で解ける）。声の裏付けはこの場合に常に真になる。
- エコー（ヘッドセットなし）で AI の声がマイクに入ると、エネルギーと ASR の両方が「人の声」に見えるので、割り込みと開始の両方が誤る。エコーの抑制は作らない（利用者の判断）。
- 小さい声がエネルギーの閾値を下回る利用者では、声の裏付けがなく開始しない（VAP が回復すれば通常に戻る）。
- MaAI の `process_failed_reset` のあとは助走に戻す（session.ts の `onError`、`vap_worker_started_at` を更新）。ゼロ埋めの区間（`FRAMES_DROPPED`）の入力の窓にかかる VAP は値として使わない（session.ts の `overlapsZeroFill`、§14）。続けば鮮度が切れて `stale`（`arrival_lag`）になる。短ければ直前の値のまま fresh を保つ。区間の中の 20 秒の文脈に残るゼロの影響は見ていない。

## 13. 会話の音声の保存と同意（他者の音声はまだ保存しない）

`SAVE_SESSION_AUDIO=1` のときだけ、マイクと AI の音声を `sessions/<id>/session_audio.wav` に保存する（既定は保存しない。`docs/runbook.md` の 9）。研究者本人の自己実験で、音声、イベントログ、吸気のタイミングを照合するための機能である。

**他者の音声を保存する前に、同意の手順が要る。** 参加者実験の同意の取得、保存の方法（保存先、保存期間、消去、外部への持ち出しの扱い）は別途整備する。それまでは他の人の声を保存しない。保存の有無は `manifest.json` の `session_audio` と起動ログに残るが、これは同意の記録の代わりにはならない。

**限界:**

- 音声の位置と時刻の対応は、受信の時刻の下側包絡（1 秒の窓の中で最も遅れの小さい枠）で取っている。ブラウザから Node までの遅れの一定分は測れず、対応に残る。1 秒を超えて遅れが続くと、その区間の対応はその分だけ遅れる。
- 書き込みが上限（64MiB、約 17 分）まで遅れると、その分は無音に置き換わる（`gap` の `queue_overflow`）。
- `sync` の書き込みに失敗すると `session_audio.sync_file_errors` に残り、評価画面は `vap.state` の組に戻る。
- 起動ログはセッションの開始時に出す（orchestrator のプロセスの起動時ではない）。

## 14. 発話の失敗の記録（`turn.outcome`、観測だけ）

VAP が正常に動いているのに開始が外れた場合（発話の途中の開始、重なり、連続発話、話すべき間の沈黙）を、会話ごとに一覧で振り返るための記録。**開始の判断には使わない。** 実装は `apps/orchestrator/src/control/turn_outcome.ts`（純粋な関数）、配線は `session/turn_outcome_wiring.ts`（実行中）と `dev/turn_outcome_replay.ts`（録音）。`turn_manager.ts` は変えていない。

**ラベルはどれも観測に基づく推定で、会話の失敗を確定するものではない。** 値（`config/policy.ja.json` の `turn.outcome`）は【暫定、根拠なし。実データは1会話（ヘッドセットあり）＋ヘッドセットなしの1会話だけ】。

| ラベル | 条件 |
|---|---|
| `suspected_premature_start` | 開始の直前まで人の声があり（`user_just_before_ms`＝最後の声から開始まで 1500ms 以内）、開始より後の音声で ASR の文が伸び（内容のある文）、続きの始まりが開始から `premature_onset_max_ms`（800ms）以内 |
| `user_continued_after_start` | 開始より後の音声で ASR の文が伸びた（`/tune` の「発話の途中での開始」と同じ定義、窓 `continuation_window_ms`＝1500ms）。文が相槌だけのときは付けない |
| `user_overlap` | AI の再生中の人の声（`vad[0]≥speaking_threshold`）が `overlap_min_ms`（240ms）以上で、ASR に内容のある文が出た |
| `backchannel_overlap` | 再生中の文が相槌の語句だけ（`after_ai_speech.backchannel_phrases` と同じ判定。短い断片の判定は使わない）。vad の長さが足りなくても文で数える |
| `overlap_without_asr` | 再生中の vad の重なりが 240ms 以上で、ASR の文がない（雑音の可能性） |
| `ai_interrupted_early` | 割り込みで止まり、再生の長さが `interrupted_early_max_ms`（2000ms）未満 |
| `spoke_twice` | 前の AI の発話の終わりから開始まで、人の声（`vad[0]`）が一度もなかった（`/tune` の連続発話と同じ定義） |
| `no_response_after_user_yield` | 人の声と ASR の更新が止まってから `no_response_wait_ms`（4000ms）経っても AI が話し始めない（`kind='no_response'`）。今の文が対象にしない断片のときと、開始を止める理由（吸気の保留など）があるときは数えない |

**分類しない場合**（`labels.value` が null、`null_reason` に理由）: `echo_suspected`（下）、`speech_failed:*`、`no_audio_played`、`playback_ended_abnormally`（ブラウザの報告が来なかった、代行で閉じた）、`session_closed_before_settle`、`session_closed_during_speech`、`speech_end_not_recorded`、`replay_session_ended_during_speech`。

**エコーの扱い**: `echo_suspected` は、再生区間の ASR の文が AI の発話文に似ていて（`charNgramCosine ≥ echo_text_similarity`＝0.6）、かつ再生区間の人の声の割合が高い（`≥ echo_overlap_ratio`＝0.7）とき。分類せず印だけ残す（エコーの抑制は作っていない）。実ログ: ヘッドセットなしの `s20261108T044950-631c07` は 6 発話すべてで類似度 0.83〜1.00、割合 0.79〜0.91。ヘッドセットありの `s20261108T045055-ca6e12` は文の重なりのある発話で類似度 0、割合 ≤0.06。閾値はこの2例だけの間に置いただけで、根拠にならない。

**確定の時刻**: 再生の終わりから `settle_ms`（1000ms）待って ASR の遅れを受けてから分類する。`continuation_window_ms` の窓は開始から測る。

**実ログの一覧**（`s20261108T045055-ca6e12`、`npx tsx tools/latency_report/turn_outcomes.ts sessions/<id>`。記録に `turn.outcome` のないログは記録の入力から同じ規則で算出。文は出力しない）:

| 開始（ログの秒） | 判断の元 | p_now | 間 | 結果 | 備考 |
|---|---|---|---|---|---|
| 11.12 | vap | 0.88 | 564ms | ラベルなし | |
| 33.08 | vap | 0.71 | 590ms | ラベルなし | |
| 50.26 | completion_timeout | 0.66 | 504ms | `suspected_premature_start` `user_continued_after_start` `user_overlap` | §10 の「発話の途中の開始」（直後に人が「で」と続けた、声の重なり 400ms） |
| 58.07 | completion_timeout | 0.05 | 7105ms | `spoke_twice` | §10 の連続発話 |
| 67.60 | completion_timeout | 0.26 | 627ms | ラベルなし | |

**再生との比較（/tune）**: 録音の再生の指標の表に、ラベルごとの件数を記録と再計算で並べた（`outcome-metrics`）。**再生は反実仮想**で、開始が変わっても人の声と ASR は記録のままなので、再計算の側の件数は確定した失敗の数ではない（画面の注意書きにも書いた）。

**限界**: 分類は機械的なルールで、人の評価（G）の代わりにならない。`vad[0]` は AI の声の回り込みでも上がる（エコーの疑いで止めるのはヘッドセットなしの典型だけ）。`suspected_premature_start` は「開始の直後の続き」を見るだけで、AI の開始が人の発話を実際に妨げたかは分からない（人が気にせず続けた場合も入る）。`user_just_before_ms` は応答性の高い開始（間が 600ms 程度）の大半で真になり、続きの文がなければ何も付かない。`no_response` は「話すべきだった」の判断をしていない（`wait_state` で方策の不許可か音声の準備待ちかだけ分かる）。`hri2025` は `turn` 節がないので同じ暫定値で観測する（相槌の判定はできない）。

**値を変える案**（§10 の基準に照らした案。**実データが1会話なので変えていない**）: `50.26` の開始は `start_guard.min_gap_ms`（900ms）の導入で再生では起きなくなった。`58.07` の連続発話は §10 の `after_ai_speech` で解消した。今の値で出ている開始（`--replay`）は 4 件中ラベルなし。数会話たまったら `suspected_premature_start` の件数で `min_gap_ms` の増減（900ms 付近）と `completion_timeout_low_p_min_ms` の増減を比べ、`no_response_after_user_yield` と合わせて「慎重にしすぎない」方向も見る。
