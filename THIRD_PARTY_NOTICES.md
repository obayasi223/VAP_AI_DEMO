# 第三者の権利表記（骨子）

計画 §7 の提出物。提出版は K（統括）がまとめる。確認日 2026-11-08。
**技術的に利用できることと、研究利用が許諾されていることは別**（仕様§1）。

## ソフトウェア（レーン F が入れた直接の依存。`package.json` の license 欄で確認）

| 名前 | 版 | ライセンス |
|---|---|---|
| next | 16.4.5 | MIT |
| react, react-dom | 19.3.1 | MIT |
| zod | 4.6.7 | MIT |
| ws | 8.22.1 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| tsx | 4.23.15 | MIT |
| vitest | 4.1.12 | MIT |
| @types/node, @types/ws, @types/react, @types/react-dom | | MIT |
| maai | 0.2.25 | MIT（ソースのみ。重みは下の表） |

推移的な依存（npm と Python）の一覧は未作成。

### 形態素解析（読み。後続のレーンが追加、2026-11-08）

| 名前 | 版 | ライセンス |
|---|---|---|
| kuromoji | 0.1.2 | Apache-2.0（`node_modules/kuromoji/LICENSE-2.0.txt`） |
| 同梱の辞書 mecab-ipadic | 2.7.0-20070801 | NAIST の著作権表示と免責、ICOT Free Software の条件（NO WARRANTY の条項を必ず添える）。全文は `node_modules/kuromoji/NOTICE.md` |
| async, lodash, doublearray, zlibjs, @types/kuromoji, @types/doublearray | | MIT |

辞書を再配布する場合（配布物に `node_modules` を含めるなど）は、`NOTICE.md` の著作権表示と NO WARRANTY の条項をそのまま添える。

## モデルの重み（計画 §1.1 の調査結果。R2 が確認する）

| 重み | ライセンス | 状態 |
|---|---|---|
| `vap_jp`, `vap_mc_jp`, `vad_jp` | CC-BY-NC-ND 4.0 | HF タグと README で確認。利用区分は計画 §9-1 の判断待ち |
| `vap_jp_kyoto`, `vap_mc_jp_kyoto` | MIT | HF タグと README で確認 |
| Mimi ONNX | CC-BY-4.0 | HF タグと README で確認 |
| CPC | 原プロジェクトのライセンスに従う | 内容は未確認。`normal` の比較に使う前に確認する |

MaAI の README はシステム開発と共同研究について井上昂治氏への連絡を案内している。

## 3D モデル、音声（未記入）

- VRM モデル（H）: `Sendagaya_Shino`（VRoid の旧サンプル、千駄ヶ谷篠）の埋め込みメタは CC0。VRoid 公式ヘルプ（https://vroid.pixiv.help/hc/ja/articles/360013482714）で CC0 であることを研究者本人がブラウザで確認（2026-11-09）。`HairSample_Female` は未確認。
- TTS の声（D）: 未選定。
- 外部 API の利用規約は `docs/provider_matrix.md` を参照。
