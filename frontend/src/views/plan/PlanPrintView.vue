<template>
  <section v-if="group" class="page">
    <PlanPrintPack :group="group" :reviews="reviews" />
  </section>
  <section v-else class="page">
    <p class="error-text">没有找到该测报方案，可能已被重置或编号有误。</p>
    <RouterLink class="btn" to="/plan">返回方案列表</RouterLink>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { listRows } from '@/data/local-store'
import { findGroup } from '@/domain/plan-status'
import { listReviews, reviewsForGroup } from '@/domain/plan-service'
import { useActor } from '@/domain/use-actor'
import PlanPrintPack from './PlanPrintPack.vue'

const route = useRoute()
const { actor } = useActor()
const groupCode = String(route.params.code ?? '')

const group = computed(() => findGroup(listRows('plan'), listReviews(), groupCode, actor.value) ?? null)
const reviews = computed(() => reviewsForGroup(groupCode))
</script>
