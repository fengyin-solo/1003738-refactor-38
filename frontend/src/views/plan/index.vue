<template>
  <section class="page" data-module="plan">
    <header class="page-head">
      <div>
        <h2>测报方案管理</h2>
        <p class="page-desc">维护测报方案，围绕方案编号、方案名称、适用范围、监测项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">登记测报方案</button>
        <button class="btn" type="button" @click="exportRows">导出测报方案清单</button>
      </div>
    </header>

    <form v-if="showCreate" class="create-bar" @submit.prevent="submitCreate">
      <label v-for="field in createFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="createForm[field]" :placeholder="`填写${field}`" />
      </label>
      <button class="btn primary" type="submit">保存登记</button>
      <button class="btn ghost" type="button" @click="toggleCreate">取消</button>
    </form>

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
          <th>方案结论</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="String(item.row.id)">
          <td v-for="column in columns" :key="column">{{ item.row[column] || '—' }}</td>
          <td>{{ item.verdict.status }}</td>
          <td>{{ item.verdict.conclusion }}</td>
          <td class="row-actions">
            <button
              v-for="action in item.verdict.availableActions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, item.row)"
            >
              {{ action }}
            </button>
            <span v-if="item.verdict.readOnly" class="readonly-tag">只读</span>
            <button class="link" type="button" @click="openDetail(item.row)">详情</button>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无测报方案数据，可先登记测报方案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条测报方案记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  createPlan,
  downloadEntries,
  listPlanView,
  moduleMeta,
  planSummary,
  runPlanAction,
} from '@/api/local-service'
import type { EntryRow, PlanListItem } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('plan')
const store = useSessionStore()
const router = useRouter()

const columns = ["方案编号", "方案名称", "版本", "适用范围", "监测项目", "测次安排", "编制人", "批准人", "方案状态"]
const statuses = ["编制中", "待审批", "已批准", "已修订", "已废止"]
const createFields = ["方案名称", "适用范围", "监测项目", "测次安排", "编制人"]

const items = ref<PlanListItem[]>([])
const total = ref(0)
const stats = ref<{ label: string; value: number }[]>([])
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const showCreate = ref(false)
const createForm = ref<Record<string, string>>({})
const filterFields = ["方案编号", "方案名称", "适用范围"]

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: items.value.filter((item) => item.verdict.status === status).length,
  })),
)

function toggleCreate() {
  showCreate.value = !showCreate.value
  createForm.value = {}
}

function submitCreate() {
  const result = createPlan(
    {
      方案名称: createForm.value['方案名称'] ?? '',
      适用范围: createForm.value['适用范围'] ?? '',
      监测项目: createForm.value['监测项目'] ?? '',
      测次安排: createForm.value['测次安排'] ?? '',
      编制人: createForm.value['编制人'] ?? '',
    },
    store.operator,
  )
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    showCreate.value = false
    createForm.value = {}
  }
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openDetail(row: EntryRow) {
  router.push({ name: 'plan-detail', params: { id: Number(row.id) } })
}

function runAction(action: string, row: EntryRow) {
  const result = runPlanAction(Number(row.id), action, store.operator)
  messageOk.value = result.ok
  message.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listPlanView(filters.value)
    items.value = payload.items
    total.value = payload.total
    stats.value = planSummary()
  } catch (error) {
    messageOk.value = false
    message.value = error instanceof Error ? error.message : '测报方案列表读取失败'
  }
}

onMounted(reload)
</script>
