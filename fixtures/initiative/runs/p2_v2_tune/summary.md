# 実行 p2_v2_tune の集計

**手書きの逐次 ASR による予備調査。実音声でも実 ASR でもなく、§4.5a の関門の通過ではない。**

各行 n=1 回の実行。プロンプト版: initiative-ja-v2。

| 台本 | 種類 | モデル | 要求 | 判定の内訳 | NEW(話の途中) | NEW(話の後) | モデルの NEW のうちゲート棄却 | 撤回(モデル/コード) | 残った候補 | 仮説との一致 | 遅延 p50/max ms |
|---|---|---|---:|---|---:|---:|---:|---:|---:|---|---:|
| C1 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1124/1324 |
| C1 | counterexample | gemini-3.8-flash:low | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 3514/3998 |
| C2 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1327/1432 |
| C2 | counterexample | gemini-3.8-flash:low | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 3383/3744 |
| C3a | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1199/1404 |
| C3a | counterexample | gemini-3.8-flash:low | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 3233/3569 |
| C3b | counterexample | gemini-3.5-flash-lite:minimal | 6 | NEW 1, NONE 5 | 1 | 0 | 0 | 0/1 | 0 | 一致 | 1410/1639 |
| C3b | counterexample | gemini-3.8-flash:low | 6 | NEW 1, NONE 5 | 1 | 0 | 0 | 0/1 | 0 | 一致 | 3595/4764 |
| C4 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1382/1519 |
| C4 | counterexample | gemini-3.8-flash:low | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 3773/4935 |
| C6 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1125/1625 |
| C6 | counterexample | gemini-3.8-flash:low | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 3219/3604 |
| H1 | held_out | gemini-3.5-flash-lite:minimal | 5 | NONE 2, NEW 1, KEEP 2 | 1 | 0 | 0 | 0/0 | 1 | 一致 | 1443/1774 |
| H1 | held_out | gemini-3.8-flash:low | 5 | NONE 2, NEW 1, REVISE 1, KEEP 1 | 1 | 0 | 0 | 0/0 | 1 | 一致 | 4276/5214 |
| H2 | held_out | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1204/1272 |
| H2 | held_out | gemini-3.8-flash:low | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 3259/4031 |
| V1 | validation | gemini-3.5-flash-lite:minimal | 6 | NONE 1, NEW 1, KEEP 3, REVISE 1 | 1 | 0 | 0 | 0/0 | 1 | 一致 | 1564/1652 |
| V1 | validation | gemini-3.8-flash:low | 6 | NONE 1, NEW 1, KEEP 4 | 1 | 0 | 0 | 0/0 | 1 | 一致 | 4608/5204 |
| V2 | validation | gemini-3.5-flash-lite:minimal | 5 | NONE 1, NEW 1, KEEP 3 | 1 | 0 | 0 | 0/0 | 1 | 一致 | 1396/1558 |
| V2 | validation | gemini-3.8-flash:low | 5 | NONE 5 | 0 | 0 | 0 | 0/0 | 0 | 不一致 | 3675/4321 |
| V3 | validation | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1331/1368 |
| V3 | validation | gemini-3.8-flash:low | 6 | NONE 6 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 3608/5070 |
| V4 | validation | gemini-3.5-flash-lite:minimal | 7 | NONE 6, NEW 1 | 0 | 1 | 0 | 0/0 | 1 | 不一致 | 1287/1996 |
| V4 | validation | gemini-3.8-flash:low | 5 | NONE 3, NEW 1, WITHDRAW 1 | 1 | 0 | 0 | 1/0 | 0 | 一致 | 3998/13695 |

## NEW の後に持続の確認を1段入れていた場合（事後計算）

| 台本 | モデル | 候補 | NEW 受信 s | 次の判定 | 合図を避けられた | 増える遅れ ms |
|---|---|---|---:|---|---|---:|
| C3b | gemini-3.5-flash-lite | c_0001 | 9.6 | evidence_lost | はい |  |
| C3b | gemini-3.8-flash | c_0001 | 13.0 | evidence_lost | はい |  |
| H1 | gemini-3.5-flash-lite | c_0001 | 20.5 | KEEP | いいえ | 8340 |
| H1 | gemini-3.8-flash | c_0001 | 23.9 | REVISE | いいえ | 7937 |
| V1 | gemini-3.5-flash-lite | c_0001 | 17.4 | KEEP | いいえ | 7910 |
| V1 | gemini-3.8-flash | c_0001 | 20.2 | KEEP | いいえ | 7698 |
| V2 | gemini-3.5-flash-lite | c_0001 | 19.3 | KEEP | いいえ | 4483 |
| V4 | gemini-3.5-flash-lite | c_0001 | 42.2 | （次なし） | いいえ |  |
| V4 | gemini-3.8-flash | c_0001 | 20.6 | WITHDRAW | はい |  |

## 遅延（モデル別、全要求）

- gemini-3.5-flash-lite: n=71、p50 1313ms、p95 1650ms、max 1996ms、失敗 0
- gemini-3.8-flash: n=69、p50 3551ms、p95 5016ms、max 13695ms、失敗 0
