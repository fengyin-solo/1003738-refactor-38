import { allRows, listRows, writeSnapshot } from '@/data/local-store'
import {
  normalizeStatus,
  parseTrail,
  planGroup,
  planVersion,
  planSubmitter,
  toPlanRecord,
} from './plan-status'
import { PLAN_ACTIONS, PLAN_FIELDS } from './plan-types'
import type {
  ActionOutcome,
  Actor,
  PlanActionKey,
  PlanRecord,
  PlanStatus,
  PlanTrailItem,
  ReviewItem,
} from './plan-types'
import type { EntryRow } from '@/data/types'

const PLAN_KEY = 'plan'
const CALIBRATION_KEY = 'calibration'
// 复核事项作为与方案记录并列的一份数据存进同一个本地快照，一次写入、同生同灭。
const REVIEWS_KEY = '__plan_reviews__'

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function readReviews(): ReviewItem[] {
  const raw = allRows()[REVIEWS_KEY] as unknown
  if (!Array.isArray(raw)) {
    return []
  }
  return (raw as EntryRow[]).map((row) => row as unknown as ReviewItem)
}

function isTerminal(status: PlanStatus): boolean {
  return status === '已废止'
}

function derivePending(row: PlanRecord, openReviews: number): boolean {
  const status = normalizeStatus(row.status)
  if (status !== '待审批' && status !== '已批准') {
    return false
  }
  // 已批准的待办只剩复核事项；废止/驳回后没有任何待办残留。
  return status === '待审批' || openReviews > 0
}

/**
 * 把方案表 + 复核表 + 检定表合成下一份完整快照，最后一次性落盘。
 * 任何一步在写盘前抛错，旧快照原样保留，绝不出现「方案改了、复核没补上」的半份状态。
 */
function commit(nextPlans: PlanRecord[], nextReviews: ReviewItem[], nextCalibration?: EntryRow[]): void {
  const snapshot: Record<string, EntryRow[]> = { ...allRows() }
  snapshot[PLAN_KEY] = nextPlans
  snapshot[REVIEWS_KEY] = nextReviews as unknown as EntryRow[]
  if (nextCalibration) {
    snapshot[CALIBRATION_KEY] = nextCalibration
  }
  persistSnapshot(snapshot)
}

// 真正的持久化点：整份快照交给存储层一次性写入，写盘失败由存储层回滚，绝不留半份状态。
function persistSnapshot(snapshot: Record<string, EntryRow[]>): void {
  writeSnapshot(snapshot)
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function withTrail(row: PlanRecord, item: PlanTrailItem): PlanTrailItem[] {
  return [...parseTrail(row), item]
}

// 同一方案组的动作串行执行：连点两次提交/批准，第二次拿到的一定是第一次之后的状态。
const groupLocks = new Map<string, Promise<unknown>>()

function withGroupLock<T>(group: string, task: () => T): Promise<T> {
  const prev = groupLocks.get(group) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const run = prev.then(() => {
    try {
      return task()
    } finally {
      release()
    }
  })
  groupLocks.set(group, run.then(() => undefined, () => undefined))
  return run
}

function assertActor(action: PlanActionKey, actor: Actor | null): string | null {
  if (!actor || !actor.name) {
    return '未选择当前操作人，无法执行审批动作'
  }
  const writeActions: PlanActionKey[] = ['提交审批', '发起修订']
  const approveActions: PlanActionKey[] = ['批准方案', '驳回方案', '废止方案']
  if (writeActions.includes(action) && actor.role !== '编制人') {
    return `「${action}」只能由编制人执行，当前身份是审批人`
  }
  if (approveActions.includes(action) && actor.role !== '审批人') {
    return `「${action}」属于审批权限，编制人不能越级${action}`
  }
  return null
}

/**
 * 方案动作的唯一执行入口（CAS：先校验当前状态确实是该动作允许的源状态，再整体提交）。
 * 并发进来的重复动作会因为状态已流转而被拒，只产生一份结果。
 */
export function executePlanAction(input: {
  group: string
  action: PlanActionKey
  actor: Actor | null
  note?: string
}): Promise<ActionOutcome> {
  const { group, action, actor, note } = input
  return withGroupLock(group, () => {
    const actorError = assertActor(action, actor)
    if (actorError) {
      return { ok: false, message: actorError }
    }

    const transition = PLAN_ACTIONS.find((item) => item.key === action)
    if (!transition) {
      return { ok: false, message: `未登记的方案动作「${action}」` }
    }

    const plans = listRows(PLAN_KEY).map(toPlanRecord)
    const groupRows = plans.filter((row) => planGroup(row) === group)
    if (groupRows.length === 0) {
      return { ok: false, message: `没有找到方案 ${group}` }
    }
    groupRows.sort((a, b) => planVersion(a) - planVersion(b))
    const target = groupRows[groupRows.length - 1]
    const maxVersion = planVersion(target)

    const current = normalizeStatus(target.status)
    if (isTerminal(current)) {
      return { ok: false, message: `方案已废止，不能再执行「${action}」` }
    }
    if (!(transition.from as readonly PlanStatus[]).includes(current)) {
      return { ok: false, message: `方案当前为「${current}」，不能执行「${action}」（并发操作已生效，请勿重复提交）` }
    }
    if (action === '批准方案' && actor && planSubmitter(target) === actor.name) {
      return { ok: false, message: '提交人与批准人不能为同一人，禁止越级/自审自批' }
    }

    const reviews = readReviews()
    const openReviews = reviews.filter(
      (item) => item.planGroup === group && item.status === '待复核',
    ).length

    // 发起修订：原已批准版本原样保留为只读历史版本，另起一版「编制中」。
    if (action === '发起修订') {
      const history = target
      const revision: PlanRecord = {
        ...history,
        id: nextId(plans),
        status: '编制中',
        pending: false,
        abnormal: false,
        [PLAN_FIELDS.version]: maxVersion + 1,
        [PLAN_FIELDS.submitter]: '',
        [PLAN_FIELDS.approver]: '',
        [PLAN_FIELDS.submittedAt]: '',
        [PLAN_FIELDS.approvedAt]: '',
        [PLAN_FIELDS.trail]: JSON.stringify([
          {
            at: now(),
            actor: actor!.name,
            action: '发起修订',
            from: '已批准',
            to: '编制中',
            note: `基于 V${maxVersion} 修订`,
          },
        ] as PlanTrailItem[]),
      }
      const frozen: PlanRecord = { ...history, pending: false, abnormal: false }
      const nextPlans = plans.map((row) => (row.id === frozen.id ? frozen : row))
      nextPlans.push(revision)
      commit(nextPlans, reviews)
      return { ok: true, message: `已基于 V${maxVersion} 生成修订版 V${maxVersion + 1}，历史版本只读`, planId: revision.id }
    }

    const nextStatus = transition.to as PlanStatus
    const stampFields: Partial<Record<(typeof PLAN_FIELDS)[keyof typeof PLAN_FIELDS], string>> = {}
    if (action === '提交审批') {
      stampFields[PLAN_FIELDS.submitter] = actor!.name
      stampFields[PLAN_FIELDS.submittedAt] = now()
    }
    if (action === '批准方案') {
      stampFields[PLAN_FIELDS.approver] = actor!.name
      stampFields[PLAN_FIELDS.approvedAt] = now()
    }
    if (action === '废止方案') {
      stampFields[PLAN_FIELDS.abolishedBy] = actor!.name
      stampFields[PLAN_FIELDS.abolishedAt] = now()
    }

    const trail = withTrail(target, {
      at: now(),
      actor: actor!.name,
      action,
      from: current,
      to: nextStatus,
      note,
    })

    let updated: PlanRecord = {
      ...target,
      ...stampFields,
      status: nextStatus,
      abnormal: false,
      [PLAN_FIELDS.trail]: JSON.stringify(trail),
      // 兼容旧字段「批准人/方案状态」，让只读老数据与老导出仍然读得通。
      ...(action === '批准方案' ? { 批准人: actor!.name } : {}),
    }

    let nextReviews = reviews
    if (action === '废止方案') {
      // 废止即清场：未完成的复核事项随方案一并关闭，待审批待办也不再存在。
      nextReviews = reviews.map((item) =>
        item.planGroup === group && item.status === '待复核'
          ? { ...item, status: '已复核' as const, reviewedAt: now(), reviewer: actor!.name, note: '方案废止，事项关闭' }
          : item,
      )
    }
    const remainingOpen = nextReviews.filter(
      (item) => item.planGroup === group && item.status === '待复核',
    ).length
    updated = { ...updated, pending: derivePending(updated, remainingOpen) }

    const nextPlans = plans.map((row) => (row.id === updated.id ? updated : row))
    try {
      commit(nextPlans, nextReviews)
    } catch (error) {
      // 落盘失败：内存缓存未切换，调用方仍读到旧状态，绝不留半份状态。
      return { ok: false, message: `操作未能保存，状态未改变：${error instanceof Error ? error.message : '未知错误'}` }
    }
    return { ok: true, message: `方案已${action}，当前结论「${updatedConclusions(nextStatus)}」`, planId: updated.id }
  })
}

function updatedConclusions(status: PlanStatus): string {
  const map: Record<PlanStatus, string> = {
    编制中: '尚未提交审批',
    待审批: '待审批',
    已批准: '批准生效',
    已驳回: '审批未通过，退回编制',
    已废止: '已废止停用',
  }
  return map[status]
}

export type CreatePlanInput = {
  方案名称: string
  适用范围: string
  监测项目: string
  测次安排: string
  编制人: string
}

/** 登记新方案：直接生成 V1「编制中」，与后续审批共用同一份状态判定。 */
export function createPlan(input: CreatePlanInput, actor: Actor): ActionOutcome {
  if (actor.role !== '编制人') {
    return { ok: false, message: '只有编制人可以登记新方案' }
  }
  if (!input.方案名称.trim()) {
    return { ok: false, message: '方案名称不能为空' }
  }
  const plans = listRows(PLAN_KEY).map(toPlanRecord)
  const id = nextId(plans)
  const code = `PLAN-${String(id).padStart(4, '0')}`
  const trail: PlanTrailItem[] = [
    { at: now(), actor: actor.name, action: '登记方案', from: '编制中', to: '编制中' },
  ]
  const record: PlanRecord = {
    id,
    status: '编制中',
    pending: false,
    abnormal: false,
    方案编号: code,
    方案名称: input.方案名称.trim(),
    适用范围: input.适用范围.trim() || '—',
    监测项目: input.监测项目.trim() || '—',
    测次安排: input.测次安排.trim() || '—',
    编制人: input.编制人.trim() || actor.name,
    方案状态: '编制中',
    [PLAN_FIELDS.version]: 1,
    [PLAN_FIELDS.group]: code,
    [PLAN_FIELDS.submitter]: '',
    [PLAN_FIELDS.approver]: '',
    [PLAN_FIELDS.trail]: JSON.stringify(trail),
  }
  commit([...plans, record], readReviews())
  return { ok: true, message: `方案 ${code} 已登记，当前为编制中`, planId: id }
}

export type CalibrationEntryInput = {
  instrumentNo: string
  instrumentName: string
  calibrationUnit: string
  content: string
  result?: '已合格' | '不合格'
}

/**
 * 「另一个检定入口」：从批准生效的方案详情进入登记检定。
 * 检定记录落库的同时，按方案监测项目联动补上一条复核事项——两张表在同一个快照里提交。
 */
export function registerCalibrationFromPlan(input: {
  group: string
  entry: CalibrationEntryInput
  actor: Actor
}): Promise<ActionOutcome> {
  const { group, entry, actor } = input
  return withGroupLock(group, () => {
    const plans = listRows(PLAN_KEY).map(toPlanRecord)
    const groupRows = plans.filter((row) => planGroup(row) === group)
    if (groupRows.length === 0) {
      return { ok: false, message: `没有找到方案 ${group}` }
    }
    groupRows.sort((a, b) => planVersion(a) - planVersion(b))
    const latest = groupRows[groupRows.length - 1]
    const status = normalizeStatus(latest.status)
    if (status !== '已批准') {
      return { ok: false, message: `方案当前为「${status}」，只有批准生效的方案才能登记检定` }
    }
    if (planVersion(latest) !== Math.max(...groupRows.map(planVersion))) {
      return { ok: false, message: '只能从最新生效版本登记检定' }
    }
    if (!entry.instrumentNo.trim()) {
      return { ok: false, message: '仪器编号不能为空' }
    }

    const reviews = readReviews()
    const calibrations = listRows(CALIBRATION_KEY)
    // 同一方案 + 同一仪器只允许一条待复核，重复点击/并发登记不会产生重复待办。
    const duplicated = reviews.some(
      (item) =>
        item.planGroup === group &&
        item.instrumentNo === entry.instrumentNo.trim() &&
        item.status === '待复核',
    )
    if (duplicated) {
      return { ok: false, message: `仪器 ${entry.instrumentNo.trim()} 的复核事项已存在，请勿重复登记` }
    }

    const calibrationId = nextId(calibrations)
    const result = entry.result ?? '已合格'
    const calibrationRow: EntryRow = {
      id: calibrationId,
      status: result,
      pending: false,
      abnormal: result === '不合格',
      记录编号: `CALI-${String(calibrationId).padStart(4, '0')}`,
      仪器编号: entry.instrumentNo.trim(),
      仪器名称: entry.instrumentName.trim() || '未命名仪器',
      检定单位: entry.calibrationUnit.trim() || '—',
      检定日期: now().slice(0, 10),
      有效期至: '—',
      检定结论: result,
      检定状态: result,
      // 反向关联方案，检定记录与方案复核事项能对得上。
      关联方案: group,
      复核事项: entry.content.trim() || '按方案监测项目执行检定后复核',
    }

    const review: ReviewItem = {
      id: nextId(reviews),
      planId: latest.id,
      planGroup: group,
      instrumentNo: String(calibrationRow.仪器编号),
      instrumentName: String(calibrationRow.仪器名称),
      calibrationUnit: String(calibrationRow.检定单位),
      calibrationId,
      content: entry.content.trim() || `依据方案 ${group} 对 ${calibrationRow.仪器名称} 的检定结果进行复核`,
      status: '待复核',
      createdAt: now(),
    }

    const nextPlans = plans.map((row) =>
      row.id === latest.id
        ? {
            ...row,
            pending: true,
            [PLAN_FIELDS.trail]: JSON.stringify([
              ...parseTrail(row),
              {
                at: now(),
                actor: actor.name,
                action: '登记检定' as const,
                from: status,
                to: status,
                note: `登记仪器 ${review.instrumentNo}，联动补录复核事项`,
              },
            ]),
          }
        : row,
    )
    const nextReviews = [...reviews, review]
    const nextCalibration = [...calibrations, calibrationRow]

    try {
      commit(nextPlans, nextReviews, nextCalibration)
    } catch (error) {
      return { ok: false, message: `检定登记未能保存，未产生半份记录：${error instanceof Error ? error.message : '未知错误'}` }
    }
    return { ok: true, message: `已登记检定 ${calibrationRow.记录编号}，并联动补上复核事项`, planId: latest.id }
  })
}

/** 完成复核：只关复核事项并回算方案待办，不改变方案生命周期状态。 */
export function completeReview(reviewId: number, actor: Actor): ActionOutcome {
  if (actor.role !== '审批人') {
    return { ok: false, message: '复核确认需要审批人身份' }
  }
  const reviews = readReviews()
  const target = reviews.find((item) => item.id === reviewId)
  if (!target) {
    return { ok: false, message: '没有找到该复核事项' }
  }
  if (target.status === '已复核') {
    return { ok: false, message: '该复核事项已完成，请勿重复操作' }
  }
  const nextReviews = reviews.map((item) =>
    item.id === reviewId
      ? { ...item, status: '已复核' as const, reviewedAt: now(), reviewer: actor.name }
      : item,
  )
  const plans = listRows(PLAN_KEY).map(toPlanRecord).map((row) => {
    if (planGroup(row) !== target.planGroup) {
      return row
    }
    const open = nextReviews.filter(
      (item) => item.planGroup === target.planGroup && item.status === '待复核',
    ).length
    return { ...row, pending: derivePending(row, open), abnormal: false }
  })
  commit(plans, nextReviews)
  return { ok: true, message: '复核事项已完成' }
}

export function listReviews(): ReviewItem[] {
  return readReviews()
}

export function reviewsForGroup(group: string): ReviewItem[] {
  return readReviews()
    .filter((item) => item.planGroup === group)
    .sort((a, b) => a.id - b.id)
}

/**
 * 旧数据兼容：把历史种子记录纳入同一判定。
 * - 「已修订」归一为「已批准」；
 * - 待审批残留 abnormal 清除、废止残留 pending 清除；
 * - 回填版本号/方案组号，老数据一律视为 V1，只读规则照常生效。
 * 幂等：已经迁移过的记录不会被重复改写。
 */
let migrated = false
export function migratePlanData(): void {
  if (migrated) {
    return
  }
  const plans = listRows(PLAN_KEY)
  if (plans.length === 0) {
    migrated = true
    return
  }
  const reviews = readReviews()
  let dirty = false
  const normalized = plans.map((raw) => {
    const row = toPlanRecord(raw)
    let next: PlanRecord = { ...row }
    const status = normalizeStatus(row.status)
    if (String(raw.status) !== status || raw.abnormal === true) {
      dirty = true
      next = { ...next, abnormal: false }
    }
    if (next[PLAN_FIELDS.version] === undefined) {
      next = { ...next, [PLAN_FIELDS.version]: 1 }
      dirty = true
    }
    if (next[PLAN_FIELDS.group] === undefined) {
      next = { ...next, [PLAN_FIELDS.group]: String(row['方案编号'] ?? `PLAN-${row.id}`) }
      dirty = true
    }
    const openReviews = reviews.filter(
      (item) => item.planGroup === planGroup(next) && item.status === '待复核',
    ).length
    const pending = derivePending(next, openReviews)
    if (Boolean(next.pending) !== pending) {
      next = { ...next, pending }
      dirty = true
    }
    if (typeof next['方案状态'] === 'string' && next['方案状态'] !== status) {
      next = { ...next, 方案状态: status }
      dirty = true
    }
    return next
  })
  if (dirty) {
    commit(normalized, reviews)
  }
  migrated = true
}
