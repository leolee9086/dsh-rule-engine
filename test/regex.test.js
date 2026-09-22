import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RegexProvider, regexFromString, runRegexScript, sanitizeRegexMacro, filterString, isRegexLiteral,
  SUBSTITUTE_FIND_REGEX,
} from '../lib/regex.js'

test('正则字符串：/pattern/flags 与裸 pattern 都能编译', () => {
  const withFlags = regexFromString('/(a+)(b)/gi')
  assert.equal(withFlags.source, '(a+)(b)')
  assert.equal(withFlags.flags, 'gi')

  const bare = regexFromString('abc')
  assert.equal(bare.source, 'abc')
  assert.equal(bare.flags, '')
})

test('编译不出来时返回 null，不猜它本来想干什么', () => {
  assert.equal(regexFromString('/(/'), null)
  assert.equal(regexFromString(''), null)
  // 酒馆在 flag 非法时会退回「把整个输入当 pattern」，于是 /a/z 悄悄变成匹配 a/z 的正则。
  // 这里不跟：flag 非法就是写错了。
  assert.equal(regexFromString('/a/z'), null)
  assert.equal(regexFromString('/(a)/z'), null)
  assert.throws(() => regexFromString(123), TypeError)
})

test('isRegexLiteral 区分 /.../ 写法与裸子串', () => {
  assert.equal(isRegexLiteral('/a.c/'), true)
  assert.equal(isRegexLiteral('/a/gi'), true)
  assert.equal(isRegexLiteral('a.c'), false)
  assert.equal(isRegexLiteral(''), false)
})

test('替换语法：$1 / $<name> / {{match}}', () => {
  assert.equal(runRegexScript({ findRegex: '/a(b)/', replaceString: '[$1]' }, 'xaby'), 'x[b]y')
  assert.equal(runRegexScript({ findRegex: '/(?<tail>b)/', replaceString: '<$<tail>>' }, 'xaby'), 'xa<b>y')
  assert.equal(runRegexScript({ findRegex: '/ab/', replaceString: '{{match}}!' }, 'xaby'), 'xab!y')
  // 取不到的占位符换成空串，而不是留下字面量。
  assert.equal(runRegexScript({ findRegex: '/(a)(b)?/', replaceString: '[$2]' }, 'ax'), '[]x')
})

test('global 正则会替换每一处，并且复用前会重置 lastIndex', () => {
  const script = { findRegex: '/a/g', replaceString: 'A' }
  assert.equal(runRegexScript(script, 'aaa'), 'AAA')
  // 同一个正则对象被复用第二次时不能从中间开始。
  assert.equal(runRegexScript(script, 'aaa'), 'AAA')
})

test('trimStrings：先匹配一大块，再去掉里面不要的串', () => {
  const script = { findRegex: '/(ab)/', replaceString: '<$1>', trimStrings: ['b'] }
  assert.equal(runRegexScript(script, 'xaby'), 'x<a>y')
})

test('宏替换：替换结果里出现的宏也要能用', () => {
  const macros = text => text.replaceAll('{{user}}', '织')
  assert.equal(runRegexScript({ findRegex: '/hi/', replaceString: '{{user}}!' }, 'hi', { macros }), '织!')
})

test('substituteRegex：RAW 不转义宏值，ESCAPED 转义', () => {
  const macros = (text, transform) => text.replaceAll('{{q}}', transform ? transform('a.b') : 'a.b')
  const raw = { findRegex: '/{{q}}/', replaceString: 'X', substituteRegex: SUBSTITUTE_FIND_REGEX.RAW }
  const escaped = { findRegex: '/{{q}}/', replaceString: 'X', substituteRegex: SUBSTITUTE_FIND_REGEX.ESCAPED }
  // RAW：宏值 a.b 里的点仍然是通配符，所以 axb 也命中。
  assert.equal(runRegexScript(raw, 'axb', { macros }), 'X')
  // ESCAPED：点被转义成字面点，只有 a.b 命中。
  assert.equal(runRegexScript(escaped, 'axb', { macros }), 'X'.replace('X', 'axb'))
  assert.equal(runRegexScript(escaped, 'a.b', { macros }), 'X')
})

test('substituteRegex 是没见过的值时抛错，不悄悄按 NONE 处理', () => {
  assert.throws(
    () => runRegexScript({ findRegex: '/a/', replaceString: 'b', substituteRegex: 9 }, 'a'),
    /unknown substituteRegex/,
  )
})

test('sanitizeRegexMacro 把宏值变成能匹配字面量的正则', () => {
  // 这才是这个函数的意义：宏的值是普通文本，不该被当成正则。
  for (const raw of ['a.b*c', '换\n行', 'a(b)[c]']) {
    const escaped = sanitizeRegexMacro(raw)
    assert.equal(new RegExp('^' + escaped + '$').test(raw), true)
    assert.equal(new RegExp('^' + escaped + '$').test(raw + 'x'), false)
  }
  assert.throws(() => sanitizeRegexMacro(undefined), TypeError)
})

test('runRegexScript 对说不清楚的输入直接抛错', () => {
  assert.throws(() => runRegexScript({ findRegex: '/a/', replaceString: 'b' }, 123), TypeError)
  // 正则编译不出来是写坏了，不是「没命中」。
  assert.throws(() => runRegexScript({ findRegex: '/(/', replaceString: 'x' }, 'a'), /not a valid regex/)
  // replaceString 省略和空串是两回事：省略是没说，空串是换成空。
  assert.throws(() => runRegexScript({ findRegex: '/a/' }, 'a'), /replaceString/)
  assert.equal(runRegexScript({ findRegex: '/a/', replaceString: '' }, 'a'), '')
  assert.throws(() => runRegexScript(null, 'a'), TypeError)
})

test('filterString 剔掉多个串；空串是写错了', () => {
  assert.equal(filterString('abcdef', ['b', 'd']), 'acef')
  assert.equal(filterString('abc', undefined), 'abc')
  assert.throws(() => filterString('abc', ['']), /empty string/)
  assert.throws(() => filterString('abc', [1]), TypeError)
  assert.throws(() => filterString(123, []), TypeError)
})

test('RegexProvider：命中返回同一个对象，满容量淘汰最久没用的', () => {
  const provider = new RegexProvider(2)
  const first = provider.get('/a/')
  assert.equal(provider.get('/a/'), first)
  provider.get('/b/')
  provider.get('/c/')
  assert.equal(provider.size, 2)
  // /a/ 已经被淘汰，重新编译会得到新对象。
  assert.notEqual(provider.get('/a/'), first)
})

test('RegexProvider：编译不出来返回 null，并且不写进缓存', () => {
  const provider = new RegexProvider()
  assert.equal(provider.get('/(/'), null)
  assert.equal(provider.size, 0)
  assert.throws(() => provider.get(123), TypeError)
})

test('disabled 的规则不生效，但 disabled 必须是布尔', () => {
  assert.equal(runRegexScript({ findRegex: '/a/', replaceString: 'b', disabled: true }, 'a'), 'a')
  assert.throws(() => runRegexScript({ findRegex: '/a/', replaceString: 'b', disabled: 'yes' }, 'a'), TypeError)
})
