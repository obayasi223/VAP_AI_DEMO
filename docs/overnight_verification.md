# 夜間の検証（2026-11-09）

未確認の事項の検証と小さな残件の結果。「確定」はログや再現で確かめたもの、「推定」は根拠があるが直接は確かめていないもの、「未確認」は測れなかったもの。

環境の前提: WSL2、headless Chromium（SwiftShader）、同時に別の担当の作業が動いていた（負荷 18〜41、ブラウザは nice 15）。実機の GPU、ヘッドセット、人の声では確かめていない。

## 0. 全体に影響する発見: WSL の時計が約 33 秒ごとに +1.3 秒飛ぶ（確定）

単調時計と実時計を 50ms ごとに比べる単独のスクリプト（Python、このリポジトリのコードを含まない）で、**実時計だけが +1.299 秒飛ぶ**ことを確認した（45 秒に 2 回、32 秒間隔）。E2E の `Date.now` のループ監視でも 33.5 秒周期で 1.2〜1.4 秒が 4 回の実行すべてに出ていた。

- **Node のイベントループは止まっていない。** 監視を単調時計に直すと、遅れは最大 106ms（2 回、E2E 5 回目）。GC の 50ms 以上の停止も 0 件。途中で「1.3 秒の停止」と見えたものは時計の飛びの見かけ。
- ログの `wall_clock` はこの飛びを含む。**`wall_clock` の差で遅延を測らない**（`t_monotonic_ms` と `rendered_at` は影響を受けない）。
- 飛びの原因（WSL の時刻同期か、負荷か）は未確認。

## 1. 実 STT／LLM／TTS の通し確認（確定、範囲は下記）

`apps/orchestrator/test/e2e/real_smoke.ts`（`main.ts`＋ポート 8787、headless Chromium、偽マイク）で 2 セッション。`SAVE_SESSION_AUDIO` なし。マイクは ElevenLabs で作った 3 文（計 185 文字）。条件はどちらも `initiative_inhale`、`joint_thinking`。方式は `immediate` と `llm`。

| | s20261108T172012-9d1d67（immediate） | s20261108T172139-5673c1（llm） |
|---|---|---|
| 長さ | 79.4 秒 | 80.0 秒 |
| manifest の providers | すべて `production` | すべて `production` |
| `session_audio` | `saved: false`（未設定） | 同左 |
| `log:check` | 合格、隔離 0 | 合格、隔離 0 |
| 吸気→発話（候補） | c_0001 と c_0002 は DEFERRED 経由で発話、c_0003 は直接の質問で通常応答へ譲って撤回 | c_0002 は吸気→許可で発話。c_0001 は `WAIT`→通常応答で話した内容と一致して `already_said` で撤回。c_0003 は直接の質問で撤回 |
| 通常応答 | 1 件（直接の質問） | 2 件（`initiative.response_material` 2 件あり） |
| `review:initiative` | API で読み込み可 | API で読み込み可（候補 3 件） |

- 候補の発話の開始の `turn.allowed` は `gap_ms` 901〜961ms（`start_guard` の 900ms の経路）。
- 実 API の使用: 2 セッション、合計 159 秒。推定費用 $0.12（ログの定価換算、`aborted_request` の 9＋9 件は不明として含まない下限）に、マイク音声の生成 185 文字。
- 発話希望の頻度と内容の妥当性は評価していない。**実時間の人の声とマイク、Windows の Chrome は未確認。**

## 2. 視線の E2E の「1 秒以内の描画」の失敗

**結論: 試験の照合の問題が 4 つ重なっていた（直した）。高負荷では本物の遅れも出る（下の表）。**

原因（順に確定／推定）:

1. **時計の飛び（確定）。** `lag_ms` は `wall_clock`（受信の時刻）で測っていて、判断から受信の間に飛びが入ると +1.3 秒に見える。今は `rendered_at`（描画時刻）と判断の `t_monotonic_ms` の差で測る。閾値 1 秒は変えていない。
2. **時間軸の換算（確定、§4）。** `rendered_at` の差を使えなかったのは、セッションの一部で `rendered_at` が約 1.2 秒前にずれていたから。§4 で直した。
3. **照合の誤り（確定）。** 切断試験の間に出た判断（ブラウザへ届かない）が、復帰後の別の判断の描画と対応づけられて 1054ms と数えられていた（E2E 5 回目で確認。判断 79906ms は切断 79730〜79985ms の中）。切断の区間の判断は `link_down` として照合から外した。
4. **ページを閉じる瞬間の判断（確定）。** 閉じる直前に出た判断は、ページが hidden で rAF が来ないため `visible:false, null_reason:"page_hidden_no_raf"` の報告になる（E2E 6 回目、判断 127884ms。その 57ms 後の 127941ms に `browser_link` が `ws_closed`）。閉じる時刻の 1 秒前より後の判断に限って `page_closed` と同じ扱いにした。実行の途中で hidden になったものは失敗のまま残す。閾値 1 秒は変えていない。

以前の 1.05〜1.2 秒の失敗が 1. のものかは、古いログが手元にないので**推定**（飛びの大きさは 1.0〜1.4 秒程度で今回の値の範囲に近い）。

**本物の遅れ（確定、対象は E2E 4 回目）:** 負荷が 30〜40 のときは `rendered_at` の差で 1.3〜3.1 秒の遅れが出た（描画された 7 件中 3 件）。実時間の描画の遅れで、試験の問題ではない。同じ時間帯には別の担当の chrome-headless が nice 0 で計 15 コア前後を使っていて、こちらのブラウザは nice 15 だった。このときの長いタスクの時点との対応は未確認（観測が最初の 75 秒だけ）。

**差し替えの層（`runtime.ts`、`rig.ts`、`rig_glb.ts`）が遅れを増やしたかは未確認。** 前後のコードを同じページで交互に動かして `setGaze`→描画の報告の遅れと rAF の間隔を比べたが、負荷 31〜41 では rAF の間隔の中央値が前 4350／2767／4816ms、後 3567／2433／4433ms（各 3 回）、遅れの n も 4〜7 で、差が読めない測定になった。1 フレームの中の処理は差し替えで別の関数へ移っただけで、増えた処理は差分からは見当たらない（推定）。負荷の低い環境での再測定が残る。

E2E: 回ごとの結果は §7。

## 3. 候補の話し止み→発話が約 1.5 秒（確定、閾値は変えていない）

実 MaAI の E2E で発話の開始の `turn.allowed` の理由を見ると、**候補に限らず** 2 セッション目以降の開始はすべて次の経路だった。

```
fallback_silence_max+wait=1500ms+asr_final+vap_unavailable:rewarm:8053
```

- E2E の 2 セッション目以降は開始から約 8 秒で最初の発話が終わる。VAP の助走（10 秒、`vap_unavailable`）の間なので、TurnManager の `decideVapUnavailableStart` の 1500ms で許可している。候補、通常応答とも `gap_ms` 1502〜1520ms（E2E 3 回目）。
- つまり「1500ms の経路」という推定は正しいが、原因は L74 の `completion_timeout_low_p_min_ms` ではなく **助走中の縮退の経路**。候補固有の遅さではない。
- VAP が使える間の開始は候補でも 900ms 前後: 実 API の 2 セッションで候補の `gap_ms` 901〜961ms、E2E 1 セッション目の通常応答も 907〜978ms（E2E 3 回目）。

## 4. `rendered_at` が判断より前の値になる（確定、直した）

**原因: Worker の時刻と主スレッドの時刻の軸を `performance.timeOrigin` の引き算で揃えていた。** Chromium の `timeOrigin` は実時計から換算するので、ページの読み込みと Worker の生成の間に §0 の飛びが入ると、軸が飛びの分（約 1.2〜1.3 秒）ずれる。

- 直接の観測: 実 API の 1 セッション目で `signal.sent` 15378ms に対し `signal.started` 14052ms（負の遅れが 6 件すべて、約 -1.2 秒）。2 セッション目はずれない。
- 修正後の E2E では、メッセージ往復で測った軸と `timeOrigin` の差 `skew_ms` が **-1252、-1195、-1277ms** の回と **0.85、-0.5ms** の回があり、飛びが入ったかどうかで分かれている。
- 修正: `ThreadAxisEstimator`（`apps/web/src/audio/clock_sync.ts`）で Worker と主スレッドの往復から軸を測る（RTT 最小、誤差は RTT/2 を `clock.report` の誤差に加える）。Worker の `clientNow` はこれを優先する。

修正後は `rendered_at − 判断` が -67〜+207ms の範囲（E2E 3 回目）で、1 秒前のような値は出ない。-67ms までの負の値が 19 件中 5 件残る。rAF の時刻はフレームの開始で、命令の受信より少し前になりうる（ブラウザ内の実測で -19〜-1ms）が、それ以外の 50ms 程度の分は説明できていない（未確認）。→ 2026-11-09: 軸の推定の偏りが時計差に固定されたものと分かった（`docs/time_axes.md` §1.3、直した）。

## 5. 候補の開始での `playback.begin` と合図の順序（直した）

候補の開始の tick で `playback.begin` と PCM の送信を、`breath.release`／`breath.prepare` の送信の後に回した（`session.ts` の `afterCandidateRelease`。同じ tick の中の順序の入れ替えだけで、音声の開始は遅らせていない）。結合試験で順序を固定した。

- 修正後の E2E 3 回目で、候補 3 件の `signal.started pre_speech` は `speech.started` より 15〜99ms 前。修正前の実 API の 1 件（c_0002）は描画が 249ms 後だった（SwiftShader の 1 フレームが 200〜300ms かかる条件）。
- どちらも rAF の時刻とブラウザの再生の報告の比較で、**実機の GPU の画面と耳に届く音の順序は未確認**。

## 6. 研究者画面の候補の表（直した）

`apps/web/src/research/candidates_view.ts` に `initiative.not_offered`、`initiative.response_material`、`initiative.response_reflection`、`initiative.already_said`、`negotiation.cue_reaction`、`negotiation.decision`（選択と音声の段階のみ）の表（`candidates.notes`、`data-testid="candidate-notes"`）を追加。LLM の文は「LLM 生成」の欄に分けた。

## 7. E2E の実行（台本のプロバイダ＋実 MaAI、合計 8 回）

| 回 | 結果 | 備考 |
|---|---|---|
| 1 | 中断 | `tab2` の `#start` が 30 秒で見つからず（負荷 23〜35）。視線の照合の前に例外で停止 |
| 2 | 中断 | 同じ。`tab2` の待ちを 90 秒に変更。例外でも `ALL OK` と出ていた表示を修正 |
| 3 | ALL OK（62 項目） | |
| 4 | 3 項目 FAIL | 視線（負荷 30〜40 の本物の遅れ 3 件）。`WAIT_FOR_TURN_END` の 2 項目は過負荷の競合（台本のタイミング段の判定 26855ms より先に通常応答が 26746ms で開始。設計どおり `timing_not_judged` で通常応答へ） |
| 5 | 1 項目 FAIL | 視線の照合の誤り（§2 の 3.）のみ |
| 6 | 1 項目 FAIL | 視線のみ。変わった 26 件のうち 24 件は 1 秒以内（差は −92〜+263ms）、1 件はページを閉じた後で `page_closed`、残る 1 件が `page_hidden_no_raf`（§2 の 4.）。描画の遅れではない |
| 7 | ALL OK（62 項目） | 負荷 16〜20。この回の判定は `hidden` を時点によらず通す広い形だったが、`hidden` は 0 件で結果に影響なし |
| 8 | ALL OK（62 項目） | 負荷 16〜20。**最終の判定**。変わった 24 件のうち 23 件は 1 秒以内、`hidden` と `link_down` は 0 件 |

`tab2` の待ちを伸ばしたのは視線の閾値ではなく、高負荷でのページ操作の待ち時間。

## 8. 変更したファイル

- 時間軸: `apps/web/src/audio/{clock_sync,protocol,transport.worker,engine}.ts`、`apps/web/public/worklets/transport.worker.js`（再生成）
- 順序: `apps/orchestrator/src/session/session.ts`
- 表: `apps/web/src/research/{candidates_view.ts,LivePanels.tsx}`
- 試験: `apps/orchestrator/test/e2e/run.ts`（視線の判定を描画時刻で、切断区間と閉じる直前の除外、タスクと負荷の記録）、`apps/orchestrator/test/e2e/real_smoke.ts`（新規）、関連の単体試験
- 記録: `apps/web/src/session/participant.ts`（E2E 向けの `reported_t_ms` と軸）

## 9. 残る問題

- 切断中の `gaze.command` は再送しない。切断の間の判断はアバターに反映されない（E2E 5 回目の例で、away のまま約 1 秒）。切断時に限る。
- 別プロセスの時刻の補正は `offset_ms` の推定に依存する。§0 の飛びが出る WSL では、`wall_clock` を使う処理を増やさない。
- 高負荷（他の担当の処理と重なる）では、視線の遅れなどの E2E が環境依存で落ちる。7・8 回目は負荷 16〜20 で通ったが、負荷の低い環境で単独で動かしたときの結果は未確認（他の担当と重なり続けたため）。
- 差し替えの層の影響の再測定（§2）、実機の GPU での音と描画の順序（§5）、実時間の人の声（§1）は未確認。
