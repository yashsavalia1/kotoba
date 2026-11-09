// Yomitan-style deinflection: strip inflectional suffixes off a surface form to
// recover candidate dictionary forms. No morphological analyser, no dictionary
// of stems - just a rule table plus a bounded search. Garbage candidates are
// harmless because the dictionary lookup filters them out.
//
// A rule fires when the surface ends with `from` and the surface's current
// grammatical type is compatible with `formType`. The result takes `baseType`.
//   formType = what the INFLECTED string behaves as (so rules can chain)
//   baseType = what the DEINFLECTED result is
// '*' as baseType leaves the result unconstrained. '*' as formType means the
// rule only applies to an unconstrained string (the surface, or the result of
// another '*' rule): once a chain has committed to a class, only rules for that
// class may continue it, so 分からないでし cannot become 分からない via です.

const rules = [];
// `first` marks a rule that may only fire on the raw surface form, never as a
// later link in a chain. Single-kana strips (particles, the copula, the bare
// masu-stem) are real inflections but chaining them lets the scanner swallow
// arbitrary trailing kana - 素直にな would "deinflect" to 素直.
const R = (from, to, baseType, formType = '*', first = false) => {
  if (from) rules.push({ from, to, baseType, formType, first });
};

// ---------------------------------------------------------------- godan (v5)

// Column table: dictionary-final kana -> {a,i,e,o} rows and te/ta stems.
const GODAN = {
  う: { a: 'わ', i: 'い', e: 'え', o: 'お', te: 'って', ta: 'った' },
  つ: { a: 'た', i: 'ち', e: 'て', o: 'と', te: 'って', ta: 'った' },
  る: { a: 'ら', i: 'り', e: 'れ', o: 'ろ', te: 'って', ta: 'った' },
  ぬ: { a: 'な', i: 'に', e: 'ね', o: 'の', te: 'んで', ta: 'んだ' },
  ぶ: { a: 'ば', i: 'び', e: 'べ', o: 'ぼ', te: 'んで', ta: 'んだ' },
  む: { a: 'ま', i: 'み', e: 'め', o: 'も', te: 'んで', ta: 'んだ' },
  く: { a: 'か', i: 'き', e: 'け', o: 'こ', te: 'いて', ta: 'いた' },
  ぐ: { a: 'が', i: 'ぎ', e: 'げ', o: 'ご', te: 'いで', ta: 'いだ' },
  す: { a: 'さ', i: 'し', e: 'せ', o: 'そ', te: 'して', ta: 'した' },
};

for (const [end, r] of Object.entries(GODAN)) {
  R(r.a + 'ない', end, 'v5', 'adji');
  R(r.a + 'ん', end, 'v5');
  R(r.a + 'れる', end, 'v5', 'v1'); // passive
  R(r.a + 'せる', end, 'v5', 'v1'); // causative
  R(r.a + 'される', end, 'v5', 'v1'); // causative-passive
  R(r.i + 'ます', end, 'v5');
  R(r.i + 'ません', end, 'v5');
  R(r.i + 'ました', end, 'v5');
  R(r.i + 'ませんでした', end, 'v5');
  R(r.i + 'ましょう', end, 'v5');
  R(r.i + 'まして', end, 'v5');
  R(r.i + 'たい', end, 'v5', 'adji');
  R(r.i + 'たがる', end, 'v5', 'v5');
  R(r.i + 'そう', end, 'v5');
  R(r.i + 'すぎる', end, 'v5', 'v1');
  R(r.i + 'ながら', end, 'v5');
  R(r.i + 'に', end, 'v5');
  R(r.i, end, 'v5', '*', true); // bare masu-stem / nominalisation
  R(r.e + 'る', end, 'v5', 'v1'); // potential
  R(r.e + 'ば', end, 'v5');
  R(r.e, end, 'v5', '*', true); // imperative
  R(r.o + 'う', end, 'v5');
  R(r.ta, end, 'v5'); // plain past
  R(r.ta + 'ら', end, 'v5');
  R(r.ta + 'り', end, 'v5');
  R(r.te, end, 'v5', 'te');
}
// 行く is the one godan verb with an irregular te/ta stem.
R('行って', '行く', 'v5', 'te');
R('行った', '行く', 'v5');
R('いって', 'いく', 'v5', 'te');
R('いった', 'いく', 'v5');

// -------------------------------------------------------------- ichidan (v1)

for (const [from, base] of [
  ['ない', 'adji'], ['ん', '*'], ['ます', '*'], ['ません', '*'], ['ました', '*'],
  ['ませんでした', '*'], ['ましょう', '*'], ['まして', '*'], ['られる', 'v1'],
  ['させる', 'v1'], ['させられる', 'v1'], ['れる', 'v1'], ['た', '*'], ['たら', '*'],
  ['たり', '*'], ['て', 'te'],
  ['れば', '*'], ['よう', '*'], ['ろ', '*'], ['よ', '*'], ['たい', 'adji'],
  ['たがる', 'v5'], ['すぎる', 'v1'], ['そう', '*'], ['ながら', '*'],
]) {
  R(from, 'る', 'v1', base === 'adji' || base === 'te' || base === 'v1' || base === 'v5' ? base : '*');
}

// -------------------------------------------------------- suru / kuru (vs/vk)

for (const [from, to, ft] of [
  ['しない', 'する', 'adji'], ['します', 'する', '*'], ['しません', 'する', '*'],
  ['しました', 'する', '*'], ['しませんでした', 'する', '*'], ['しましょう', 'する', '*'],
  ['した', 'する', '*'], ['したら', 'する', '*'], ['して', 'する', 'te'],
  ['される', 'する', 'v1'], ['せず', 'する', '*'], ['せずに', 'する', '*'], ['させる', 'する', 'v1'],
  ['させられる', 'する', 'v1'], ['できる', 'する', 'v1'], ['しよう', 'する', '*'],
  ['すれば', 'する', '*'], ['しろ', 'する', '*'], ['せよ', 'する', '*'],
  ['したい', 'する', 'adji'], ['しすぎる', 'する', 'v1'], ['しながら', 'する', '*'],
  ['こない', 'くる', 'adji'], ['きます', 'くる', '*'], ['きません', 'くる', '*'],
  ['きた', 'くる', '*'], ['きて', 'くる', 'te'], ['こられる', 'くる', 'v1'],
  ['こさせる', 'くる', 'v1'], ['こよう', 'くる', '*'], ['くれば', 'くる', '*'],
  ['こい', 'くる', '*'], ['きたい', 'くる', 'adji'],
  ['来ない', '来る', 'adji'], ['来ます', '来る', '*'], ['来ました', '来る', '*'],
  ['来た', '来る', '*'], ['来て', '来る', 'te'], ['来られる', '来る', 'v1'],
  ['来させる', '来る', 'v1'], ['来よう', '来る', '*'], ['来れば', '来る', '*'],
  ['来い', '来る', '*'], ['来たい', '来る', 'adji'],
]) {
  R(from, to, from.endsWith('する') || to === 'する' ? 'vs' : 'vk', ft);
}

// ------------------------------------------------------------- i-adjectives

for (const [from, to, ft] of [
  ['かった', 'い', '*'], ['くない', 'い', 'adji'], ['くて', 'い', 'te'],
  ['ければ', 'い', '*'], ['すぎる', 'い', 'v1'], ['さ', 'い', '*'],
  ['そう', 'い', '*'], ['く', 'い', '*'], ['み', 'い', '*'],
  ['がる', 'い', 'v5'], ['げ', 'い', '*'],
]) {
  R(from, to, 'adji', ft);
}
// いい / よい suppletion: 良かった, よくない.
R('よかった', 'いい', 'adji');
R('よくない', 'いい', 'adji', 'adji');
R('よくて', 'いい', 'adji', 'te');
R('良かった', '良い', 'adji');

// ------------------------------- te-form continuations (chain into 'te' type)

for (const t of ['て', 'で']) {
  for (const [suffix, ft] of [
    ['いる', 'v1'], ['いる', 'v1'], ['る', 'v1'], ['います', '*'], ['いた', '*'],
    ['いない', 'adji'], ['ない', 'adji'], ['しまう', 'v5'], ['しまった', '*'],
    ['おく', 'v5'], ['ある', 'v5'], ['みる', 'v1'], ['いく', 'v5'], ['くる', 'vk'],
    ['もらう', 'v5'], ['くれる', 'v1'], ['あげる', 'v1'], ['ほしい', 'adji'],
    ['は', '*'], ['も', '*'], ['から', '*'],
  ]) {
    R(t + suffix, t, 'te', ft);
  }
}
// Spoken contractions, rewritten to the full form so the rules above finish the
// job: 言っちゃった -> 言っちゃう -> 言ってしまう, 書いとく -> 書いておく, 食べちゃ -> 食べては.
R('ちゃう', 'てしまう', 'v5', 'v5');
R('じゃう', 'でしまう', 'v5', 'v5');
R('とく', 'ておく', 'v5', 'v5');
R('どく', 'でおく', 'v5', 'v5');
R('ちゃ', 'ては', '*');
R('じゃ', 'では', '*');

// ------------------------------------------- copula / noun-attached politeness

for (const [from, to, ft] of [
  ['です', '', '*'], ['でした', '', '*'], ['である', '', 'v5'], ['だった', '', '*'],
  ['じゃない', '', 'adji'], ['ではない', '', 'adji'], ['じゃなかった', '', '*'],
  ['ではありません', '', '*'], ['じゃありません', '', '*'], ['なら', '', '*'], ['っす', '', '*'],
]) {
  R(from, to, '*', ft);
}
// A bare particle or copula only folds into the word it follows when that word
// is the kind it inflects: 素直に, 静かな, 本当の, ゆっくりと. 教科書に and 私と
// stay two tokens.
for (const [from, base] of [['だ', 'adjna'], ['な', 'adjna'], ['に', 'adjna'], ['で', 'adjna'], ['と', 'advto'], ['の', 'adjno']]) {
  R(from, '', base, '*', true);
}
// Negative-past on any ない-ending form: 行かなかった -> 行かない.
R('なかった', 'ない', 'adji');
R('なくて', 'ない', 'te');
R('なければ', 'ない', '*');
R('なきゃ', 'ない', '*');
R('なくちゃ', 'ない', 'adji');
R('なくっちゃ', 'ない', 'adji');
R('なくては', 'ない', 'adji');
R('なくても', 'ない', 'adji');
R('ないで', 'ない', 'adji');
R('ず', 'ない', '*');
R('ずに', 'ない', 'adji');

const MAX_DEPTH = 6;

/**
 * @param {string} surface
 * @returns {{text: string, type: string|null}[]} candidate dictionary forms,
 *   surface first. `type` is the grammatical class the candidate must belong to
 *   for the deinflection to have been valid; null means unconstrained.
 */
export function deinflect(surface) {
  const seen = new Map([[surface + '\0', 0]]);
  const out = [{ text: surface, type: null }];
  let frontier = [{ text: surface, type: null, depth: 0 }];

  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      if (node.depth >= MAX_DEPTH) continue;
      for (const rule of rules) {
        if (rule.first && node.depth > 0) continue;
        if (node.type !== null && node.type !== rule.formType) continue;
        if (!node.text.endsWith(rule.from)) continue;
        const stem = node.text.slice(0, node.text.length - rule.from.length);
        const text = stem + rule.to;
        if (!text) continue; // a rule may consume the whole word (して -> する)
        if (text === node.text) continue;
        const type = rule.baseType === '*' ? null : rule.baseType;
        const key = text + '\0' + (type ?? '');
        if (seen.has(key)) continue;
        seen.set(key, node.depth + 1);
        out.push({ text, type });
        next.push({ text, type, depth: node.depth + 1 });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Does a dictionary entry's part-of-speech list permit it to be the base of a
 * deinflection that produced grammatical class `type`? This is what stops
 * った -> う from resolving to 兎 (a noun that happens to be read う).
 */
export function posAllows(type, pos) {
  switch (type) {
    case null:
    case undefined:
      return true;
    case 'v1':
      return pos.some((p) => p === 'v1' || p === 'v1-s');
    case 'v5':
      return pos.some((p) => p.startsWith('v5') || p === 'v4r');
    case 'vs':
      return pos.some((p) => p.startsWith('vs'));
    case 'vk':
      return pos.includes('vk');
    case 'adji':
      return pos.some((p) => p === 'adj-i' || p === 'adj-ix');
    case 'adjna':
      return pos.includes('adj-na');
    case 'adjno':
      return pos.includes('adj-no');
    case 'advto':
      return pos.includes('adv-to');
    case 'te':
      return false; // a te-form is never itself a dictionary headword
    default:
      return true;
  }
}

export const _rulesCount = rules.length;
