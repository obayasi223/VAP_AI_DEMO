# 実行 p1_v1_tune の集計

**手書きの逐次 ASR による予備調査。実音声でも実 ASR でもなく、§4.5a の関門の通過ではない。**

各行 n=1 回の実行。プロンプト版: initiative-ja-v1。

| 台本 | 種類 | モデル | 要求 | 判定の内訳 | NEW(話の途中) | NEW(話の後) | モデルの NEW のうちゲート棄却 | 撤回(モデル/コード) | 残った候補 | 仮説との一致 | 遅延 p50/max ms |
|---|---|---|---:|---|---:|---:|---:|---:|---:|---|---:|
| C2 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 3, NEW 1, KEEP 1, WITHDRAW 1 | 1 | 0 | 0 | 1/0 | 0 | 一致 | 1343/1796 |
| C2 | counterexample | gemini-3.8-flash:low | 6 | NONE 3, NEW 1, KEEP 1, WITHDRAW 1 | 1 | 0 | 0 | 1/0 | 0 | 一致 | 3927/5059 |
| C4 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NEW 1, KEEP 5 | 1 | 0 | 0 | 0/0 | 1 | 不一致 | 1511/1866 |
| C4 | counterexample | gemini-3.8-flash:low | 6 | NEW 1, KEEP 3, WITHDRAW 1, NONE 1 | 1 | 0 | 0 | 1/0 | 0 | 不一致 | 4675/5471 |
| V1 | validation | gemini-3.5-flash-lite:minimal | 6 | NONE 1, NEW 1, KEEP 4 | 1 | 0 | 0 | 0/0 | 1 | 一致 | 1706/1886 |
| V1 | validation | gemini-3.8-flash:low | 6 | NONE 1, NEW 1, KEEP 4 | 1 | 0 | 0 | 0/0 | 1 | 一致 | 4504/6340 |

## NEW の後に持続の確認を1段入れていた場合（事後計算）

| 台本 | モデル | 候補 | NEW 受信 s | 次の判定 | 合図を避けられた | 増える遅れ ms |
|---|---|---|---:|---|---|---:|
| C2 | gemini-3.5-flash-lite | c_0001 | 17.7 | KEEP | いいえ | 4410 |
| C2 | gemini-3.8-flash | c_0001 | 20.1 | KEEP | いいえ | 5110 |
| C4 | gemini-3.5-flash-lite | c_0001 | 10.0 | KEEP | いいえ | 6263 |
| C4 | gemini-3.8-flash | c_0001 | 13.2 | KEEP | いいえ | 7183 |
| V1 | gemini-3.5-flash-lite | c_0001 | 17.5 | KEEP | いいえ | 8259 |
| V1 | gemini-3.8-flash | c_0001 | 20.6 | KEEP | いいえ | 9550 |

## 遅延（モデル別、全要求）

- gemini-3.5-flash-lite: n=18、p50 1554ms、p95 1869ms、max 1886ms、失敗 0
- gemini-3.8-flash: n=18、p50 4344ms、p95 5601ms、max 6340ms、失敗 0
