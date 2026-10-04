import type { EntryRow } from '@/data/types'

// 测报方案的审批生命周期状态：只有这一份事实来源，列表/详情/打印/检定都基于它派生。
export const PLAN_STATUSES = ['编制中', '待审批', '已批准', '已驳回', '已废止'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

// 方案动作：登记动作、允许的前置状态、流转目标都在这一张表里，页面不再各写一套。
export const PLAN_ACTIONS = [
  { key: '提交审批', from: ['编制中', '已驳回'], to: '待审批' },
  { key: '批准方案', from: ['待审批'], to: '已批准' },
  { key: '驳回方案', from: ['待审批'], to: '已驳回' },
  { key: '废止方案', from: ['已批准'], to: '已废止' },
  { key: '发起修订', from: ['已批准'], to: '编制中' },
] as const
export type PlanActionKey = (typeof PLAN_ACTIONS)[number]['key']

// 方案结论：状态在详情里怎么向人表述，统一从这里取，列表和打印不能各写各的措辞。
export const CONCLUSION: Record<PlanStatus, string> = {
  编制中: '尚未提交审批',
  待审批: '待审批',
  已批准: '批准生效',
  已驳回: '审批未通过，退回编制',
  已废止: '已废止停用',
}

// 方案扩展字段：审批履历、版本、编制/批准人都落在方案记录上，localStorage 里以字符串保存。
export const PLAN_FIELDS = {
  version: '版本号',
  group: '方案组号',
  submitter: '提交人',
  approver: '批准人',
  submittedAt: '提交时间',
  approvedAt: '批准时间',
  abolishedAt: '废止时间',
  abolishedBy: '废止人',
  trail: '审批履历',
  conclusionField: '方案结论',
  effectiveVersion: '当前生效版本',
} as const

export type PlanTrailItem = {
  at: string
  actor: string
  action: PlanActionKey | '登记方案' | '登记检定' | '补录复核'
  from: PlanStatus
  to: PlanStatus
  note?: string
}

// 复核事项：方案批准后，由「检定入口」登记检定时联动补上，废止后不得再补。
export type ReviewItem = {
  id: number
  planId: number
  planGroup: string
  instrumentNo: string
  instrumentName: string
  calibrationUnit: string
  calibrationId?: number
  content: string
  status: '待复核' | '已复核'
  createdAt: string
  reviewedAt?: string
  reviewer?: string
}

export type PlanRecord = EntryRow & {
  status: PlanStatus
  _plan?: true
}

export type PlanVersionView = {
  record: PlanRecord
  version: number
  /** 是否方案组里最新的一版：只有最新版允许继续流转，历史版本一律只读。 */
  isLatest: boolean
  /** 旧版已批准但被新版取代时，结论标注为「被新版本取代」。 */
  superseded: boolean
  /** 统一结论：列表、详情、打印、检定入口都取这一个值。 */
  conclusion: string
  /** 当前还有待办（待审批待办 / 待复核事项）时为 true，废止后不再残留待办。 */
  pending: boolean
  readOnly: boolean
  availableActions: PlanActionKey[]
}

export type PlanGroupView = {
  group: string
  name: string
  latest: PlanVersionView
  versions: PlanVersionView[]
  pendingReviews: number
  conclusion: string
  pending: boolean
}

export type Actor = {
  name: string
  role: '编制人' | '审批人'
}

export type ActionOutcome = {
  ok: boolean
  message: string
  planId?: number
}
