<template>
  <section v-if="detail" class="page" data-module="plan-detail">
    <header class="page-head no-print">
      <div>
        <h2>测报方案详情</h2>
        <p class="page-desc">
          方案 {{ detail.row['方案编号'] }} · 第 {{ detail.verdict.version }} 版 · 与列表、打印包、检定入口共用同一份状态判定
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="backToList">返回列表</button>
        <button class="btn primary" type="button" @click="printPacket">打印方案包</button>
      </div>
    </header>

    <div class="no-print">
      <p class="verdict-banner" :class="{ readonly: detail.verdict.readOnly }">
        方案结论：{{ detail.verdict.conclusion }} · 当前状态：{{ detail.verdict.status }}
        <template v-if="detail.verdict.readOnly">· 只读</template>
        · 待审批待办：{{ detail.verdict.pendingApproval ? '有' : '无' }}
      </p>

      <div class="detail-grid">
        <div v-for="field in baseFields" :key="field" class="detail-item">
          <span>{{ field }}</span>
          <strong>{{ detail.row[field] || '—' }}</strong>
        </div>
      </div>

      <div class="row-actions detail-actions">
        <button
          v-for="action in detail.verdict.availableActions"
          :key="action"
          class="btn"
          type="button"
          @click="runAction(action)"
        >
          {{ action }}
        </button>
        <span v-if="!detail.verdict.availableActions.length" class="readonly-tag">只读，无可执行动作</span>
      </div>

      <h3 class="section-title">流转记录</h3>
      <table class="data-table">
        <thead>
          <tr><th>动作</th><th>从状态</th><th>到状态</th><th>时间</th><th>操作人</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="record in detail.verdict.flowLog" :key="record.id">
            <td>{{ record.动作 }}</td>
            <td>{{ record.从状态 }}</td>
            <td>{{ record.到状态 }}</td>
            <td>{{ record.时间 }}</td>
            <td>{{ record.操作人 }}</td>
            <td>{{ record.备注 }}</td>
          </tr>
          <tr v-if="!detail.verdict.flowLog.length">
            <td colspan="6" class="empty-state">暂无流转记录</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">复核事项</h3>
      <table class="data-table">
        <thead>
          <tr><th>来源模块</th><th>来源编号</th><th>内容</th><th>时间</th><th>记录人</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.verdict.reviewItems" :key="item.id">
            <td>{{ item.来源模块 }}</td>
            <td>{{ item.来源编号 }}</td>
            <td>{{ item.内容 }}</td>
            <td>{{ item.时间 }}</td>
            <td>{{ item.记录人 }}</td>
          </tr>
          <tr v-if="!detail.verdict.reviewItems.length">
            <td colspan="5" class="empty-state">暂无复核事项，可由仪器检定入口联动补登</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="packet" class="print-packet">
      <h3>{{ packet.标题 }}</h3>
      <p>方案结论：{{ packet.结论 }} · 当前状态：{{ packet.状态 }} · 第 {{ packet.版本 }} 版</p>
      <table class="packet-table">
        <tbody>
          <tr v-for="field in packet.基本信息" :key="field.label">
            <th>{{ field.label }}</th>
            <td>{{ field.value }}</td>
          </tr>
        </tbody>
      </table>
      <h4>流转记录</h4>
      <table class="packet-table">
        <thead>
          <tr><th>动作</th><th>从状态</th><th>到状态</th><th>时间</th><th>操作人</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="record in packet.流转记录" :key="record.id">
            <td>{{ record.动作 }}</td>
            <td>{{ record.从状态 }}</td>
            <td>{{ record.到状态 }}</td>
            <td>{{ record.时间 }}</td>
            <td>{{ record.操作人 }}</td>
            <td>{{ record.备注 }}</td>
          </tr>
          <tr v-if="!packet.流转记录.length">
            <td colspan="6">暂无流转记录</td>
          </tr>
        </tbody>
      </table>
      <h4>复核事项</h4>
      <table class="packet-table">
        <thead>
          <tr><th>来源模块</th><th>来源编号</th><th>内容</th><th>时间</th><th>记录人</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in packet.复核事项" :key="item.id">
            <td>{{ item.来源模块 }}</td>
            <td>{{ item.来源编号 }}</td>
            <td>{{ item.内容 }}</td>
            <td>{{ item.时间 }}</td>
            <td>{{ item.记录人 }}</td>
          </tr>
          <tr v-if="!packet.复核事项.length">
            <td colspan="5">暂无复核事项</td>
          </tr>
        </tbody>
      </table>
      <p class="packet-sign">编制人签字：__________ · 批准人签字：__________</p>
      <p class="packet-meta">打印人：{{ packet.打印人 }} · 打印时间：{{ packet.打印时间 }}</p>
    </div>

    <footer class="page-foot no-print">
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
  <section v-else class="page">
    <p class="empty-state">没有找到该测报方案，可能已被清理。</p>
    <button class="btn" type="button" @click="backToList">返回列表</button>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { getPlanDetail, getPlanPrintPacket, runPlanAction } from '@/api/local-service'
import type { PlanListItem, PlanPrintPacket } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const store = useSessionStore()

const baseFields = ["方案编号", "方案名称", "版本", "适用范围", "监测项目", "测次安排", "编制人", "批准人"]

const detail = ref<PlanListItem | null>(null)
const packet = ref<PlanPrintPacket | null>(null)
const message = ref('')
const messageOk = ref(false)

function planId(): number {
  return Number(route.params.id)
}

function backToList() {
  router.push({ name: 'plan' })
}

function printPacket() {
  window.print()
}

function runAction(action: string) {
  const result = runPlanAction(planId(), action, store.operator)
  messageOk.value = result.ok
  message.value = result.message
  reload()
}

function reload() {
  detail.value = getPlanDetail(planId())
  packet.value = getPlanPrintPacket(planId(), store.operator)
}

onMounted(reload)
</script>
