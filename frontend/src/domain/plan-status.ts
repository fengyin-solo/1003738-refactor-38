import {
  CONCLUSION,
  PLAN_ACTIONS,
  PLAN_FIELDS,
  PLAN_STATUSES,
} from './plan-types'
import type {
  Actor,
  PlanActionKey,
  PlanGroupView,
  PlanRecord,
  PlanStatus,
  PlanVersionView,
  PlanTrailItem,
  ReviewItem,
} from './plan-types'
import type { EntryRow } from '@/data/types'

// 旧数据里出现过的历史状态词，归一到现行生命周期，老版本记录只读兼容。
const LEGACY_STATUS: Record<string, PlanStatus> = {
  已修订: '已批准',
}

export function normalizeStatus(raw: unknown): PlanStatus {
  const value = String(raw ?? '')
  if ((PLAN_STATUSES as readonly string[]).includes(value)) {
    return value as PlanStatus
  }
  return LEGACY_STATUS[value] ?? '编制中'
}

export function toPlanRecord(row: EntryRow): PlanRecord {
  return { ...row, status: normalizeStatus(row.status), _plan: true }
}

export function planVersion(row: PlanRecord): number {
  const value = Number(row[PLAN_FIELDS.version])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1
}

export function planGroup(row: PlanRecord): string {
  const value = row[PLAN_FIELDS.group]
  return value !== undefined && String(value) !== '' ? String(value) : String(row['方案编号'] ?? `PLAN-${row.id}`)
}

export function planSubmitter(row: PlanRecord): string {
  return String(row[PLAN_FIELDS.submitter] ?? row['编制人'] ?? '')
}

export function parseTrail(row: PlanRecord): PlanTrailItem[] {
  const raw = row[PLAN_FIELDS.trail]
  if (typeof raw !== 'string' || raw === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as PlanTrailItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 统一状态判定：方案在某个版本上的结论、是否只读、待办与可执行动作只在这里算一次。
 * 列表行、详情卡片、打印包、检定入口全部消费这一结果，禁止在页面里再各判一套。
 */
export function deriveVersion(
  record: PlanRecord,
  options: { isLatest: boolean; superseded: boolean; pendingReviews: number; actor: Actor | null },
): PlanVersionView {
  const { isLatest, superseded, pendingReviews, actor } = options
  const status = normalizeStatus(record.status)

  let conclusion = CONCLUSION[status]
  if (status === '已批准' && superseded) {
    conclusion = `已被新版本取代（${CONCLUSION.已批准}历史版本，只读）`
  }

  // 待办只认「待审批」与未完成的复核事项；一旦批准/废止，待审批待办立即消失，不再残留。
  const pending = isLatest && (status === '待审批' || (status === '已批准' && pendingReviews > 0))
  const readOnly = !isLatest

  const availableActions: PlanActionKey[] = []
  if (isLatest && actor) {
    for (const transition of PLAN_ACTIONS) {
      if (!(transition.from as readonly PlanStatus[]).includes(status)) {
        continue
      }
      const key = transition.key
      if (key === '提交审批' && actor.role !== '编制人') continue
      if (key === '发起修订' && actor.role !== '编制人') continue
      if ((key === '批准方案' || key === '驳回方案' || key === '废止方案') && actor.role !== '审批人') {
        continue
      }
      // 禁止自审自批：提交人与批准人不能是同一人，越级/自批一律拒绝。
      if (key === '批准方案' && actor.name === planSubmitter(record)) {
        continue
      }
      availableActions.push(key)
    }
  }

  return {
    record,
    version: planVersion(record),
    isLatest,
    superseded,
    conclusion,
    pending,
    readOnly,
    availableActions,
  }
}

function rowName(row: PlanRecord): string {
  return String(row['方案名称'] ?? '')
}

/** 把同一份方案的各版本聚成一组，组首结论取最新版本；历史版本只读。 */
export function deriveGroups(records: EntryRow[], reviews: ReviewItem[], actor: Actor | null): PlanGroupView[] {
  const plans = records.map(toPlanRecord)
  const byGroup = new Map<string, PlanRecord[]>()
  for (const plan of plans) {
    const group = planGroup(plan)
    const list = byGroup.get(group) ?? []
    list.push(plan)
    byGroup.set(group, list)
  }

  const groups: PlanGroupView[] = []
  for (const [group, list] of byGroup) {
    list.sort((a, b) => planVersion(a) - planVersion(b))
    const maxVersion = planVersion(list[list.length - 1])
    const versions = list.map((record) => {
      const version = planVersion(record)
      const pendingReviews = reviews.filter(
        (item) => item.planGroup === group && item.status === '待复核',
      ).length
      return deriveVersion(record, {
        isLatest: version === maxVersion,
        superseded: normalizeStatus(record.status) === '已批准' && version < maxVersion,
        pendingReviews,
        actor,
      })
    })
    const latest = versions[versions.length - 1]
    const pendingReviews = reviews.filter(
      (item) => item.planGroup === group && item.status === '待复核',
    ).length
    groups.push({
      group,
      name: rowName(latest.record) || rowName(versions[0].record),
      latest,
      versions,
      pendingReviews,
      conclusion: latest.conclusion,
      pending: latest.pending,
    })
  }

  groups.sort((a, b) => (a.group < b.group ? 1 : -1))
  return groups
}

export function findGroup(records: EntryRow[], reviews: ReviewItem[], group: string, actor: Actor | null) {
  return deriveGroups(records, reviews, actor).find((item) => item.group === group)
}

/** 检定入口能不能挂到这份方案：只认「最新版本且批准生效、未被取代、未废止」。 */
export function isPlanOpenForCalibration(view: PlanVersionView): boolean {
  return (
    view.isLatest &&
    !view.superseded &&
    !view.readOnly &&
    normalizeStatus(view.record.status) === '已批准'
  )
}

/** 打印包结论与详情、列表完全同源，杜绝三处措辞/口径不一致。 */
export function printSnapshot(group: PlanGroupView) {
  return {
    方案编号: group.group,
    方案名称: group.name,
    方案结论: group.conclusion,
    生效版本: `V${group.latest.version}`,
    待复核事项: group.pendingReviews,
    versions: group.versions.map((view) => ({
      版本: `V${view.version}`,
      状态: normalizeStatus(view.record.status),
      结论: view.conclusion,
      只读: view.readOnly,
      编制人: String(view.record['编制人'] ?? ''),
      批准人: String(view.record[PLAN_FIELDS.approver] ?? view.record['批准人'] ?? ''),
    })),
  }
}
