# 実行 p3_v2_repeat の集計

**手書きの逐次 ASR による予備調査。実音声でも実 ASR でもなく、§4.5a の関門の通過ではない。**

各行 n=1 回の実行。プロンプト版: initiative-ja-v2。

| 台本 | 種類 | モデル | 要求 | 判定の内訳 | NEW(話の途中) | NEW(話の後) | モデルの NEW のうちゲート棄却 | 撤回(モデル/コード) | 残った候補 | 仮説との一致 | 遅延 p50/max ms |
|---|---|---|---:|---|---:|---:|---:|---:|---:|---|---:|
| V2 | validation | gemini-3.5-flash-lite:minimal | 5 | NONE 1, NEW 1, KEEP 3 | 1 | 0 | 0 | 0/0 | 1 | 一致 | 1454/1514 |
| V2 | validation | gemini-3.8-flash:low | 5 | NONE 5 | 0 | 0 | 0 | 0/0 | 0 | 不一致 | 3905/4661 |
| V4 | validation | gemini-3.5-flash-lite:minimal | 7 | NONE 7 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1389/1512 |
| V4 | validation | gemini-3.8-flash:low | 7 | NONE 4, NEW 1, KEEP 1, WITHDRAW 1 | 1 | 0 | 0 | 1/0 | 0 | 一致 | 3965/4712 |

## NEW の後に持続の確認を1段入れていた場合（事後計算）

| 台本 | モデル | 候補 | NEW 受信 s | 次の判定 | 合図を避けられた | 増える遅れ ms |
|---|---|---|---:|---|---|---:|
| V2 | gemini-3.5-flash-lite | c_0001 | 19.3 | KEEP | いいえ | 4587 |
| V4 | gemini-3.8-flash | c_0001 | 20.6 | KEEP | いいえ | 4369 |

## 遅延（モデル別、全要求）

- gemini-3.5-flash-lite: n=12、p50 1421ms、p95 1513ms、max 1514ms、失敗 0
- gemini-3.8-flash: n=12、p50 3935ms、p95 4684ms、max 4712ms、失敗 0
