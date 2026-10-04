/* eslint-disable */
// 领域逻辑行为验证：用 typescript 转译到临时目录后在 Node 中跑，不进入产物。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// 在引入存储层前伪造浏览器 localStorage，让数据落在内存 Map 里。
const memory = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  },
}

const [svcPath, corePath] = execFileSync('node', ['scripts/compile-domain.cjs'], { encoding: 'utf8' }).trim().split('\n')
const svc = await import(svcPath)
const { deriveGroups } = await import(corePath)
const {
  migratePlanData,
  createPlan,
  executePlanAction,
  registerCalibrationFromPlan,
  completeReview,
  listReviews,
} = svc
const STORAGE_KEY = 'hydrology-monitor-station:entries'

const editor = { name: '张三', role: '编制人' }
const approver = { name: '李四', role: '审批人' }

function snapshot() {
  return JSON.parse(memory.get(STORAGE_KEY))
}
function plans() {
  return snapshot().plan
}
function groups(actor = approver) {
  return deriveGroups(plans(), listReviews(), actor)
}

// 1. 迁移：种子「待审批」abnormal 被清除，废止残留 pending 会被回算。
migratePlanData()
assert.ok(plans().every((p) => p.abnormal === false), '迁移后不应有异常标记残留')

// 旧版「已修订」状态归一为「已批准」，并回填版本号/组号，老数据只读兼容。
assert.ok(plans().every((p) => Number(p['版本号']) >= 1), '所有方案应回填版本号')
assert.ok(plans().every((p) => typeof p['方案组号'] === 'string' && p['方案组号']), '所有方案应回填组号')
{
  const { normalizeStatus } = await import(corePath)
  assert.equal(normalizeStatus('已修订'), '已批准')
  assert.equal(normalizeStatus('未知状态'), '编制中')
}

// 2. 登记 → 提交 → 批准：结论全链路同源。
const created = createPlan(
  { 方案名称: '汛期方案', 适用范围: '干流', 监测项目: '水位', 测次安排: '两段制', 编制人: '张三' },
  editor,
)
assert.ok(created.ok)
const groupCode = plans().at(-1)['方案组号']
let g = groups().find((x) => x.group === groupCode)
assert.equal(g.conclusion, '尚未提交审批')
assert.equal(g.pending, false)

assert.equal((await executePlanAction({ group: groupCode, action: '提交审批', actor: editor })).ok, true)
g = groups().find((x) => x.group === groupCode)
assert.equal(g.latest.record.status, '待审批')
assert.equal(g.pending, true, '待审批应计入待办')

// 3. 越级批准：编制人身份被拒绝；自批被拒绝。
let denied = await executePlanAction({ group: groupCode, action: '批准方案', actor: editor })
assert.equal(denied.ok, false)
assert.match(denied.message, /审批权限/)

const selfSubmit = { name: '张三', role: '审批人' }
denied = await executePlanAction({ group: groupCode, action: '批准方案', actor: selfSubmit })
assert.equal(denied.ok, false)
assert.match(denied.message, /同一人/)

// 合法批准
assert.equal((await executePlanAction({ group: groupCode, action: '批准方案', actor: approver })).ok, true)
g = groups().find((x) => x.group === groupCode)
assert.equal(g.conclusion, '批准生效')
assert.equal(g.pending, false, '批准后待审批待办必须消失')
assert.equal(g.latest.record['批准人'], '李四')

// 4. 并发重复提交/批准：同时触发只产生一份结果。
const c2 = createPlan({ 方案名称: '并发方案', 适用范围: 'x', 监测项目: 'y', 测次安排: 'z', 编制人: '张三' }, editor)
const gc2 = plans().at(-1)['方案组号']
const submits = await Promise.all([
  executePlanAction({ group: gc2, action: '提交审批', actor: editor }),
  executePlanAction({ group: gc2, action: '提交审批', actor: editor }),
])
assert.equal(submits.filter((r) => r.ok).length, 1, '并发提交只能成功一次')
const approves = await Promise.all([
  executePlanAction({ group: gc2, action: '批准方案', actor: approver }),
  executePlanAction({ group: gc2, action: '批准方案', actor: approver }),
])
assert.equal(approves.filter((r) => r.ok).length, 1, '并发批准只能成功一次')

// 5. 检定入口：只接受批准生效的最新版本，并联动补复核；重复登记幂等。
const cal = await registerCalibrationFromPlan({
  group: groupCode,
  entry: { instrumentNo: 'YLS-09', instrumentName: '流速仪', calibrationUnit: '检定中心', content: '' },
  actor: approver,
})
assert.ok(cal.ok)
assert.equal(listReviews().filter((r) => r.planGroup === groupCode && r.status === '待复核').length, 1)
g = groups().find((x) => x.group === groupCode)
assert.equal(g.pending, true, '有未完成复核时方案计入待办')
const dup = await registerCalibrationFromPlan({
  group: groupCode,
  entry: { instrumentNo: 'YLS-09', instrumentName: '流速仪', calibrationUnit: '检定中心', content: '' },
  actor: approver,
})
assert.equal(dup.ok, false, '同一仪器重复登记必须被挡住')

// 未批准方案不可登记检定（另取一份编制中方案）
const c4 = createPlan({ 方案名称: '未批方案', 适用范围: 'a', 监测项目: 'b', 测次安排: 'c', 编制人: '张三' }, editor)
const gc4 = plans().at(-1)['方案组号']
assert.equal((await registerCalibrationFromPlan({
  group: gc4,
  entry: { instrumentNo: 'X', instrumentName: '', calibrationUnit: '', content: '' },
  actor: approver,
})).ok, false)

// 6. 废止：结论改变，待办/待审批全部清空，不残留。
assert.equal((await executePlanAction({ group: groupCode, action: '废止方案', actor: approver })).ok, true)
g = groups().find((x) => x.group === groupCode)
assert.equal(g.conclusion, '已废止停用')
assert.equal(g.pending, false)
assert.equal(listReviews().filter((r) => r.planGroup === groupCode && r.status === '待复核').length, 0)
assert.equal(snapshot().plan.find((p) => p['方案组号'] === groupCode && Number(p['版本号']) === 1).pending, false)

// 7. 修订：已批准方案生成新版本，历史版本只读；旧版结论标注被取代。
assert.equal((await executePlanAction({ group: gc2, action: '发起修订', actor: editor })).ok, true)
g = groups().find((x) => x.group === gc2)
assert.equal(g.versions.length, 2)
assert.equal(g.latest.version, 2)
assert.equal(g.latest.record.status, '编制中')
const v1 = g.versions.find((v) => v.version === 1)
assert.equal(v1.readOnly, true)
assert.equal(v1.availableActions.length, 0)
assert.match(v1.conclusion, /被新版本取代/)
assert.equal(v1.record.status, '已批准', '历史版本状态不被改写')

// 修订中的新版处于编制中，旧版即便历史上有过待办也不携带待办
assert.equal(v1.pending, false, '历史版本不携带待办')

// 8. 复核确认（非废止路径）回算待办
const c3 = createPlan({ 方案名称: '复核方案', 适用范围: 'a', 监测项目: 'b', 测次安排: 'c', 编制人: '张三' }, editor)
const gc3 = plans().at(-1)['方案组号']
await executePlanAction({ group: gc3, action: '提交审批', actor: editor })
await executePlanAction({ group: gc3, action: '批准方案', actor: approver })
await registerCalibrationFromPlan({
  group: gc3,
  entry: { instrumentNo: 'YLS-10', instrumentName: '水位计', calibrationUnit: '检定中心', content: '核对读数' },
  actor: approver,
})
let review = listReviews().find((r) => r.planGroup === gc3)
assert.equal(groups().find((x) => x.group === gc3).pending, true)
const done = completeReview(review.id, approver)
assert.ok(done.ok)
assert.equal(groups().find((x) => x.group === gc3).pending, false)

// 9. 落盘失败不留半份状态。
const before = memory.get(STORAGE_KEY)
const original = globalThis.window.localStorage.setItem
globalThis.window.localStorage.setItem = () => {
  throw new Error('disk full')
}
let failed
try {
  failed = await executePlanAction({ group: gc3, action: '废止方案', actor: approver })
} finally {
  globalThis.window.localStorage.setItem = original
}
assert.equal(failed.ok, false)
assert.equal(memory.get(STORAGE_KEY), before, '写盘失败后持久层必须保持旧快照')
assert.equal(groups().find((x) => x.group === gc3).latest.record.status, '已批准', '内存状态也不得被改写')

console.log('全部领域断言通过 ✔')
process.exit(0)
