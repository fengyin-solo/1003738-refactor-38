<template>
  <section v-if="group" class="page" data-module="plan-detail">
    <header class="page-head">
      <div>
        <h2>测报方案详情 · {{ group.group }}</h2>
        <p class="page-desc">
          {{ group.name }} ｜ 统一结论：<strong>{{ group.conclusion }}</strong>
          ｜ 当前生效 V{{ group.latest.version }}
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/plan">返回列表</RouterLink>
        <RouterLink class="btn primary" :to="`/plan/${group.group}/print`">打开打印包</RouterLink>
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
          <option value="编制人">编制人（可提交/修订）</option>
          <option value="审批人">审批人（可批准/驳回/废止）</option>
        </select>
      </label>
      <span class="actor-hint">批准人不得与提交人相同，越级批准会被拒绝。</span>
    </div>

    <p v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>

    <article
      v-for="view in [...group.versions].reverse()"
      :key="view.record.id"
      class="version-card"
      :class="{ readonly: view.readOnly, latest: view.isLatest }"
    >
      <header class="version-head">
        <h3>
          V{{ view.version }}
          <span v-if="view.isLatest" class="tag tag-latest">最新版本</span>
          <span v-else class="tag tag-old">历史版本 · 只读</span>
        </h3>
        <span class="version-conclusion">{{ view.conclusion }}</span>
      </header>

      <dl class="version-grid">
        <div><dt>方案状态</dt><dd>{{ statusOf(view.record.status) }}</dd></div>
        <div><dt>编制人</dt><dd>{{ view.record['编制人'] || '—' }}</dd></div>
        <div><dt>提交人</dt><dd>{{ view.record[fields.submitter] || '—' }}</dd></div>
        <div><dt>批准人</dt><dd>{{ view.record[fields.approver] || view.record['批准人'] || '—' }}</dd></div>
        <div><dt>提交时间</dt><dd>{{ view.record[fields.submittedAt] || '—' }}</dd></div>
        <div><dt>批准时间</dt><dd>{{ view.record[fields.approvedAt] || '—' }}</dd></div>
        <div><dt>适用范围</dt><dd>{{ view.record['适用范围'] }}</dd></div>
        <div><dt>监测项目</dt><dd>{{ view.record['监测项目'] }}</dd></div>
        <div class="span-2"><dt>测次安排</dt><dd>{{ view.record['测次安排'] }}</dd></div>
      </dl>

      <div v-if="!view.readOnly && view.availableActions.length" class="version-actions">
        <button
          v-for="action in view.availableActions"
          :key="action"
          class="btn"
          :class="{ primary: action === '批准方案', danger: action === '废止方案' }"
          type="button"
          :disabled="busy"
          @click="doAction(action)"
        >
          {{ action }}
        </button>
      </div>
      <p v-else-if="view.readOnly" class="readonly-hint">历史版本仅可查看与打印，如需调整请在最新版本上发起修订。</p>

      <details class="trail-box">
        <summary>审批履历（{{ trails(view.record.id).length }} 条）</summary>
        <ul class="trail-list">
          <li v-for="(item, idx) in trails(view.record.id)" :key="idx">
            {{ item.at }} · {{ item.actor }} · {{ item.action }}：{{ item.from }} → {{ item.to }}
            <em v-if="item.note">（{{ item.note }}）</em>
          </li>
        </ul>
      </details>
    </article>

    <article class="review-card">
      <header class="version-head">
        <h3>复核事项</h3>
        <span class="muted">由检定入口登记检定时联动补上；方案废止后未完成事项自动关闭，不残留待办。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>仪器编号</th><th>仪器名称</th><th>检定单位</th><th>复核内容</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in reviews" :key="item.id">
            <td>{{ item.instrumentNo }}</td>
            <td>{{ item.instrumentName }}</td>
            <td>{{ item.calibrationUnit }}</td>
            <td>{{ item.content }}</td>
            <td>{{ item.status }}</td>
            <td>
              <button
                v-if="item.status === '待复核'"
                class="link"
                type="button"
                :disabled="busy"
                @click="finishReview(item.id)"
              >
                确认复核
              </button>
              <span v-else>{{ item.reviewer }} · {{ item.reviewedAt }}</span>
            </td>
          </tr>
          <tr v-if="!reviews.length">
            <td colspan="6" class="empty-state">暂无复核事项，批准生效后可从下方检定入口登记。</td>
          </tr>
        </tbody>
      </table>
    </article>

    <article v-if="canCalibrate" class="calibration-card">
      <header class="version-head">
        <h3>检定入口（联动复核）</h3>
        <span class="muted">登记检定后，自动为本方案补一条复核事项，两处共用同一方案结论。</span>
      </header>
      <form class="calibration-form" @submit.prevent="submitCalibration">
        <label>仪器编号<input v-model="calForm.instrumentNo" required placeholder="如 YLS-09" /></label>
        <label>仪器名称<input v-model="calForm.instrumentName" placeholder="如 转子式流速仪" /></label>
        <label>检定单位<input v-model="calForm.calibrationUnit" placeholder="如 省水文仪器检定中心" /></label>
        <label>
          检定结论
          <select v-model="calForm.result">
            <option value="已合格">已合格</option>
            <option value="不合格">不合格</option>
          </select>
        </label>
        <label class="span-2">复核事项<input v-model="calForm.content" placeholder="留空则按方案监测项目自动生成" /></label>
        <div class="span-2 form-actions">
          <button class="btn primary" type="submit" :disabled="busy">登记检定并补复核</button>
        </div>
      </form>
    </article>
    <article v-else class="calibration-card muted-card">
      方案当前不可登记检定：仅「最新版本且批准生效、未废止」的方案开放检定入口。
    </article>
  </section>

  <section v-else class="page">
    <p class="error-text">没有找到该测报方案。</p>
    <RouterLink class="btn" to="/plan">返回方案列表</RouterLink>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'

import { listRows } from '@/data/local-store'
import {
  isPlanOpenForCalibration,
  normalizeStatus,
  parseTrail,
  findGroup,
} from '@/domain/plan-status'
import {
  completeReview,
  executePlanAction,
  registerCalibrationFromPlan,
  reviewsForGroup,
} from '@/domain/plan-service'
import type { PlanActionKey, PlanRecord, ReviewItem } from '@/domain/plan-types'
import { PLAN_FIELDS } from '@/domain/plan-types'
import { useActor } from '@/domain/use-actor'

const route = useRoute()
const groupCode = String(route.params.code ?? '')
const { name: actorName, role: actorRole, actor } = useActor()
const fields = PLAN_FIELDS

const message = ref('')
const messageOk = ref(false)
const busy = ref(false)
const refreshKey = ref(0)

const group = computed(() => {
  void refreshKey.value
  return findGroup(listRows('plan'), reviewsForGroup(groupCode), groupCode, actor.value) ?? null
})
const reviews = computed<ReviewItem[]>(() => {
  void refreshKey.value
  return reviewsForGroup(groupCode)
})
const canCalibrate = computed(() => Boolean(group.value && isPlanOpenForCalibration(group.value.latest)))

const calForm = reactive({ instrumentNo: '', instrumentName: '', calibrationUnit: '', result: '已合格' as '已合格' | '不合格', content: '' })

function reload() {
  refreshKey.value += 1
}
function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}
function statusOf(status: unknown) {
  return normalizeStatus(status)
}
function trails(id: number) {
  const found = group.value?.versions.find((view) => view.record.id === id)
  return found ? parseTrail(found.record as PlanRecord) : []
}

async function doAction(action: PlanActionKey) {
  busy.value = true
  try {
    const result = await executePlanAction({ group: groupCode, action, actor: actor.value })
    notify(result.ok, result.message)
    reload()
  } finally {
    busy.value = false
  }
}

function finishReview(reviewId: number) {
  const result = completeReview(reviewId, actor.value)
  notify(result.ok, result.message)
  reload()
}

async function submitCalibration() {
  busy.value = true
  try {
    const result = await registerCalibrationFromPlan({ group: groupCode, entry: { ...calForm }, actor: actor.value })
    notify(result.ok, result.message)
    if (result.ok) {
      calForm.instrumentNo = ''
      calForm.instrumentName = ''
      calForm.calibrationUnit = ''
      calForm.content = ''
    }
    reload()
  } finally {
    busy.value = false
  }
}

onMounted(reload)
</script>
