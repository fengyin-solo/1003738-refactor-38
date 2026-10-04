<template>
  <section class="page" data-module="calibration">
    <header class="page-head">
      <div>
        <h2>仪器检定管理</h2>
        <p class="page-desc">
          检定入口与测报方案详情共用同一套方案状态判定：只有「最新版本、批准生效」的方案可以登记检定，登记后自动联动补复核事项。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showEntry = !showEntry">
          {{ showEntry ? '收起检定登记' : '从方案登记检定' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出仪器检定清单</button>
      </div>
    </header>

    <div class="actor-bar">
      <label>
        当前操作人
        <input v-model="actorName" type="text" placeholder="姓名" />
      </label>
      <label>
        身份
        <select v-model="actorRole">
          <option value="编制人">编制人</option>
          <option value="审批人">审批人（可确认复核）</option>
        </select>
      </label>
    </div>

    <form v-if="showEntry" class="create-card" @submit.prevent="submitFromPlan">
      <label>
        关联测报方案
        <select v-model="entry.group">
          <option value="" disabled>仅列出批准生效的最新版本</option>
          <option v-for="item in openPlans" :key="item.group" :value="item.group">
            {{ item.group }} ｜ {{ item.name }} ｜ {{ item.conclusion }}
          </option>
        </select>
      </label>
      <label>仪器编号<input v-model="entry.instrumentNo" required placeholder="如 YLS-09" /></label>
      <label>仪器名称<input v-model="entry.instrumentName" placeholder="如 转子式流速仪" /></label>
      <label>检定单位<input v-model="entry.calibrationUnit" placeholder="检定机构" /></label>
      <label>
        检定结论
        <select v-model="entry.result">
          <option value="已合格">已合格</option>
          <option value="不合格">不合格</option>
        </select>
      </label>
      <label class="span-2">复核事项<input v-model="entry.content" placeholder="留空则按方案监测项目自动生成" /></label>
      <div class="span-2 form-actions">
        <button class="btn primary" type="submit" :disabled="!entry.group || busy">登记检定并补复核</button>
        <span v-if="!openPlans.length" class="muted">当前没有批准生效的方案，可先到测报方案完成审批。</span>
      </div>
    </form>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>关联方案</th>
          <th>方案结论（同源）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['关联方案'] ? String(row['关联方案']) : '—' }}</td>
          <td>{{ planConclusion(String(row['关联方案'] ?? '')) }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无仪器检定数据</td>
        </tr>
      </tbody>
    </table>

    <article class="review-card">
      <header class="version-head">
        <h3>待办复核事项（检定联动生成）</h3>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>方案编号</th><th>仪器编号</th><th>复核内容</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in reviews" :key="item.id">
            <td>{{ item.planGroup }}</td>
            <td>{{ item.instrumentNo }}</td>
            <td>{{ item.content }}</td>
            <td>{{ item.status }}</td>
            <td>
              <button v-if="item.status === '待复核'" class="link" type="button" :disabled="busy" @click="finish(item.id)">
                确认复核
              </button>
              <span v-else>{{ item.reviewer }}</span>
            </td>
          </tr>
          <tr v-if="!reviews.length">
            <td colspan="5" class="empty-state">暂无复核事项</td>
          </tr>
        </tbody>
      </table>
    </article>

    <footer class="page-foot">
      <span>共 {{ total }} 条仪器检定记录；复核事项与方案在同一份快照中提交，失败不留半份状态。</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { deriveGroups, isPlanOpenForCalibration } from '@/domain/plan-status'
import {
  completeReview,
  listReviews,
  migratePlanData,
  registerCalibrationFromPlan,
} from '@/domain/plan-service'
import type { EntryRow } from '@/data/types'
import { useActor } from '@/domain/use-actor'

const meta = moduleMeta('calibration')
const columns = ['记录编号', '仪器编号', '仪器名称', '检定单位', '检定日期', '有效期至', '检定结论', '检定状态']

const { name: actorName, role: actorRole, actor } = useActor()
const showEntry = ref(false)
const busy = ref(false)
const message = ref('')
const messageOk = ref(false)
const refreshKey = ref(0)
const entry = reactive({
  group: '',
  instrumentNo: '',
  instrumentName: '',
  calibrationUnit: '',
  result: '已合格' as '已合格' | '不合格',
  content: '',
})

const rows = ref<EntryRow[]>([])
const total = ref(0)

const planGroups = computed(() => {
  void refreshKey.value
  return deriveGroups(listRows('plan'), listReviews(), actor.value)
})
const openPlans = computed(() => planGroups.value.filter((item) => isPlanOpenForCalibration(item.latest)))
const reviews = computed(() => {
  void refreshKey.value
  return listReviews().slice().sort((a, b) => a.id - b.id)
})

const stats = computed(() => [
  { label: '检定记录总数', value: rows.value.length },
  { label: '已合格', value: rows.value.filter((row) => row['检定结论'] === '已合格').length },
  { label: '待复核事项', value: reviews.value.filter((item) => item.status === '待复核').length },
])

function planConclusion(group: string) {
  if (!group) {
    return '—'
  }
  const found = planGroups.value.find((item) => item.group === group)
  return found ? found.conclusion : '方案已不可见'
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}
function exportRows() {
  downloadEntries(meta.key)
}
async function submitFromPlan() {
  busy.value = true
  try {
    const result = await registerCalibrationFromPlan({
      group: entry.group,
      entry: {
        instrumentNo: entry.instrumentNo,
        instrumentName: entry.instrumentName,
        calibrationUnit: entry.calibrationUnit,
        content: entry.content,
        result: entry.result,
      },
      actor: actor.value,
    })
    notify(result.ok, result.message)
    if (result.ok) {
      entry.instrumentNo = ''
      entry.instrumentName = ''
      entry.calibrationUnit = ''
      entry.content = ''
    }
    reload()
  } finally {
    busy.value = false
  }
}
function finish(reviewId: number) {
  const result = completeReview(reviewId, actor.value)
  notify(result.ok, result.message)
  reload()
}
function reload() {
  refreshKey.value += 1
  const payload = listEntries(meta.key)
  rows.value = payload.items
  total.value = payload.total
}

onMounted(() => {
  migratePlanData()
  reload()
})
</script>
