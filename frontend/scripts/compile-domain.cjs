/* eslint-disable */
// 极简 TS 运行器：转译 src/domain 与 data 层并解析 @ 别名，仅供行为验证脚本使用。
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync } = require('node:fs')
const { join, dirname } = require('node:path')
const os = require('node:os')
const ts = require('typescript')

const out = mkdtempSync(join(os.tmpdir(), 'plan-verify-'))
writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }))

function compile(file) {
  const src = readFileSync(file, 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const rel = file.replace(/^.*?\/src\//, '').replace(/\.ts$/, '.js')
  const target = join(out, rel)
  mkdirSync(dirname(target), { recursive: true })
  const depth = rel.split('/').length - 1
  const toRoot = '../'.repeat(depth)
  const rewritten = js
    .replace(/from '(@\/[^']+)'/g, (m, spec) => `from '${toRoot}${spec.slice(2)}.js'`)
    .replace(/from '(\.[^']*?)'/g, (m, spec) => (spec.endsWith('.js') ? m : `from '${spec}.js'`))
  writeFileSync(target, rewritten)
  return target
}

const files = [
  'src/domain/plan-types.ts',
  'src/domain/plan-status.ts',
  'src/domain/plan-service.ts',
  'src/domain/use-actor.ts',
  'src/data/types.ts',
  'src/data/modules.ts',
  'src/data/local-store.ts',
  'src/data/seed.ts',
]
const compiled = files.map((f) => compile(join(process.cwd(), f)))
console.log(join(out, 'domain', 'plan-service.js'))
console.log(join(out, 'domain', 'plan-status.js'))
