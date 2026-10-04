<template>
  <section v-if="group" class="print-pack" data-print="plan">
    <header class="print-head">
      <h1>测报方案审批打印包</h1>
      <p class="print-sub">方案编号：{{ group.group }} ｜ 打印时间：{{ printedAt }}</p>
    </header>

    <article class="print-block">
      <h2>一、方案结论</h2>
      <table class="print-table">
        <tbody>
          <tr><th>方案名称</th><td>{{ group.name }}</td></tr>
          <tr><th>当前生效版本</th><td>V{{ group.latest.version }}</td></tr>
          <tr>
            <th>方案状态</th>
            <td>{{ latestStatus }}<span class="print-conclusion">（结论：{{ group.conclusion }}）</span></td>
          </tr>
          <tr><th>适用范围</th><td>{{ group.latest.record['适用范围'] }}</td></tr>
          <tr><th>监测项目</th><td>{{ group.latest.record['监测项目'] }}</td></tr>
          <tr><th>测次安排</th><td>{{ group.latest.record['测次安排'] }}</td></tr>
          <tr><th>编制人</th><td>{{ group.latest.record['编制人'] }}</td></tr>
          <tr><th>批准人</th><td>{{ group.latest.record['批准人'] || '—' }}</td></tr>
          <tr><th>待复核事项</th><td>{{ group.pendingReviews }} 项</td></tr>
        </tbody>
      </table>
    </article>

    <article class="print-block">
      <h2>二、版本沿革</h2>
      <table class="print-table">
        <thead>
          <tr><th>版本</th><th>状态</th><th>结论</th><th>是否只读</th></tr>
        </thead>
        <tbody>
          <tr v-for="view in group.versions" :key="view.record.id">
            <td>V{{ view.version }}<span v-if="view.isLatest" class="print-tag">最新</span></td>
            <td>{{ latestStatusOf(view.record.status) }}</td>
            <td>{{ view.conclusion }}</td>
            <td>{{ view.readOnly ? '历史版本（只读）' : '否' }}</td>
          </tr>
        </tbody>
      </table>
    </article>

    <article class="print-block">
      <h2>三、审批履历</h2>
      <table class="print-table">
        <thead>
          <tr><th>时间</th><th>操作人</th><th>动作</th><th>由</th><th>至</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in trail" :key="index">
            <td>{{ item.at }}</td>
            <td>{{ item.actor }}</td>
            <td>{{ item.action }}</td>
            <td>{{ item.from }}</td>
            <td>{{ item.to }}</td>
            <td>{{ item.note ?? '—' }}</td>
          </tr>
          <tr v-if="!trail.length">
            <td colspan="6" class="empty-state">暂无审批履历</td>
          </tr>
        </tbody>
      </table>
    </article>

    <article class="print-block">
      <h2>四、复核事项（检定入口联动）</h2>
      <table class="print-table">
        <thead>
          <tr><th>仪器编号</th><th>仪器名称</th><th>复核内容</th><th>状态</th><th>复核人</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in reviews" :key="item.id">
            <td>{{ item.instrumentNo }}</td>
            <td>{{ item.instrumentName }}</td>
            <td>{{ item.content }}</td>
            <td>{{ item.status }}</td>
            <td>{{ item.reviewer ?? '—' }}</td>
          </tr>
          <tr v-if="!reviews.length">
            <td colspan="5" class="empty-state">暂无复核事项</td>
          </tr>
        </tbody>
      </table>
    </article>

    <footer class="print-actions">
      <button class="btn primary" type="button" @click="doPrint">打印 / 另存为 PDF</button>
      <RouterLink class="btn" :to="`/plan/${group.group}`">返回方案详情</RouterLink>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { normalizeStatus, parseTrail } from '@/domain/plan-status'
import type { PlanGroupView, ReviewItem } from '@/domain/plan-types'

const props = defineProps<{ group: PlanGroupView; reviews: ReviewItem[] }>()

const printedAt = new Date().toLocaleString('zh-CN', { hour12: false })
const latestStatus = computed(() => normalizeStatus(props.group.latest.record.status))
const trail = computed(() => parseTrail(props.group.latest.record))
function latestStatusOf(status: unknown) {
  return normalizeStatus(status)
}
function doPrint() {
  window.print()
}
</script>
