# 発話前の吸気（breath.ts）の文献の裏取り

- 調査日: 2026-11-08
- 対象: `apps/web/src/avatar/breath.ts`（2026-11-08 16:21 時点の内容。別の担当が編集中のため、行番号はずれることがある）
- 結論: 出典はすべて実在し、書誌と数値に誤りは無い。問題は当てはめ方にある。特に、withdrawn の根拠は対象の条件が違い、「聞き手の呼吸へ戻る」は原典より強い表現である。

## 確認の水準

| 水準 | 意味 |
|---|---|
| 本文 | 論文の本文で該当の記述を確認した |
| 要旨のみ | 要旨だけを読んだ |
| 未確認 | 確認できなかった |
| 誤り | 確認の結果、コードの記述が原典と合わない |

本文の読み方は論文で異なる。

- Torreira、Włodarczak、Krause は Frontiers の PDF からテキストを取り出し、数値と該当文を直接照合した。
- Rochet-Capellan & Fuchs は PMC の本文を Web 取得ツールの抜粋で読んだ（生の PDF は取得できなかった）。引用と Table 1 の数値は抜粋からの転記なので、論文に載せる前に原文で照合してほしい。

## 表

| # | 主張 | 出典 | 確認の水準 | 原典の値と条件 | コードの反映先 | 修正の提案 |
|---|---|---|---|---|---|---|
| 1 | 成功した turn は吸気の直後に始まり、呼気の始めで声が出る | Rochet-Capellan, A. & Fuchs, S. (2014). Take a breath and take the turn: how breathing meets turns in spontaneous dialogue. *Phil. Trans. R. Soc. B* 369(1658):20130399. https://doi.org/10.1098/rstb.2013.0399 / https://pmc.ncbi.nlm.nih.gov/articles/PMC4240966 | 本文。正しい | 要旨: "Most of the smooth and interrupted turns were taken just after an inhalation"。呼気の最初の 25% で始まる割合は、smooth 65%、interruption 67〜68%（Table 1）。「すべて」ではなく「大半」。ドイツ語母語の女性 11 名、相手は研究室の 2 名（第二著者を含む）、各相手と約 2.5 分の自由会話を 5 回 | 5〜7 行（speech_started の説明）、`speechMouthYieldMs` | 引用はこのままでよい。ただし原典は吸気と発話の間の保持を扱っていない。コードの「保持を経て発話」する経路（`holdMaxMs`）は、この文献の根拠の外にあると書き添える |
| 2 | 失敗した試みは 1 呼吸の中で終わる | 同上 | 本文。対象の条件が違う | "Butting-in attempts were always realized on a single breathing cycle."。butting-in は「割り込もうとして失敗した」発話で、**声は出ている**。呼気の後半（位置 > 0.5）で始まる割合は約 29%（smooth 17%、interruption 16%）。新しい吸気なしの割り込みは失敗しやすいと考察している。また smooth と interruption も半数超が 1 呼吸周期で実現されており、失敗に固有の特徴ではない | 13 行（withdrawn の説明） | withdrawn は「吸気の後に声を出さずにやめる」動きであり、原典の場面と違う。声を出した試みの観察だと明記する。声を出さない場面に近いのは #4 |
| 3 | 失敗すると聞き手の呼吸へ早く戻る | 同上 | 誤り（原典より強い表現） | 原典は「呼吸周期が短くなった」と報告し（"When butting-in, breathing cycles were shorter than for smooth or interruption turns"、統計量のみで ms の値は無い）、そこから "quickly reverted to a listener role" と解釈している。戻るのは「聞き手の**役割**」であり、呼吸が聞き手の型へ戻ったという測定は無い | 13 行、`withdrawnExhaleMs`（750、176 行付近）、`withdrawnMouthCloseMs` | 「聞き手の呼吸へ早く戻る」を「呼吸周期が成功時より短く、著者は聞き手の役割へ早く戻ると解釈」に直す。原典に ms の値は無いので 750 は暫定のまま。deferred（1300）より速くする根拠も文献には無い |
| 4 | 発声しない吸気の後に約 500ms 息を止め、声を出さずに吐く | Wlodarczak, M. & Heldner, M. (2020). Breathing in Conversation. *Front. Psychol.* 11:575566. https://doi.org/10.3389/fpsyg.2020.575566 | 本文。値は 1 事例 | 約 500ms は **図 8 の 1 例の説明**（"holding their breath for about 500 ms right after the inhalation offset and exhaling without producing any speech"）で、代表値ではない。検出の最短の設定は 250ms。候補は 221 周期（比較した保持なしの無声周期は 6,121）で、話者・会話あたり 5 回を超えることは少ない。「断念した発話」は著者の解釈で "potentially" "might" と留保がある。候補の判定（呼気の振幅の上位 20%）は著者自身が恣意的と認めている。スウェーデン語とエストニア語の 3 人の自由会話、立位、18 会話、各約 20 分 | 10 行（deferred の説明）。現行の `HOLD_MAX_MS`（56 行、1800）からはこの引用が外れた | 「約 500ms（図 8 の 1 例）」と書く。「割り込まれて断念した候補」と「引き下がり」の対応は設計上の解釈だと明記する。原典は deferred と withdrawn を区別しないので、withdrawn の根拠にもなり得る |
| 5 | 話す準備の口の形を、話す機会まで保つ | Krause, P. A. & Kawamoto, A. H. (2021). Predicting One's Turn With Both Body and Mind: Anticipatory Speech Postures During Dyadic Conversation. *Front. Psychol.* 12:684248. https://doi.org/10.3389/fpsyg.2021.684248 | 本文。対象の条件が違う | 唇音や円唇母音で始まる発話では、音の前から唇の面積が小さい。1〜3 語の短い発話では最大 3,000ms 前から現れる。分析は**実際に話した発話**の音の開始から遡る 90 フレームのみで、引き下がった後の口の形は対象外。形は音に固有で、「わずかに開く」一般的な構えではない。「作って保つ（formed and maintained）」の記述は、先行の遅延命名の実験（Kawamoto et al. 2014、Tilsen et al. 2016）の紹介である。英語、男性 6 名、8 組、各 5 分の自由会話、30fps の動画 | 9〜11 行（deferred の説明）、`deferredMouthResidual`（0.4、173 行付近） | 引用に年（2021）を足す。「音の前に唇の構えが現れる。話さずに引き下がった場合は未検証」に直す。aa を残す形の根拠にはならないので、残す形そのものを暫定とする |
| 6 | 答えの前の吸気の中央値 0.72s、平均 0.887s | Torreira, F., Bögels, S. & Levinson, S. C. (2015). Breathing for answering: the time course of response planning in conversation. *Front. Psychol.* 6:284. https://doi.org/10.3389/fpsyg.2015.00284 | 本文。正しい | "inbreath duration (in seconds; mean = 0.887 s, median = 0.72 s)"。答えの前に吸気があった 91 件（質問と答えの組 171 件の 53.2%）。オランダ語、男性の友人 7 組、着席の自由会話、各約 45 分。吸気は呼吸帯の信号の立ち上がりで測定 | 49〜50 行 `DEFAULT_INHALE_MS`（700）、`config/policy.ja.json` の `inhale_ms`（700） | 値はこのままでよい。ただし「質問への答え」の値であり、AI が自分から申し出る場面に当てはめていると書き添える。原典は吸気の長さと答えの長さの関係を見いだしていない |
| 7 | 吸気の最短は 210ms | 同上 | 本文。正しい（コードの値と 10ms の差） | "the minimum inbreath duration in our data was 210 ms"。91 件の標本の最小値で、生理的な下限ではない | 57〜58 行 `INHALE_MS_RANGE`（[200, 1400]） | コメントの「合わせた」を「標本の最小 210ms を丸めた」に直す。上限 1400 に出典は無いので暫定と書く |
| 8 | 顎の発話前の静止位置は音の約 250ms 前（実験室の課題） | Hamlet, S. L., Stone, M., Cullison, B. & Schoner, L. (1978). Further observations on speech preparatory activity of the jaw. *J. Acoust. Soc. Am.* 63(S1):S33（学会要旨）. https://doi.org/10.1121/1.2016606 ※コードに著者名が無く、内容の一致からの推定 | 要旨のみ。値は正しいが意味が違う | "on the order of 250 ms before acoustical speech onset"。静止位置は「最初の音の位置へ動き出す前の、最後の速度 0 の点」。つまり 250ms は**静止点から音までの間隔**で、準備の動作にかかる長さではない。単語と文の発話、厚さ 2 種の歯科用補綴を装着、ひずみゲージで計測。人数と分散は要旨に無い | 124〜125 行と 178 行 `shortPrepMs`（250） | 出典を明記する。コメントを「静止点から音までの間隔。動作の長さの根拠ではない。250 は暫定」に直す。実際の経路は `DEFERRED_SPEECH_PREP_MS`（150、`apps/web/src/session/participant.ts` 44 行）を渡しており、既定の 250 は通らない |

## 調査の範囲と限界

- 会話を扱う 4 件はどれも日本語ではない（ドイツ語、スウェーデン語とエストニア語、英語、オランダ語）。#8 の要旨に言語の記載は無い。参加者が単一の性別のものがある（#1 は女性、#5 と #6 は男性）。
- 5 行の「文献の対応は docs ではなく報告に載せた」は、本ファイルを指すように直すとよい。
- コードが自ら「暫定」「未確認」とした値は、対象外とした（`INHALE_TIMING`、`RELAX_TIMING`、`SPEECH_TIMING_MS`、`deferred` の残す量と長さ、`HOLD_MAX_MS`）。
- #8 の Hamlet らの要旨は Crossref の登録から読んだ。出版社のページは確認していない。
