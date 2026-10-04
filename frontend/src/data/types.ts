/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 测报方案的一条流转记录：谁、什么时候、把方案从什么状态推进到什么状态。 */
export type FlowRecord = {
  id: number
  动作: string
  从状态: string
  到状态: string
  时间: string
  操作人: string
  备注: string
}

/** 测报方案上挂的复核事项：由仪器检定入口联动补登。 */
export type ReviewItem = {
  id: number
  来源模块: string
  来源编号: string
  内容: string
  时间: string
  记录人: string
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | FlowRecord[] | ReviewItem[]
}

/**
 * 测报方案的共用判定结果。
 * 列表、详情、打印包、仪器检定入口只认这一份结论，不再各自解释 status 字段。
 */
export type PlanVerdict = {
  id: number
  version: number
  status: string
  conclusion: string
  /** 待审批待办：仅「待审批」为 true，批准/修订/废止后一律清理 */
  pendingApproval: boolean
  /** 已修订、已废止的方案只读，不再接受任何动作 */
  readOnly: boolean
  abnormal: boolean
  availableActions: string[]
  /** 仅「已批准」方案接受检定入口补登的复核事项 */
  canAcceptReview: boolean
  flowLog: FlowRecord[]
  reviewItems: ReviewItem[]
}

export type PlanListItem = {
  row: EntryRow
  verdict: PlanVerdict
}

export type CalibrationListItem = {
  row: EntryRow
  /** 关联方案的同一份判定结论；未关联方案时为 null */
  planVerdict: PlanVerdict | null
  /** 该检定记录是否已为关联方案补过复核事项 */
  reviewDone: boolean
}

/** 方案打印包：内容全部来自 PlanVerdict，与详情页同源。 */
export type PlanPrintPacket = {
  标题: string
  方案编号: string
  版本: number
  状态: string
  结论: string
  基本信息: { label: string; value: string }[]
  流转记录: FlowRecord[]
  复核事项: ReviewItem[]
  打印人: string
  打印时间: string
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
