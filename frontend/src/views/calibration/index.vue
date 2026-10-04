<template>
  <section class="page" data-module="calibration">
    <header class="page-head">
      <div>
        <h2>仪器检定管理</h2>
        <p class="page-desc">维护仪器检定记录，围绕记录编号、仪器编号、仪器名称、检定单位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记仪器检定记录</button>
        <button class="btn" type="button" @click="exportRows">导出仪器检定清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>关联方案结论</th>
          <th>方案复核</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="String(item.row.id)">
          <td v-for="column in columns" :key="column">{{ item.row[column] || '—' }}</td>
          <td>{{ item.row.status }}</td>
          <td>{{ item.planVerdict ? item.planVerdict.conclusion : '未关联方案' }}</td>
          <td>{{ item.reviewDone ? '已补复核' : '—' }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, item.row)"
            >
              {{ action }}
            </button>
            <button
              v-if="canLinkReview(item)"
              class="link"
              type="button"
              @click="linkReview(item.row)"
            >
              登记方案复核
            </button>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无仪器检定数据，可先登记仪器检定记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条仪器检定记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  appendReviewFromCalibration,
  downloadEntries,
  listCalibrationView,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { CalibrationListItem, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('calibration')
const store = useSessionStore()
const columns = ["记录编号", "仪器编号", "仪器名称", "检定单位", "检定日期", "有效期至", "检定结论", "方案编号", "检定状态"]
const actions = ["送出检定", "确认合格", "标记不合格"]
const statuses = ["待送检", "送检中", "已合格", "不合格", "已停用"]
const stats = [{"label": "待送检仪器", "value": 0}, {"label": "已合格仪器", "value": 0}, {"label": "不合格仪器", "value": 0}]

const items = ref<CalibrationListItem[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: items.value.filter((item) => String(item.row.status) === status).length,
  })),
)

// 检定入口：检定合格且关联了方案的记录，可以联动给方案补登复核事项
function canLinkReview(item: CalibrationListItem): boolean {
  return String(item.row.status) === '已合格' && item.planVerdict !== null && !item.reviewDone
}

function linkReview(row: EntryRow) {
  const result = appendReviewFromCalibration(Number(row.id), store.operator)
  messageOk.value = result.ok
  message.value = result.message
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  messageOk.value = false
  message.value = '仪器检定记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  messageOk.value = result.ok
  message.value = result.ok ? '' : result.message
  reload()
}

function reload() {
  try {
    const payload = listCalibrationView(filters.value)
    items.value = payload.items
    total.value = payload.total
  } catch (error) {
    messageOk.value = false
    message.value = error instanceof Error ? error.message : '仪器检定列表读取失败'
  }
}

onMounted(reload)
</script>
