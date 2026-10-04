import { computed, ref } from 'vue'

import type { Actor } from '@/domain/plan-types'

// 方案提交/批准与检定联动共用的当前操作人：身份决定能不能动作（编制人提交、审批人批准，禁止越级）。
const name = ref('值班管理员')
const role = ref<Actor['role']>('审批人')

export function useActor() {
  const actor = computed<Actor>(() => ({ name: name.value.trim(), role: role.value }))
  function setName(value: string) {
    name.value = value
  }
  function setRole(value: Actor['role']) {
    role.value = value
  }
  return { name, role, actor, setName, setRole }
}
