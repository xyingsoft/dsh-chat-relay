/**
 * 校验 vendored 的契约层未被就地修改。
 *
 * ## 为什么是 vendored 副本
 *
 * §41 明确 host 与 relay **独立升级**，因此协议定义必须能被两侧独立消费。
 * 正确的做法是把 `@dsh-chat/contract` 发布成包，两边都依赖发布物。
 *
 * 当前受限于凭证 —— 手上的 GitHub token 只有 `public_repo`，没有
 * `write:packages`，npm 也未登录。所以先用 vendored 副本，并用本脚本
 * 挡住「在这边偷偷改一行协议」这类漂移。
 *
 * 这不是权宜之计的托辞：`xyingsoft/dsh-chat` 仓库里 vendored DSH 运行时用的
 * 就是同一套机制（`scripts/verify-vendored-runtime.mjs`）—— 带外锚点 + 逐文件
 * 校验和。**发布成包仍然是目标**，见 README 的「已知未完成项」。
 *
 * ## 带外锚点
 *
 * 期望的校验和写在本文件里，而不是只写在 `contract.lock.json` 里。只放清单
 * 文件的话，改协议的人顺手重新生成一次清单就过了 —— 那样校验只能证明
 * 「清单和文件一致」，证明不了「文件没被改过」。
 *
 * 用法：
 *   node scripts/verify-contract.mjs          # 校验
 *   node scripts/verify-contract.mjs --update # 重新生成清单与锚点提示
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contractDir = join(repoRoot, 'src', 'contract')
const lockPath = join(repoRoot, 'contract.lock.json')

/**
 * 带外锚点：整个契约目录的聚合校验和。
 *
 * 改协议时**必须同时**更新这里和 `contract.lock.json`，且这一行要出现在
 * 代码评审的 diff 里 —— 那正是它的作用。
 */
const EXPECTED_AGGREGATE = 'cb36c98f1bd3e5c2a5a188e7155182ce466507fa285a5e3128e7e4403ae1c8e5'

/** 契约来源。改版本时连同校验和一起更新。 */
const SOURCE = {
  repository: 'https://github.com/xyingsoft/dsh-chat',
  path: 'packages/chat/contract/src',
}

function contractFiles() {
  return readdirSync(contractDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .sort()
}

function digestOf(name) {
  // 归一化换行：Windows 检出会把 LF 变成 CRLF，那不是协议变更
  const text = readFileSync(join(contractDir, name), 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function build() {
  const files = {}
  for (const name of contractFiles()) files[name] = digestOf(name)
  const aggregate = createHash('sha256')
    .update(
      Object.entries(files)
        .map(([name, digest]) => `${name} ${digest}`)
        .join('\n'),
      'utf8',
    )
    .digest('hex')
  return { source: SOURCE, files, aggregate }
}

const current = build()

if (process.argv.includes('--update')) {
  writeFileSync(lockPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  console.log(`已写入 ${lockPath}`)
  console.log(`\n把 verify-contract.mjs 里的 EXPECTED_AGGREGATE 改成：\n  '${current.aggregate}'\n`)
  console.log('两处都要改 —— 只改清单的话，带外锚点就失去意义了。')
  process.exit(0)
}

const problems = []

if (!existsSync(lockPath)) {
  problems.push(`缺少 ${lockPath}。先跑 node scripts/verify-contract.mjs --update`)
} else {
  const locked = JSON.parse(readFileSync(lockPath, 'utf8'))

  for (const [name, digest] of Object.entries(current.files)) {
    const expected = locked.files?.[name]
    if (expected === undefined) problems.push(`${name} 不在清单里 —— 契约层多出了一个文件`)
    else if (expected !== digest) problems.push(`${name} 与清单不符 —— 契约被就地修改`)
  }
  for (const name of Object.keys(locked.files ?? {})) {
    if (current.files[name] === undefined) problems.push(`${name} 在清单里但文件不存在`)
  }
  if (locked.aggregate !== current.aggregate) {
    problems.push('聚合校验和与清单不符')
  }
}

if (current.aggregate !== EXPECTED_AGGREGATE) {
  problems.push(
    `聚合校验和与带外锚点不符：\n    实际 ${current.aggregate}\n    锚点 ${EXPECTED_AGGREGATE}\n` +
      '    契约变更必须同步更新 verify-contract.mjs 中的 EXPECTED_AGGREGATE，' +
      '使其出现在评审 diff 里。',
  )
}

if (problems.length > 0) {
  console.error('契约校验未通过：')
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}

console.log(
  `契约校验通过：${Object.keys(current.files).length} 个文件，来源 ${SOURCE.repository}/${SOURCE.path}`,
)
