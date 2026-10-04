<template>
  <section class="page" data-module="plan">
    <header class="page-head">
      <div>
        <h2>测报方案管理</h2>
        <p class="page-desc">
          提交、批准、废止与修订共用同一套状态判定，列表、详情、打印包与检定入口结论一致；废止后不再残留待办。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = !showCreate">
          {{ showCreate ? '收起登记' : '登记测报方案' }}
        </button>
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
          <option value="编制人">编制人（可登记/提交/修订）</option>
          <option value="审批人">审批人（可批准/驳回/废止）</option>
        </select>
      </label>
      <span class="actor-hint">提交人与批准人不能为同一人；越级/自批会被拒绝。</span>
    </div>

    <form v-if="showCreate" class="create-card" @submit.prevent="submitCreate">
      <label>方案名称<input v-model="createForm.方案名称" required placeholder="如 2026 年度汛测报方案" /></label>
      <label>适用范围<input v-model="createForm.适用范围" placeholder="如 测区干流各站" /></label>
      <label>监测项目<input v-model="createForm.监测项目" placeholder="如 水位、流量、泥沙" /></label>
      <label>测次安排<input v-model="createForm.测次安排" placeholder="如 每日两段制" /></label>
      <label>编制人<input v-model="createForm.编制人" :placeholder="actorName" /></label>
      <div class="span-2 form-actions">
        <button class="btn primary" type="submit">登记为 V1（编制中）</button>
      </div>
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
      <span class="legend-item legend-pending">待办方案：{{ pendingGroups }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>方案编号/名称</span>
        <input v-model="keyword" placeholder="按编号或名称检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="keyword = ''; reload()">重置条件</button>
    </form>

    <p v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>

    <table class="data-table">
      <thead>
        <tr>
          <th>方案编号</th><th>方案名称</th><th>适用范围</th><th>监测项目</th>
          <th>版本</th><th>方案结论（统一判定）</th><th>编制/批准</th><th>待复核</th><th>可执行动作</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in filteredGroups" :key="item.group" :class="{ 'row-pending': item.pending }">
          <td>{{ item.group }}</td>
          <td>{{ item.name }}</td>
          <td>{{ item.latest.record['适用范围'] }}</td>
          <td>{{ item.latest.record['监测项目'] }}</td>
          <td>V{{ item.latest.version }}（共 {{ item.versions.length }} 版）</td>
          <td>
            <strong>{{ item.conclusion }}</strong>
            <span v-if="item.pending" class="todo-flag">有待办</span>
          </td>
          <td>{{ item.latest.record['编制人'] || '—' }} ／ {{ item.latest.record['批准人'] || '—' }}</td>
          <td>{{ item.pendingReviews }}</td>
          <td class="row-actions">
            <button
              v-for="action in item.latest.availableActions"
              :key="action"
              class="link"
              type="button"
              :disabled="busy"
              @click="doAction(action, item.group)"
            >
              {{ action }}
            </button>
            <span v-if="!item.latest.availableActions.length" class="muted">—</span>
          </td>
          <td><RouterLink class="link" :to="`/plan/${item.group}`">详情/打印</RouterLink></td>
        </tr>
        <tr v-if="!filteredGroups.length">
          <td colspan="10" class="empty-state">暂无测报方案，可先登记方案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ groups.length }} 份方案（按方案组去重），历史版本在详情中只读查看</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { listRows } from '@/data/local-store'
import { deriveGroups, normalizeStatus } from '@/domain/plan-status'
import { createPlan, executePlanAction, listReviews, migratePlanData } from '@/domain/plan-service'
import type { PlanActionKey, PlanGroupView } from '@/domain/plan-types'
import { useActor } from '@/domain/use-actor'

const { name: actorName, role: actorRole, actor } = useActor()

const showCreate = ref(false)
const keyword = ref('')
const message = ref('')
const messageOk = ref(false)
const busy = ref(false)
const refreshKey = ref(0)
const createForm = reactive({ 方案名称: '', 适用范围: '', 监测项目: '', 测次安排: '', 编制人: '' })

const statusOrder = ['编制中', '待审批', '已批准', '已驳回', '已废止']

const groups = computed<PlanGroupView[]>(() => {
  void refreshKey.value
  return deriveGroups(listRows('plan'), listReviews(), actor.value)
})

const filteredGroups = computed(() => {
  const key = keyword.value.trim()
  if (!key) {
    return groups.value
  }
  return groups.value.filter(
    (item) => item.group.includes(key) || item.name.includes(key),
  )
})

const stats = computed(() => [
  { label: '方案总数', value: groups.value.length },
  {
    label: '已批准生效',
    value: groups.value.filter((item) => normalizeStatus(item.latest.record.status) === '已批准' && !item.latest.superseded).length,
  },
  {
    label: '待审批',
    value: groups.value.filter((item) => normalizeStatus(item.latest.record.status) === '待审批').length,
  },
])

const pendingGroups = computed(() => groups.value.filter((item) => item.pending).length)
const statusSummary = computed(() =>
  statusOrder.map((status) => ({
    status,
    count: groups.value.filter((item) => normalizeStatus(item.latest.record.status) === status).length,
  })),
)

function reload() {
  refreshKey.value += 1
}
function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}
function submitCreate() {
  const result = createPlan({ ...createForm, 编制人: createForm.编制人 || actorName.value }, actor.value)
  notify(result.ok, result.message)
  if (result.ok) {
    showCreate.value = false
    createForm.方案名称 = ''
    createForm.适用范围 = ''
    createForm.监测项目 = ''
    createForm.测次安排 = ''
    createForm.编制人 = ''
  }
  reload()
}

async function doAction(action: PlanActionKey, group: string) {
  busy.value = true
  try {
    const result = await executePlanAction({ group, action, actor: actor.value })
    notify(result.ok, result.message)
    reload()
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  migratePlanData()
  reload()
})
</script>
