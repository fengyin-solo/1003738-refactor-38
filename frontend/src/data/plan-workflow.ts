import type { EntryRow, FlowRecord, PlanVerdict, ReviewItem } from './types'

// 测报方案的共用状态判定。
// 列表、详情、打印包、仪器检定入口只认这里算出的 PlanVerdict，
// 页面和其它模块不再各自解释 status / pending 字段，避免多处口径漂移。
// 本文件只有纯函数：不读存储、不写存储，写盘统一由 local-service 编排。

export const PLAN_MODULE_KEY = 'plan'
export const CALIBRATION_MODULE_KEY = 'calibration'

export const PLAN_STATUS = {
  draft: '编制中',
  submitted: '待审批',
  approved: '已批准',
  superseded: '已修订',
  abolished: '已废止',
} as const

export const PLAN_ACTIONS = {
  submit: '提交审批',
  approve: '批准方案',
  revise: '修订方案',
  abolish: '废止方案',
} as const

const KNOWN_STATUSES = new Set<string>(Object.values(PLAN_STATUS))

// 每个状态唯一的对外结论口径：列表、详情、打印包、检定入口都显示它
const CONCLUSION_BY_STATUS: Record<string, string> = {
  [PLAN_STATUS.draft]: '未送审',
  [PLAN_STATUS.submitted]: '审批中',
  [PLAN_STATUS.approved]: '现行有效',
  [PLAN_STATUS.superseded]: '已被新版本替代（只读）',
  [PLAN_STATUS.abolished]: '已废止失效',
}

// 每个状态当前可执行的动作；越级操作在这里就没有入口
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  [PLAN_STATUS.draft]: [PLAN_ACTIONS.submit, PLAN_ACTIONS.abolish],
  [PLAN_STATUS.submitted]: [PLAN_ACTIONS.approve, PLAN_ACTIONS.abolish],
  [PLAN_STATUS.approved]: [PLAN_ACTIONS.revise, PLAN_ACTIONS.abolish],
  [PLAN_STATUS.superseded]: [],
  [PLAN_STATUS.abolished]: [],
}

// 单行状态流转的合法边；「修订方案」要同时写新旧两行，走 buildPlanRevision
const TRANSITIONS: Record<string, Record<string, string>> = {
  [PLAN_STATUS.draft]: {
    [PLAN_ACTIONS.submit]: PLAN_STATUS.submitted,
    [PLAN_ACTIONS.abolish]: PLAN_STATUS.abolished,
  },
  [PLAN_STATUS.submitted]: {
    [PLAN_ACTIONS.approve]: PLAN_STATUS.approved,
    [PLAN_ACTIONS.abolish]: PLAN_STATUS.abolished,
  },
  [PLAN_STATUS.approved]: {
    [PLAN_ACTIONS.abolish]: PLAN_STATUS.abolished,
  },
  [PLAN_STATUS.superseded]: {},
  [PLAN_STATUS.abolished]: {},
}

function normalizeStatus(raw: string): string {
  return KNOWN_STATUSES.has(raw) ? raw : PLAN_STATUS.draft
}

function asFlowLog(value: unknown): FlowRecord[] {
  return Array.isArray(value) ? (value as FlowRecord[]) : []
}

function asReviewItems(value: unknown): ReviewItem[] {
  return Array.isArray(value) ? (value as ReviewItem[]) : []
}

/**
 * 共用判定：同一条方案记录，在任何入口得到的结论都相同。
 * 旧版本数据没有 版本/流转记录/复核事项 字段，这里给默认值，只读兼容、不强制迁移。
 */
export function resolvePlanVerdict(row: EntryRow): PlanVerdict {
  const status = normalizeStatus(String(row.status))
  return {
    id: Number(row.id),
    version: Number(row['版本']) || 1,
    status,
    conclusion: CONCLUSION_BY_STATUS[status],
    pendingApproval: status === PLAN_STATUS.submitted,
    readOnly: status === PLAN_STATUS.superseded || status === PLAN_STATUS.abolished,
    abnormal: status === PLAN_STATUS.abolished,
    availableActions: ACTIONS_BY_STATUS[status] ?? [],
    canAcceptReview: status === PLAN_STATUS.approved,
    flowLog: asFlowLog(row['流转记录']),
    reviewItems: asReviewItems(row['复核事项']),
  }
}

/** 同一方案编号可能有多版（修订产生），对外口径取版本最高的一条。 */
export function findLatestPlanRow(rows: EntryRow[], code: string): EntryRow | null {
  let latest: EntryRow | null = null
  for (const row of rows) {
    if (String(row['方案编号'] ?? '') !== code) {
      continue
    }
    if (latest === null || resolvePlanVerdict(row).version > resolvePlanVerdict(latest).version) {
      latest = row
    }
  }
  return latest
}

export type PlanMutation =
  | { ok: true; row: EntryRow; changed: boolean; message: string }
  | { ok: false; message: string }

function makeFlow(
  log: FlowRecord[],
  action: string,
  from: string,
  to: string,
  operator: string,
  now: string,
  note: string,
): FlowRecord {
  return { id: log.length + 1, 动作: action, 从状态: from, 到状态: to, 时间: now, 操作人: operator, 备注: note }
}

function withStatus(row: EntryRow, log: FlowRecord[], status: string): EntryRow {
  return {
    ...row,
    status,
    pending: status === PLAN_STATUS.submitted,
    abnormal: status === PLAN_STATUS.abolished,
    ['方案状态']: status,
    ['流转记录']: log,
  }
}

/**
 * 单方案动作：提交审批 / 批准方案 / 废止方案。
 * 提交是幂等的——并发或重复提交只保留同一份审批结果，不重复登记流转。
 */
export function applyPlanAction(row: EntryRow, action: string, operator: string, now: string): PlanMutation {
  const verdict = resolvePlanVerdict(row)
  if (action === PLAN_ACTIONS.submit && verdict.status === PLAN_STATUS.submitted) {
    return { ok: true, row, changed: false, message: '方案已提交审批，沿用同一份审批结果，不重复登记' }
  }
  const target = TRANSITIONS[verdict.status]?.[action]
  if (!target) {
    if (action === PLAN_ACTIONS.approve && verdict.status === PLAN_STATUS.draft) {
      return { ok: false, message: '方案尚未提交审批，不能越级批准' }
    }
    if (action === PLAN_ACTIONS.revise) {
      return { ok: false, message: `只有「${PLAN_STATUS.approved}」方案可以修订，当前「${verdict.status}」` }
    }
    return { ok: false, message: `「${verdict.status}」状态不能执行「${action}」` }
  }
  const note =
    action === PLAN_ACTIONS.abolish
      ? '方案废止，待审批待办一并清理'
      : action === PLAN_ACTIONS.submit
        ? '提交进入审批'
        : '批准生效'
  const log = [...verdict.flowLog, makeFlow(verdict.flowLog, action, verdict.status, target, operator, now, note)]
  return { ok: true, row: withStatus(row, log, target), changed: true, message: `方案已${action}，当前状态「${target}」` }
}

export type PlanRevision =
  | { ok: true; rows: EntryRow[]; message: string }
  | { ok: false; message: string }

/**
 * 修订：已批准方案派生新版本（编制中），旧版本转「已修订」只读。
 * 新旧两行由调用方在同一个事务里落盘，要么都成功，要么都不写。
 */
export function buildPlanRevision(rows: EntryRow[], id: number, operator: string, now: string): PlanRevision {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的测报方案` }
  }
  const source = rows[index]
  const verdict = resolvePlanVerdict(source)
  if (verdict.status !== PLAN_STATUS.approved) {
    return { ok: false, message: `只有「${PLAN_STATUS.approved}」方案可以修订，当前「${verdict.status}」` }
  }
  const nextVersion = verdict.version + 1
  const retiredLog = [
    ...verdict.flowLog,
    makeFlow(verdict.flowLog, PLAN_ACTIONS.revise, verdict.status, PLAN_STATUS.superseded, operator, now, `被第 ${nextVersion} 版替代，转为只读`),
  ]
  const retired = withStatus(source, retiredLog, PLAN_STATUS.superseded)
  const newId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const draftLog = [
    makeFlow([], '修订建版', '—', PLAN_STATUS.draft, operator, now, `自第 ${verdict.version} 版（记录 ${source.id}）修订建立`),
  ]
  const draft: EntryRow = withStatus(
    { ...source, id: newId, ['版本']: nextVersion, ['批准人']: '', ['复核事项']: [] },
    draftLog,
    PLAN_STATUS.draft,
  )
  const next = [...rows]
  next[index] = retired
  next.push(draft)
  return { ok: true, rows: next, message: `已建立第 ${nextVersion} 版（编制中），第 ${verdict.version} 版转为只读` }
}

/**
 * 检定入口联动补登复核事项：只有「已批准」方案接受；
 * 同一张检定记录只补一次，重复调用返回已有结果（幂等）。
 */
export function buildReviewAppend(
  row: EntryRow,
  source: { 来源模块: string; 来源编号: string; 内容: string },
  operator: string,
  now: string,
): PlanMutation {
  const verdict = resolvePlanVerdict(row)
  if (!verdict.canAcceptReview) {
    return { ok: false, message: `方案当前「${verdict.status}」（${verdict.conclusion}），不接受复核事项` }
  }
  const duplicated = verdict.reviewItems.some(
    (item) => item.来源模块 === source.来源模块 && item.来源编号 === source.来源编号,
  )
  if (duplicated) {
    return { ok: true, row, changed: false, message: `检定记录 ${source.来源编号} 已补过复核事项，不重复登记` }
  }
  const item: ReviewItem = {
    id: verdict.reviewItems.length + 1,
    来源模块: source.来源模块,
    来源编号: source.来源编号,
    内容: source.内容,
    时间: now,
    记录人: operator,
  }
  return {
    ok: true,
    row: { ...row, ['复核事项']: [...verdict.reviewItems, item] },
    changed: true,
    message: `已为方案补登复核事项（来源 ${source.来源编号}）`,
  }
}
