# アバター差し替えの検証（Rocketbox と MakeHuman）

検証日: 2026-11-08 〜 11-09。**ここに書くのは観察した事実と測定値です。「日本人に見えるか」「自然か」の判断は利用者が画像と画面で行います。** 推測は「推測:」と書きます。

採用基準は「胸・肩・首の骨がそろうこと」ではなく、**実際に自然な吸気を表現できるか**です（骨や形状が欠けても代替で表現できればよい）。声は足しません（無音の吸気）。既定のアバターは VRM のままです。

## 1. 何ができたか

| 項目 | 結果 |
| --- | --- |
| Rocketbox の差し替え | 動いた。7 体（Female_Adult_01 と候補 6 体）を GLB に変換し、口・瞬き・視線・吸気・延期・撤回・発声への遷移が動く |
| MakeHuman（MPFB のデータ）の差し替え | 動いた。アドオンのコードは実行せず、データ（base.obj、ターゲット、リグの JSON、CC0 素材）だけから GLB を 2 体作った |
| 共通の適合層 | `apps/web/src/avatar/rig.ts`（`AvatarRig`）、`rig_glb.ts`（GLB）、`runtime.ts` の `createVrmRig`（VRM）。VRM の経路のコードは移しただけ |
| 切り替え | `?avatar=<id>` または `NEXT_PUBLIC_AVATAR` だけ。既定は VRM。参加者画面に選択肢は無い。manifest の `avatar` に id・種別・URL・指定元・読み込み結果を記録 |
| 比較ページ | `/dev/avatar_compare`（dev のみ）。同じカメラ、同じ吸気の台本 |
| 測定ページ | `/dev/avatar_measure`（dev のみ） |

モデルの id: `vrm`、`rocketbox`（Female_Adult_01）、`rb_fa03`、`rb_chef01`、`rb_bf03`、`rb_ma09`、`rb_ma10`、`rb_bm02`、`mpfb_ja`（女性）、`mpfb_ja_m`（男性）。

## 2. ライセンスと出典

| 素材 | 出典 | ライセンス（確認した本文） |
| --- | --- | --- |
| Microsoft Rocketbox | https://github.com/microsoft/Microsoft-Rocketbox（commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9`、2022-10-02） | `LICENSE.md` の MIT License の本文を確認。README に研究での引用の案内（Frontiers in Virtual Reality 2020、DOI 10.3389/frvir.2020.561558）と ARKit 互換のブレンドシェイプの記載あり |
| MPFB2（データのみ使用） | Blender の拡張 MPFB v2.0.18 の zip（SHA-256 `c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad`） | `LICENSE.md` でコードは GPLv3、アセットは CC0。各データのヘッダに CC0 の記載 |
| MakeHuman system assets | https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip（SHA-256 `b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107`、約 280 MB） | 同梱の `packs/makehuman_system_assets.json` で全 94 項目が license CC0。使った肌・髪・目・歯・舌・まつげ・眉・服の項目も CC0。各ファイルのヘッダにも CC0 の記載 |
| Blender | 公式の配布物 4.2.23（linux-x64、配布元のチェックサムと照合） | 変換に使っただけ。成果物には含まれない |

注意: `mpfb_ja` の服（female_casualsuit01）の胸には MakeHuman のロゴの絵柄があります（CC0 の素材のままです）。実験刺激にするなら服は変えたほうがよい点です。

MPFB のアドオンの Python は「取得物の中のスクリプトを実行しない」の制約で実行していません。MPFB の GPL のコードは生成物に含まれません。

モデルのファイル、テクスチャ、変換の成果物、下の確認画像は `apps/web/public/models/`（git で無視）にあり、git に入れていません。

## 3. モデルの作り方（要点）

変換のスクリプトは一時領域にあり、リポジトリには入れていません（`rb_convert2.py`、`mpfb_build.py`。手順は次のとおり）。

- **Rocketbox**: Blender 4.2.23 headless で `*_facial.fbx` を読み、`AK_`（ARKit）と `AA_VI_`（視素）の形状キーだけ残し、変換を適用して GLB へ。roughness は頭 0.55、体 0.85 の定数（spec マップからの変換は光沢が破綻したため）。ノーマルマップの G は反転しない。骨は 80 本の Biped。形状 67 個。トライアングル 6732〜9208。ファイル 21〜32 MB。
- **MakeHuman**: `base.obj` にマクロターゲット（女性: `asian-female-young` + `universal-female-young-averagemuscle-averageweight`、男性は male に置き換え）を重みの 1.0 で足し、リグの JSON（CUBE／VERTEX／MEAN）で骨の位置を計算、`weights.default.json` で重みづけ。髪・服・目・歯・舌・まつげ・眉は mhclo の式（3 頂点の重みとオフセット）で体に合わせ、服の `delete_verts` で体の見えない面を消す。形状キーは `expression/units/asian` の単位ターゲットを体と各プロキシへ（プロキシは mhclo の重みで移す）。作った候補は女性 `ponytail01`、男性 `short02` の髪。髪は MH 同梱のテクスチャを暗く変換、眉・まつげはアルファを強めた。
- 表情の対応は `avatar_models.ts` の `ROCKETBOX_SPEC` と `MPFB_SPEC`（重みは目視で決めた暫定の値）。

GLB の容量（トライアングルは Rocketbox は 6.7〜9.2 千）: Rocketbox 21〜32 MB、`mpfb_ja` 15 MB、`mpfb_ja_m` 17 MB。

## 4. 候補の一覧（画像は利用者の目で判断）

撮影は同じカメラ・同じ照明（WSL の headless Chromium、SwiftShader、`framing=face`）。

- 全候補の正面と 3/4: `apps/web/public/models/review/face_sheet.png`（個別は `review/faces/<id>_front.png`、`<id>_34.png`）。**git に入っていません。`npm run dev` のときは http://localhost:3100/models/review/face_sheet.png で開けます**。
- 吸気の連続画像（VRM、rb_fa03、mpfb_ja）: `review/series_speak.png`
- 瞬きと視線: `review/blink_gaze.png`。口の拡大: `review/mouth_zoom.png`。襟の拡大: `review/collar_zoom.png`

Rocketbox の成人モデル全 110 体のプレビューから、髪が黒く瞳の暗い候補を 6 体選びました（`rb_fa03`、`rb_chef01`、`rb_bf03`、`rb_ma09`、`rb_ma10`、`rb_bm02`）。

見たままの事実（評価ではない）:

| id | 髪 | 肌と顔 | 口と瞬きの破綻 |
| --- | --- | --- | --- |
| rocketbox（Female_Adult_01） | 金髪のポニーテール | 明るい肌色、肌の階調が細かい | 視素の重みを下げて開く大きさを調整（aa 0.62） |
| rb_fa03 | 黒、長め。切り抜きの境界に点状の白い斑点が残る | 濃い肌色、上まぶたに紫の化粧 | 視素で口内が暗く開き、上の歯が線で見える。瞬きで閉じる |
| rb_chef01 | 黒。白い調理帽で頭頂が隠れる | 濃い肌色、紫の化粧 | 未確認（連続画像を撮っていない） |
| rb_bf03 | 黒、肩まで | 濃い肌色、口紅は暗い赤 | 未確認 |
| rb_ma09 | 黒のポニーテール（長い） | 額が広く、ほうれい線と目尻のしわがある | 未確認 |
| rb_ma10 | 黒、短め | 黄褐色の肌、光沢がやや強い | 未確認 |
| rb_bm02 | 黒、短め | 肌の質感が細かい | 未確認 |
| mpfb_ja | 黒のポニーテール（`ponytail01`）。髪の生え際がギザギザ | 薄い肌色、目は細く虹彩が暗い。顔のサイズは他より小さく写る（身長 1.49 m で同じカメラの枠のため） | 口を開くと下の歯が灰色で見える（`review/mouth_zoom.png`）。瞬きで閉じる。眉は細いアルファカットで境界がギザギザ、眉が黒く強い |
| mpfb_ja_m | 黒、短め（`short02`）。生え際がギザギザ | 薄い肌色 | 未確認（女性と同じ構造） |

`rb_chef01` の帽子や `mpfb_ja` のロゴのような、実験刺激としての不都合は見てのとおりです。

共通の適合層で動かした候補はいずれも同じ `AvatarRig` の経路です。髪や肌の色の調整は `mpfb_ja`（髪の暗色化、眉・まつげ）だけで、Rocketbox の候補のテクスチャは配布のままです。

## 5. 吸気の観察

同じ台本（`speak`: 吸気 → 保持 → 発話）、Windows Chrome、GPU（`AMD Radeon(TM) Graphics`）、層の時間を止めて 100 ms 刻み、画像は `results5`。保持に入る `t=700 ms` の位置を、`t=0` からの差で示します（mm、ワールド座標）。

| | VRM | rb_fa03 | mpfb_ja |
| --- | --- | --- | --- |
| 胸郭モーフの重み（ピーク） | 0.90 | 0.90 | 0.90 |
| 左肩ボーンの y | -0.75 | -1.62 | +0.21 |
| 右肩ボーンの y | -0.85 | -1.08 | -0.05 |
| 首の y | -0.98 | -1.57 | -0.45 |
| 頭の y | -0.85 | -1.36 | +0.15 |
| 頭の z（前後） | -4.21 | -5.55 | -5.14 |
| 左上腕の y | +4.40 | +3.28 | +7.93 |
| 胸郭モーフで動く頂点 | 2567 | 1175 | 2029 |
| モーフの最大変位 | 17.1 mm | 16.7 mm | 15.2 mm |

- 候補ごとの吸気の部位の有無: どの候補にも胸（upperChest）、首、頭、鎖骨（肩）、上腕があり、代替は不要でした。`rb_*` は全員同じ 80 本の骨です。
- Rocketbox は鎖骨が首の子なので、首の回転が肩に伝わらないように打ち消しています（`counterParent`）。MakeHuman は鎖骨が背骨の子で打ち消しは不要です。
- MakeHuman は上腕の y の動きが VRM の約 1.8 倍、Rocketbox の約 2.4 倍と大きく（表の +7.93 mm）、肩ボーンの y はほぼ動きません。鎖骨の回転の取り方が違うためです（推測: 鎖骨から上腕までの間に `shoulder01` があり、回転の中心が違う）。肩の動きは画面で見て判断してください。
- 口の開きは `setMouthLevel` で視素に束ねています。声の録音は行っていません。
- 破綻の観察: `mpfb_ja` は襟の左右に体の皮膚が小さくはみ出している（`review/collar_zoom.png`）。吸気中も形状は破綻しません。VRM と Rocketbox に、胸元のちぎれは見ませんでした（連続画像の範囲）。延期・撤回の台本（`defer_withdraw`、`withdraw_mid_inhale`）も同じ値で最後は idle に戻りました（胸の重み 0.00〜0.08）。

## 6. 測定

### 描画（Windows Chrome、GPU、1280×720）

`/dev/avatar_measure` を、一時の `--user-data-dir` で 1 モデルずつ開き 60 秒待機、続けて吸気の開始を 20 回呼びました。3 回繰り返し（n はフレーム数、1 回 3594〜3595）。読み込み完了時の WSL の loadavg（1 分）は 0.04〜0.87（ただし最初の VRM の直前は自分の SwiftShader の撮影で 6.85）。

| モデル | フレーム時間 中央値 / p95 / p99 / 最大（ms） | 落ち（1.5×中央値超） | 最小の 1 秒 fps | 描画 CPU 中央値（ms） |
| --- | --- | --- | --- | --- |
| VRM | 16.7 / 17.0 / 17.2 / 17.8〜18.0 | 0 | 59 | 1.5〜1.6 |
| rb_fa03 | 16.7 / 17.0 / 17.2〜17.3 / 17.7〜18.7 | 0 | 59 | 0.4 |
| mpfb_ja | 16.7 / 17.0 / 17.2〜17.3 / 17.6〜17.7 | 0 | 59 | 0.5〜0.6 |

頂点数: VRM 709,490（67 プリミティブ）、rb_fa03 6,232（3 プリミティブ、モーフ 405）、mpfb_ja 24,086（8 プリミティブ、モーフ 135）。**60 Hz の表示の上限に当たっていて、モデルの差はフレーム時間には現れていません**。別の PC では測っていません（未測定）。

### 吸気の遅れ（描画まで）

`breath` の開始の呼び出しから、最初の描画フレームまでの時間（n=20／回、3 回）。これはページ内の呼び出しからの時間で、**WS で `breath.cue` を受け取ってからの実時間ではありません（WS 経路の遅れは未測定）**。

| モデル | 中央値（ms、3 回） | p95 | 胸の重みが +0.02 に達するまで（中央値） |
| --- | --- | --- | --- |
| VRM | 15.7 / 15.7 / 15.4 | 16.6〜17.1 | 82.2〜82.7 |
| rb_fa03 | 8.1 / 12.6 / 16.3 | 16.6〜16.8 | 75.1〜82.9 |
| mpfb_ja | 11.4 / 15.9 / 10.5 | 16.6〜16.8 | 77.8〜82.4 |

差は 1 フレーム（16.7 ms）の範囲です。

### 音声と VAP と ASR（同じ条件の会話 1 本ずつ、n=1）

合成音声のテスト入力（`tools/provider_probe/out/reading_roundtrip/el_ja__s*.wav` を連結した 58 秒の wav を Windows Chrome のフェイクマイクへ。実在の人の声は使っていません）、orchestrator の STT と TTS と LLM は test_double（描画の影響の比較が目的なので）。`--headless=new` と一時 `--user-data-dir`。GPU を使っていることを確認（ANGLE、AMD）。WS のプロキシで上りの音声フレームの到着間隔を測定。`none` は `?avatar=none`（描画なし）。loadavg（1 分）は 0.44〜2.84。

| 条件 | 上りのフレーム間隔 中央値 / p95 / p99 / 最大（ms） | frames_lost | 再生の underrun | VAP の RTF 中央値 / p95 | VAP の到着間隔 中央値 / p95 / 最大（ms） | 推論 中央値 / p95（ms） |
| --- | --- | --- | --- | --- | --- | --- |
| none | 18.20 / 43.50 / 44.22 / 60.56 | 0 | 0 | 0.439 / 0.530 | 77.42 / 83.04 / 120.0 | 29.22 / 37.35 |
| vrm | 18.26 / 43.45 / 44.08 / 75.81 | 0 | 0 | 0.418 / 0.467 | 77.41 / 81.84 / 117.4 | 30.23 / 33.53 |
| rb_fa03 | 18.23 / 43.44 / 44.12 / 75.68 | 0 | 0 | 0.413 / 0.451 | 77.70 / 82.34 / 130.8 | 29.48 / 32.87 |
| mpfb_ja | 18.60 / 43.54 / 44.15 / 56.93 | 0 | 0 | 0.436 / 0.526 | 77.70 / 82.60 / 146.9 | 30.29 / 36.64 |

間隔が 100 ms を超えたフレームは全条件で 0 でした。間隔の分布は送信側の 2 山です（中央値 18 ms と 43 ms 台）。worker 側の `frames_dropped_network` と `frames_dropped_overload` は全条件で 0。

ASR の照合（本番の STT、同じ 58 秒の合成音声を各 1 回、1 モデル 1 分以内）。誤りの比率は句読点と空白を除いた文字の編集距離 / 認識の文字数:

| モデル | 認識の文字数 | CER | 条件 |
| --- | --- | --- | --- |
| none | 299 | 0.161 | ウィンドウ（下の注意） |
| vrm | 151 | 0.113 | ウィンドウ、29 秒だけ（途中で止めた） |
| rb_fa03 | 296 | 0.159 | headless |
| mpfb_ja | 299 | 0.161 | headless |

**CER は n=1 で、none と vrm はウィンドウあり、後ろの 2 本は headless です**。同じ条件の比較にはなっていません。

### 未測定

- WS で `breath.cue` を受け取ってからの描画までの遅れ（ページ内の呼び出しから測定）
- `rb_chef01`、`rb_bf03`、`rb_ma09`、`rb_ma10`、`rb_bm02`、`mpfb_ja_m` の FPS と遅れ（候補の代表だけ測定）
- 別の GPU、別の PC
- 実音声のマイク入力での ASR（合成音声のみ）

## 7. 既定の VRM が変わっていないことの確認

- `npm run typecheck` と `npm run test:ts`: 合格（98 ファイル、3299 件）。
- `apps/web/src/avatar/browser_check/run.ts`（VRM の実物、WSL の SwiftShader）を、変更前の commit（f122d47 の一時コピー）と現在の作業ツリーで 1 回ずつ。どちらも SwiftShader の遅さで途中の `TimeoutError` で止まり（基準 20 項目、現在 23 項目まで）、全項目は完了していません。

| 項目（結果が false のもの） | 基準の commit | 現在 |
| --- | --- | --- |
| 対照: 何もしないときの画の変化が小さい | false（0.0167） | false（0.0267） |
| 口の開きで画が変わる | false（0.0103、対照 0.0167） | false（0.0327、対照 0.0267） |
| モデルが無いときに失敗を表示する | true | false（`public/models` に実物があるため。確認の前提の違い） |
| PCM を入れると口が動く（模擬の包絡） | false（max 0） | true（max 0.79） |

基準と現在で同じ 2 項目が false で、片方だけ false の 2 項目は上の理由の違いか 1 回ごとの揺れです（この 1 回の比較で言える範囲。VRM の見た目の同一性を画素で比較はしていません）。

## 8. 利用者が目で見る手順

1. `cd apps/web && npx next dev -p 3100`
2. http://localhost:3100/models/review/face_sheet.png を開いて候補を見る
3. http://localhost:3100/dev/avatar_compare?framing=face を開き、チェックボックスで候補を選ぶ。「発話まで」「延期して撤回」「吸気の途中で撤回」のボタンで動きを比べる（`?avatars=vrm,rb_fa03,mpfb_ja` で最初の並びを指定）
4. http://localhost:3100/?avatar=rb_fa03 で会話の画面（既定は VRM のまま）
5. 確認が済んだら `npx next dev` を止める

## 9. 限界

- 吸気の「自然さ」は判断していません（骨の移動量と画像だけ）。胸郭モーフの量は VRM の値のままで、Rocketbox と MakeHuman の体に合わせた調整はしていません。
- 視素と表情の重みは目視の暫定値です。
- FPS は 60 Hz の上限に当たっているので、余裕の差は描画 CPU の値しかありません。
- VRM の確認は §7 のとおり SwiftShader の途中までで、両方の失敗は環境依存の項目です（推測: ソフトウェア描画の速度）。
- 描画の測定（§6 の表）は一時の Chrome のウィンドウを Windows の画面に開いて行いました（`--headless=new` でも GPU は使われるが、ウィンドウの測定が済んだ後に確認したため）。会話の測定の一部（none と vrm の ASR）もウィンドウありです。
- 会話の測定は n=1 です。音声のフレーム間隔の差を統計的には見ていません。
