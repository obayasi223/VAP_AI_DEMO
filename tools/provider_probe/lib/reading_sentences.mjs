// Sentences for reading_roundtrip.mjs. kana is the intended reading, written by hand.
export const SENTENCES = [
  { id: 's01', group: '地名', kanji: '東京駅で待ち合わせしましょう', kana: 'とうきょうえきでまちあわせしましょう' },
  { id: 's02', group: '地名', kanji: '大阪の友達に会いに行きます', kana: 'おおさかのともだちにあいにいきます' },
  { id: 's03', group: '地名', kanji: '京都の金閣寺を見学しました', kana: 'きょうとのきんかくじをけんがくしました' },
  { id: 's04', group: '人名', kanji: '田中さんは山田先生の生徒です', kana: 'たなかさんはやまだせんせいのせいとです' },
  { id: 's05', group: '人名', kanji: '鈴木さんと公園を散歩しました', kana: 'すずきさんとこうえんをさんぽしました' },
  { id: 's06', group: '音訓', kanji: '明日の予定を確認します', kana: 'あしたのよていをかくにんします' },
  { id: 's07', group: '音訓', kanji: '生ビールを一杯ください', kana: 'なまびーるをいっぱいください' },
  { id: 's08', group: '音訓', kanji: '上手に話せましたか', kana: 'じょうずにはなせましたか' },
  { id: 's09', group: '音訓', kanji: '今日は大人と子供が来ます', kana: 'きょうはおとなとこどもがきます' },
  { id: 's10', group: '日中差', kanji: '手紙と切手を買いに行きます', kana: 'てがみときってをかいにいきます' },
  { id: 's11', group: '日中差', kanji: '大丈夫です、勉強は順調です', kana: 'だいじょうぶです、べんきょうはじゅんちょうです' },
  { id: 's12', group: '日中差', kanji: '新聞を読んでから料理します', kana: 'しんぶんをよんでからりょうりします' },
  { id: 's13', group: '数字', kanji: '三百円で買いました', kana: 'さんびゃくえんでかいました' },
  { id: 's14', group: '数字', kanji: '午後3時に2人で来ます', kana: 'ごごさんじにふたりできます' },
  { id: 's15', group: '英字', kanji: 'AIの話をしています', kana: 'えーあいのはなしをしています' },
];

// Fixed on 2026-11-08 before any synthesis, for the reading_tts experiment (README). Replies in the style of the
// dialogue system, written without looking at which words the risky rules would convert. kana is by hand.
export const SENTENCES_NEW = [
  { id: 'n01', group: '応答', kanji: '渋谷駅の近くに新しいお店ができました。', kana: 'しぶやえきのちかくにあたらしいおみせができました。' },
  { id: 'n02', group: '応答', kanji: 'それなら名古屋で一泊するのがいいですね。', kana: 'それならなごやでいっぱくするのがいいですね。' },
  { id: 'n03', group: '応答', kanji: '昨日は雨で、一日中家にいました。', kana: 'きのうはあめで、いちにちじゅういえにいました。' },
  { id: 'n04', group: '応答', kanji: 'お茶を二杯ほど飲みました。', kana: 'おちゃをにはいほどのみました。' },
  { id: 'n05', group: '応答', kanji: '午前十時に横浜で会いましょう。', kana: 'ごぜんじゅうじによこはまであいましょう。' },
  { id: 'n06', group: '応答', kanji: '佐藤さんは毎朝六時に起きるそうです。', kana: 'さとうさんはまいあさろくじにおきるそうです。' },
  { id: 'n07', group: '応答', kanji: 'その映画は二時間くらいでした。', kana: 'そのえいがはにじかんくらいでした。' },
  { id: 'n08', group: '応答', kanji: '上の階に会議室が三つあります。', kana: 'うえのかいにかいぎしつがみっつあります。' },
  { id: 'n09', group: '応答', kanji: '北海道の冬は本当に寒いですよ。', kana: 'ほっかいどうのふゆはほんとうにさむいですよ。' },
  { id: 'n10', group: '応答', kanji: '今年の夏は金沢へ行く予定です。', kana: 'ことしのなつはかなざわへいくよていです。' },
  { id: 'n11', group: '応答', kanji: '千五百円のお弁当を頼みました。', kana: 'せんごひゃくえんのおべんとうをたのみました。' },
  { id: 'n12', group: '応答', kanji: '風邪気味なので、今日は早めに寝ます。', kana: 'かぜぎみなので、きょうははやめにねます。' },
  { id: 'n13', group: '応答', kanji: '大きな荷物は一階で預かります。', kana: 'おおきなにもつはいっかいであずかります。' },
  { id: 'n14', group: '応答', kanji: '確かに、その方が分かりやすいですね。', kana: 'たしかに、そのほうがわかりやすいですね。' },
  { id: 'n15', group: '応答', kanji: '八百屋さんで野菜を買ってきました。', kana: 'やおやさんでやさいをかってきました。' },
];
