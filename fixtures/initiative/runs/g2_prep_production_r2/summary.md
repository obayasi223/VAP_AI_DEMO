# 実行 g2_prep_production_r2 の集計

**手書きの逐次 ASR による予備調査。実音声でも実 ASR でもなく、§4.5a の関門の通過ではない。**

経路: production_wiring（production_wiring は本実装の InitiativeWiring と CandidateLedger、spike_monitor はスパイク）。

各行 n=1 回の実行。プロンプト版: initiative-ja-v2。

| 台本 | 種類 | モデル | 要求 | 判定の内訳 | NEW(話の途中) | NEW(話の後) | 話の後の NEW の保留 | モデルの NEW のうちゲート棄却 | 撤回(モデル/コード) | 残った候補 | 仮説との一致 | 遅延 p50/max ms |
|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---|---:|
| C2 | counterexample | gemini-3.5-flash-lite:minimal | 6 | NONE 4, NEW 1, WITHDRAW 1 | 1 | 0 | 0 | 0 | 1/0 | 0 | 一致 | 1400/1746 |
| V3 | validation | gemini-3.5-flash-lite:minimal | 6 | NONE 6 | 0 | 0 | 0 | 0 | 0/0 | 0 | 一致 | 1265/1687 |
| V4 | validation | gemini-3.5-flash-lite:minimal | 7 | NONE 2, NEW 2, KEEP 1, WITHDRAW 1, WITHDRAW(棄却) 1 | 2 | 0 | 0 | 0 | 1/0 | 1 | 不一致 | 1420/1921 |

## NEW の後に持続の確認を1段入れていた場合（事後計算）

| 台本 | モデル | 候補 | NEW 受信 s | 次の判定 | 合図を避けられた | 増える遅れ ms |
|---|---|---|---:|---|---|---:|
| C2 | gemini-3.5-flash-lite | c_0001 | 22.5 | WITHDRAW | はい |  |
| V4 | gemini-3.5-flash-lite | c_0001 | 17.8 | KEEP | いいえ | 1627 |
| V4 | gemini-3.5-flash-lite | c_0002 | 39.8 | （次なし） | いいえ |  |

## 遅延（モデル別、全要求）

- gemini-3.5-flash-lite: n=19、p50 1405ms、p95 1763ms、max 1921ms、失敗 0
