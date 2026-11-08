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
| degraded 中の開始と割り込み | `fallback_silence_max_ms`、`fallback_interrupt_min_words`、`fallback_energy_silence_dbfs` のどれかが null なら、招待以外で開始せず、割り込みもしない。ja は §8 の暫定値で有効 | `fallback_energy` は mic の RMS（dBFS、session が計算）。閾値は方策の `turn.fallback_energy_silence_dbfs` を session が `createTurnManager` へ渡す。値は未校正 |
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
| 合図のゲート | 条件が `initiative_inhale`、活動中の候補が1つ、合図中でない、AI が話していない、アバターが使える、冷却時間（`signal_cooldown_ms`）を超えた（null は未校正として合図しない）、判定の入力の後の新しい安定文字が上限以下（入力が分からなければ合図しない。上限 null は `max_new_stable_chars_since_input` を使う）、判定からの経過が上限以下（null は `max_result_age_ms`）、候補の音声が準備済み。止めた理由は全部 `negotiation.decision`（stage `signal_gate`）に残す（同じ理由の繰り返しは数字を除いた鍵で1回） | 候補の音声を待ってから合図するので、合図は TTS の遅れの分だけ遅れる。吸気の後に話す音声がない状態を避けるため |
| 吸気の長さと完了 | Node が `inhale_ms` を決めて `breath.cue` で送り、完了は Node の時計で判定する（ブラウザの報告は待たない）。`signal.sent` の `parameters.inhale_completion` は `orchestrator_clock` | 描画の遅れや背景タブで完了が遅れないため。`signal.started` は描画の rAF の時刻で別に残す |
| 吸気中の許可 | 吸気中は `start_blocked_reason`（`candidate_inhale_in_progress:<cue_id>`）で通常応答も含めて開始を止める。吸気を終えた tick で許可を見直して話す | 計画 §4.6 のとおり |
| `DEFERRED` | 吸気の後 `hold_max_ms` を過ぎても人が話していれば `DEFERRED` へ移り `breath.release`（`deferred`）。人が黙っていれば保持を続ける（許可か期限まで）。`DEFERRED` から再吸気しない | 人が黙っていて許可が出ないとき、Node 側の保持は期限（15 秒）まで続くが、アバターは自分の上限（`HOLD_MAX_MS`=1500）で自動で脱力する。見た目と状態がずれる |
| 候補と通常応答の選択 | 許可が出た tick で: 直前の発話が直接の質問（招待の種類 `direct_question`、または「ですか」「かな」「なんですか」「どう」で終わる）なら通常応答。そうでなく候補が話せる状態で、音声が準備済みで、判定が古くなければ候補（招待「どうぞ」なら原因 `invitation`、ほかは `turn_allowed`）。理由は `negotiation.decision`（stage `speech_selection`） | 計画の「応答または両者の統合」の統合はしていない（応答だけ）。直接の質問の判定は語尾の規則で、誤認しうる |
| 候補の話し方 | `proposed_utterance` をそのまま TTS に渡して話す。履歴には AI の発話（`origin: candidate`）として残る | 判定の時点の文なので、話す時点の文脈では不自然になりうる（言い換えはしていない）。直前の通常応答の準備は使わない |
| 撤回 | 通常応答を話し始めたら撤回（E2a）。期限 `candidate_expiry_ms` でも撤回。どちらも合図中なら `breath.release`（`withdrawn`）。未再生の PCM は E2a の `discardCandidate` が棄てる | 破棄は JSONL のイベントにしていない（`negotiation_wiring` の `discardedAudio` とプロバイダの取り消しだけ）。後から破棄を確かめるには `candidate.state_changed` と `speech.*` の欠けから推すしかない |
| `REVISE` | 再吸気しない。古い版の PCM は棄て、新しい版の文で音声を作り直す | 作り直しの間に許可が出ると、候補の音声がないので通常応答が勝つことがある |
| 二つ目の `NEW` | 活動中の候補があれば E2a が棄却（`active_candidate_exists`） | 波2のまま |

**暫定の値（`config/policy.ja.json`）**

- `initiative.candidate_expiry_ms`: null → 15000。`max_result_age_ms`（8 秒）の約2倍で、話の途中で出た候補をターンの終わりまで持たせる程度。測っていない。
- `initiative.signal_cooldown_ms`: null → 4000。吸気の連続を防ぐ。吸気 0.45 秒＋保持 1 秒に約 2 秒の間を足した程度。測っていない。
- `initiative.negotiation.inhale_ms`: 450。アバターの既定（`apps/web/src/avatar/breath.ts` の `DEFAULT_INHALE_MS`）に合わせただけ。文献や計測から選んだ値ではない。
- `initiative.negotiation.hold_max_ms`: 1000。アバターの自動の脱力（1500）より短くした。
- `initiative.negotiation.max_new_stable_chars_since_judgement` と `cue_max_judgement_age_ms`: null（G の鮮度の値をそのまま使う）。

**条件の選び方と、参加者に見せない運用**

- 開始画面に条件の選択（「通常応答（ベースライン）」「吸気あり（提案）」「吸気なし」）を置き、選んだ条件を WS の URL の `?condition=` で送る。初期値は URL の `?condition=`、なければ `NEXT_PUBLIC_DEFAULT_CONDITION`、なければ `reactive`。
- 本番の参加者実験では条件を参加者に見せないこと: web は `NEXT_PUBLIC_HIDE_CONDITION_PICKER=1`（選択を隠し、条件を送らない。表示名も出さない）、orchestrator は `CONDITION_FROM_CLIENT=0`（画面の求めを無視して `CONDITION` に固定）。今は既定で選択を見せている（予備体験用）。
- 研究者画面の設定の表示（`research.config` の condition）は起動時の `CONDITION` のままで、セッションごとの条件を映していない。JSONL の各行の `condition` と manifest はセッションの条件。

**persona**

- 既定の `PERSONA_FILE` を `config/persona.ja.conversation.json`（自由な会話の聞き手、`conversation_partner`）にした。暫定で、関心の項目は確かめていない。展示会の同僚は `PERSONA_FILE=config/persona.ja.json`。判定のプロンプト（`initiative-ja-v2`）の基準は変えていない。

**E2E の台本（`SCRIPTED_INITIATIVE=new_on_input`）**

- 台本の STT が interim をすべて安定テキストとして出し、判定の LLM が入力の最後の区間から根拠を抜き出した `NEW`（候補があれば `KEEP`）を返す（`app/scripted.ts`）。reactive のセッションの STT の台本は変えない。配線を通すためだけのもので、発話希望の判断ではない。既定は `none`。
