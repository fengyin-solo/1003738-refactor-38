import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, transact } from '@/data/local-store'
import {
  CALIBRATION_MODULE_KEY,
  PLAN_ACTIONS,
  PLAN_MODULE_KEY,
  PLAN_STATUS,
  applyPlanAction,
  buildPlanRevision,
  buildReviewAppend,
  findLatestPlanRow,
  resolvePlanVerdict,
} from '@/data/plan-workflow'
import type {
  ActionResult,
  CalibrationListItem,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PlanListItem,
  PlanPrintPacket,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 测报方案统一走专用流转（共用状态判定），不再走这里的通用直改，避免两套口径。
  if (key === PLAN_MODULE_KEY) {
    return runPlanAction(id, action, '系统')
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    // 测报方案的待办/异常以共用判定为准：废止后不再残留待审批待办
    const isPlan = meta.key === PLAN_MODULE_KEY
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => (isPlan ? resolvePlanVerdict(row).pendingApproval : row.pending)).length,
      abnormal: entries.filter((row) => (isPlan ? resolvePlanVerdict(row).abnormal : row.abnormal)).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ===== 测报方案：共用状态判定的唯一编排入口 =====
// 列表、详情、打印包、仪器检定入口都从这里拿同一份结论；
// 所有写操作走 transact，一次落盘，失败不留半份状态。

/** 读路径覆盖派生值：旧数据里残留的 pending/方案状态 以判定结果为准。 */
function overlayPlanRow(row: EntryRow): EntryRow {
  const verdict = resolvePlanVerdict(row)
  return {
    ...row,
    status: verdict.status,
    pending: verdict.pendingApproval,
    abnormal: verdict.abnormal,
    ['版本']: verdict.version,
    ['方案状态']: verdict.status,
  }
}

export function listPlanView(filters: Record<string, string> = {}): { items: PlanListItem[]; total: number } {
  const matched = filterRows(listRows(PLAN_MODULE_KEY), filters)
  return {
    items: matched.map((row) => ({ row: overlayPlanRow(row), verdict: resolvePlanVerdict(row) })),
    total: matched.length,
  }
}

export function getPlanDetail(id: number): PlanListItem | null {
  const row = listRows(PLAN_MODULE_KEY).find((item) => Number(item.id) === id)
  return row ? { row: overlayPlanRow(row), verdict: resolvePlanVerdict(row) } : null
}

export function planSummary(): { label: string; value: number }[] {
  const verdicts = listRows(PLAN_MODULE_KEY).map(resolvePlanVerdict)
  return [
    { label: '方案总数', value: verdicts.length },
    { label: '已批准方案', value: verdicts.filter((item) => item.status === PLAN_STATUS.approved).length },
    { label: '待审批方案', value: verdicts.filter((item) => item.pendingApproval).length },
  ]
}

export function runPlanAction(id: number, action: string, operator: string): ActionResult {
  if (action === PLAN_ACTIONS.revise) {
    return revisePlan(id, operator)
  }
  let message = ''
  try {
    transact((draft) => {
      const rows = draft[PLAN_MODULE_KEY] ?? []
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        throw new Error(`没有找到编号为 ${id} 的测报方案`)
      }
      const result = applyPlanAction(rows[index], action, operator, now())
      if (!result.ok) {
        throw new Error(result.message)
      }
      if (result.changed) {
        const next = [...rows]
        next[index] = result.row
        draft[PLAN_MODULE_KEY] = next
      }
      message = result.message
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测报方案流转失败' }
  }
  return { ok: true, message }
}

/** 修订：新旧两行在同一个事务里落盘，旧版本只读、新版本回到编制中。 */
export function revisePlan(id: number, operator: string): ActionResult {
  let message = ''
  try {
    transact((draft) => {
      const rows = draft[PLAN_MODULE_KEY] ?? []
      const result = buildPlanRevision(rows, id, operator, now())
      if (!result.ok) {
        throw new Error(result.message)
      }
      draft[PLAN_MODULE_KEY] = result.rows
      message = result.message
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测报方案修订失败' }
  }
  return { ok: true, message }
}

export function createPlan(
  input: { 方案名称: string; 适用范围: string; 监测项目: string; 测次安排: string; 编制人: string },
  operator: string,
): ActionResult {
  if (!input.方案名称.trim()) {
    return { ok: false, message: '方案名称不能为空' }
  }
  let message = ''
  try {
    transact((draft) => {
      const rows = draft[PLAN_MODULE_KEY] ?? []
      const newId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
      const maxCode = rows.reduce((max, row) => {
        const matched = /^PLAN-(\d+)$/.exec(String(row['方案编号'] ?? ''))
        return matched ? Math.max(max, Number(matched[1])) : max
      }, 0)
      const row: EntryRow = {
        id: newId,
        status: PLAN_STATUS.draft,
        pending: false,
        abnormal: false,
        ['方案编号']: `PLAN-${String(maxCode + 1).padStart(4, '0')}`,
        ['方案名称']: input.方案名称.trim(),
        ['版本']: 1,
        ['适用范围']: input.适用范围.trim(),
        ['监测项目']: input.监测项目.trim(),
        ['测次安排']: input.测次安排.trim(),
        ['编制人']: input.编制人.trim() || operator,
        ['批准人']: '',
        ['方案状态']: PLAN_STATUS.draft,
        ['流转记录']: [
          { id: 1, 动作: '登记方案', 从状态: '—', 到状态: PLAN_STATUS.draft, 时间: now(), 操作人: operator, 备注: '初始登记' },
        ],
        ['复核事项']: [],
      }
      draft[PLAN_MODULE_KEY] = [...rows, row]
      message = `测报方案已登记（第 1 版，编制中）`
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测报方案登记失败' }
  }
  return { ok: true, message }
}

/** 打印包：内容全部来自共用判定结果，与详情页同源。 */
export function getPlanPrintPacket(id: number, operator: string): PlanPrintPacket | null {
  const detail = getPlanDetail(id)
  if (!detail) {
    return null
  }
  const meta = moduleMeta(PLAN_MODULE_KEY)
  const fields = meta.fields.filter((field) => field !== '方案状态')
  return {
    标题: `测报方案审批包 ${String(detail.row['方案编号'] ?? '')}`,
    方案编号: String(detail.row['方案编号'] ?? ''),
    版本: detail.verdict.version,
    状态: detail.verdict.status,
    结论: detail.verdict.conclusion,
    基本信息: fields.map((field) => ({ label: field, value: String(detail.row[field] ?? '—') })),
    流转记录: detail.verdict.flowLog,
    复核事项: detail.verdict.reviewItems,
    打印人: operator,
    打印时间: now(),
  }
}

// ===== 仪器检定入口：引用同一份方案判定，并联动补登复核事项 =====

export function listCalibrationView(filters: Record<string, string> = {}): { items: CalibrationListItem[]; total: number } {
  const planRows = listRows(PLAN_MODULE_KEY)
  const matched = filterRows(listRows(CALIBRATION_MODULE_KEY), filters)
  return {
    items: matched.map((row) => {
      const code = String(row['方案编号'] ?? '')
      const planRow = code ? findLatestPlanRow(planRows, code) : null
      const planVerdict = planRow ? resolvePlanVerdict(planRow) : null
      const reviewDone = planVerdict
        ? planVerdict.reviewItems.some((item) => item.来源编号 === String(row['记录编号'] ?? ''))
        : false
      return { row, planVerdict, reviewDone }
    }),
    total: matched.length,
  }
}

/**
 * 检定入口联动：检定合格的记录为关联方案补登一条复核事项。
 * 方案是否可复核由共用判定说了算；补登与校验在同一个事务里，失败不留半份状态。
 */
export function appendReviewFromCalibration(calibrationId: number, operator: string): ActionResult {
  let message = ''
  try {
    transact((draft) => {
      const calibrations = draft[CALIBRATION_MODULE_KEY] ?? []
      const record = calibrations.find((row) => Number(row.id) === calibrationId)
      if (!record) {
        throw new Error(`没有找到编号为 ${calibrationId} 的仪器检定记录`)
      }
      if (String(record.status) !== '已合格') {
        throw new Error(`检定记录当前「${String(record.status)}」，确认合格后才能登记方案复核`)
      }
      const code = String(record['方案编号'] ?? '')
      if (!code) {
        throw new Error('该检定记录未关联测报方案，无法联动复核')
      }
      const plans = draft[PLAN_MODULE_KEY] ?? []
      const planRow = findLatestPlanRow(plans, code)
      if (!planRow) {
        throw new Error(`没有找到方案编号为 ${code} 的测报方案`)
      }
      const result = buildReviewAppend(
        planRow,
        {
          来源模块: '仪器检定',
          来源编号: String(record['记录编号'] ?? ''),
          内容: `仪器「${String(record['仪器名称'] ?? '')}」检定合格，结果已复核`,
        },
        operator,
        now(),
      )
      if (!result.ok) {
        throw new Error(result.message)
      }
      if (result.changed) {
        draft[PLAN_MODULE_KEY] = plans.map((row) => (Number(row.id) === Number(planRow.id) ? result.row : row))
      }
      message = result.message
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '联动复核失败' }
  }
  return { ok: true, message }
}
