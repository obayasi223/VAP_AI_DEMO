# 実行 g2_prep_production の集計

**手書きの逐次 ASR による予備調査。実音声でも実 ASR でもなく、§4.5a の関門の通過ではない。**

経路: production_wiring（production_wiring は本実装の InitiativeWiring と CandidateLedger、spike_monitor はスパイク）。

各行 n=1 回の実行。プロンプト版: initiative-ja-v2。

| 台本 | 種類 | モデル | 要求 | 判定の内訳 | NEW(話の途中) | NEW(話の後) | 話の後の NEW の保留 | モデルの NEW のうちゲート棄却 | 撤回(モデル/コード) | 残った候補 | 仮説との一致 | 遅延 p50/max ms |
|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---|---:|
| C1 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1242/1328 |
| C2 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 4, NEW 1, WITHDRAW 1 | 1 | 0 | 0 | 0 | 1/0 | 0 | 一致 | 1406/1696 |
| C3a | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1307/1461 |
| C3b | counterexample | gemini-3.5-flash-lite:minimal | 6 | NEW 1, NONE 5 | 1 | 0 | 0 | 0 | 0/1 | 0 | 一致 | 1245/1654 |
| C4 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1333/1489 |
| C6 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1190/1339 |
| H1 | held_out | gemini-3.5-flash-lite:minimal | 5 | NONE 2, NEW 1, KEEP 2 | 1 | 0 | 0 | 0 | 0/0 | 1 | 一致 | 1636/1725 |
| H2 | held_out | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1231/1587 |
| V1 | validation | gemini-3.5-flash-lite:minimal | 6 | NONE 1, NEW 1, KEEP 4 | 1 | 0 | 0 | 0 | 0/0 | 1 | 一致 | 1571/1669 |
| V2 | validation | gemini-3.5-flash-lite:minimal | 5 | NEW 1, KEEP 3, REVISE 1 | 1 | 0 | 0 | 0 | 0/0 | 1 | 一致 | 1588/1655 |
| V3 | validation | gemini-3.5-flash-lite:minimal | 6 | NONE 2, NEW 1, KEEP 3 | 1 | 0 | 0 | 0 | 0/0 | 1 | 不一致 | 1427/1816 |
| V4 | validation | gemini-3.5-flash-lite:minimal | 7 | NONE 3, NEW 2, WITHDRAW 1, WITHDRAW(棄却) 1 | 2 | 0 | 0 | 0 | 1/0 | 1 | 不一致 | 1520/1997 |

## NEW の後に持続の確認を1段入れていた場合（事後計算）

| 台本 | モデル | 候補 | NEW 受信 s | 次の判定 | 合図を避けられた | 増える遅れ ms |
|---|---|---|---:|---|---|---:|
| C2 | gemini-3.5-flash-lite | c_0001 | 22.4 | WITHDRAW | はい |  |
| C3b | gemini-3.5-flash-lite | c_0001 | 9.9 | evidence_lost | はい |  |
| H1 | gemini-3.5-flash-lite | c_0001 | 20.6 | KEEP | いいえ | 7688 |
| V1 | gemini-3.5-flash-lite | c_0001 | 17.3 | KEEP | いいえ | 7821 |
| V2 | gemini-3.5-flash-lite | c_0001 | 11.5 | KEEP | いいえ | 7968 |
| V3 | gemini-3.5-flash-lite | c_0001 | 25.2 | KEEP | いいえ | 3507 |
| V4 | gemini-3.5-flash-lite | c_0001 | 20.2 | WITHDRAW | はい |  |
| V4 | gemini-3.5-flash-lite | c_0002 | 39.8 | （次なし） | いいえ |  |

## 遅延（モデル別、全要求）

- gemini-3.5-flash-lite: n=71、p50 1335ms、p95 1721ms、max 1997ms、失敗 0
