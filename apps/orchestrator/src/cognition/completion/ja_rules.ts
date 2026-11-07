/**
 * 代替 A: 日本語の文末形態によるターン完了の推定（計画 §4.4）。TurnGPT の再現ではない。
 *
 * p は確率として校正していない順序尺度で、値は規則の段（TIER）で決まる。TurnGPT の p とは比べない。
 * ASR の途中文を想定し、句読点は使わない（末尾の句読点は revision ごとに変動する。計画 §1.1）。
 * 履歴は「直前の相手の発話が質問か」だけを見る。
 */
import { absent, present } from '@llm-vap/contracts';
import type { HistoryEntryRef, TurnCompletionEstimate, TurnCompletionEstimator } from '@llm-vap/contracts';

export const JA_RULES_ESTIMATOR = 'ja_rules_v1';

const TIER = {
  filler: 0.03,
  connective: 0.05,
  incomplete: 0.1,
  connective_kedo: 0.15,
  unknown: 0.15,
  preface: 0.35,
  dictionary_form: 0.45,
  plain_predicate: 0.5,
  explanatory: 0.5,
  soft_particle: 0.6,
  polite_predicate: 0.65,
  plain_question: 0.7,
  final_particle: 0.75,
  answer: 0.75,
  acknowledge: 0.85,
  closing: 0.9,
  question: 0.9,
} as const;

const WH = /何|なに|なん[でて]|どこ|どれ|どの|どっち|どちら|いつ|だれ|誰|どう|いくら|なぜ/;

interface Rule {
  cue: string;
  re: RegExp;
  p: number;
}

/** 先に一致したものを使う。順序に意味がある。 */
const RULES: readonly Rule[] = [
  // 言いよどみと、続きを導く副詞
  { cue: 'filler', re: /(えっと|えーと|ええと|あの|あのね|その|まあ|うーん|なんか)$/, p: TIER.filler },
  {
    cue: 'discourse_adverb',
    re: /(だから|それで|そして|でも|でもね|それでね|ただ|しかし|つまり|やっぱり|たぶん|まず|最初に|例えば|たとえば|あと|要するに)$/,
    p: TIER.connective,
  },
  // 閉じる定型句と応答
  {
    cue: 'closing',
    re: /(ありがとう(ございます|ございました)?|お疲れ様(です|でした)?|おつかれさま(です|でした)?|以上です|失礼します|失礼しました|よろしくお願いします|また明日ね?|じゃあね|さようなら)$/,
    p: TIER.closing,
  },
  {
    cue: 'acknowledge',
    re: /(わかりました|分かりました|了解(です|しました)?|承知しました|^(はい|うん|ええ|いいえ|そう|そうです|そうですね))$/,
    p: TIER.acknowledge,
  },
  // 「か」で終わるが質問でないもの
  { cue: 'not_question_ka', re: /(とか|なんか|何か|どこか|誰か|いつか|確か|たしか|しか)$/, p: TIER.incomplete },
  { cue: 'question', re: /(か|かな|かしら)$/, p: TIER.question },
  // 接続助詞などの直後の文末助詞は、話が続く印（「混んでてさ」「でね」）
  { cue: 'connective_plus_particle', re: /(て|で|が|けど|から)[ねさ]$/, p: TIER.incomplete },
  { cue: 'final_particle', re: /(ね|よ|よね|だな|よな|ねえ)$/, p: TIER.final_particle },
  { cue: 'soft_particle', re: /(さ|わ|ぞ|ぜ|もん|[いた]な)$/, p: TIER.soft_particle },
  // 「の」: 活用語の後なら質問や説明、名詞の後なら連体
  { cue: 'plain_question_no', re: /[たっだんるう]の$/, p: TIER.plain_question },
  // 予告と列挙（文法的には終わるが続きがある型）
  {
    cue: 'announcement',
    re: /((話|理由|点|こと|お願い|相談|質問|問題)が([一二三四五六七八九十\d]+つ)?|[一二三四五六七八九十\d]+つ)(あります|あるんです)$/,
    p: TIER.preface,
  },
  { cue: 'story_preface', re: /^(聞いてください|聞いて|実は|じつは)|あったんです$/, p: TIER.preface },
  { cue: 'enumeration', re: /^(まず|最初に|はじめに|一つ目|第一に|結論から)/, p: TIER.preface },
  // 接続助詞
  { cue: 'connective_kedo', re: /(けど|けれど|けれども)$/, p: TIER.connective_kedo },
  {
    cue: 'connective',
    re: /(ので|のに|から|ても|でも|たら|なら|れば|ければ|ながら|つつ|ために|ため|たり|ように|とき|[^\d一二三四五六七八九十何]時|前に|後で|うちに|場合|として|について|によると|って|という|ですが|ますが|ましたが|だが|たが|[だすたい]し)$/,
    p: TIER.connective,
  },
  { cue: 'te_form', re: /[てで]$/, p: TIER.incomplete },
  { cue: 'particle', re: /([はがをにへともやの]|まで|より|など|くらい|ぐらい|ほど|だけ|ばかり)$/, p: TIER.incomplete },
  // 述語
  { cue: 'explanatory', re: /(んです|のです|んだ)$/, p: TIER.explanatory },
  {
    cue: 'polite_predicate',
    re: /(です|ます|ました|ません|ませんでした|でした|ましょう|でしょう|だろう|ください|下さい|ございます)$/,
    p: TIER.polite_predicate,
  },
  // 述語に見える名詞や副詞を先に除く
  { cue: 'not_predicate', re: /(また|まだ|あなた|かなた|だいたい|きれい|せい|あい)$/, p: TIER.unknown },
  { cue: 'plain_predicate', re: /(だ|た|ない|なかった|かった|たい|い)$/, p: TIER.plain_predicate },
  { cue: 'dictionary_form', re: /る$/, p: TIER.dictionary_form },
];

/** 句読点、空白、長音の引き延ばしを除く。 */
export function normalizePartial(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .replace(/ー+$/u, '');
}

const QUESTION_END = /(か|かな|の)$/;

export interface JaRuleScore {
  p: number;
  cue: string;
}

/** 空の入力は呼び出し側で扱う。 */
export function scoreJaRules(history: readonly HistoryEntryRef[], partial: string): JaRuleScore {
  const text = normalizePartial(partial);
  let score: JaRuleScore = { p: TIER.unknown, cue: 'unknown' };
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      score = { p: rule.p, cue: rule.cue };
      break;
    }
  }
  const isPredicate = score.p >= TIER.dictionary_form && score.p < TIER.plain_question;
  if (isPredicate && WH.test(text) && score.p < TIER.plain_question) {
    score = { p: TIER.plain_question, cue: `${score.cue}+wh` };
  }
  const lastOther = [...history].reverse().find((entry) => entry.role === 'assistant');
  if (
    isPredicate &&
    score.p < TIER.answer &&
    lastOther &&
    QUESTION_END.test(normalizePartial(lastOther.text))
  ) {
    score = { p: TIER.answer, cue: `${score.cue}+answers_question` };
  }
  return score;
}

export class JaRulesTurnCompletionEstimator implements TurnCompletionEstimator {
  readonly name = JA_RULES_ESTIMATOR;

  async estimate(history: readonly HistoryEntryRef[], partial: string): Promise<TurnCompletionEstimate> {
    if (normalizePartial(partial) === '') {
      return { p: absent('empty_partial'), estimator: this.name };
    }
    return { p: present(scoreJaRules(history, partial).p), estimator: this.name };
  }
}
