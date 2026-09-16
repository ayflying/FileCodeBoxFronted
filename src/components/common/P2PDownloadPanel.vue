<template>
  <div
    class="rounded-2xl border p-4 transition-colors duration-300 sm:rounded-[1.5rem] sm:p-5"
    :class="
      isDarkMode ? 'border-zinc-800/70 bg-zinc-950/60' : 'border-slate-200/80 bg-slate-50/80'
    "
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <span class="relative flex h-2 w-2 shrink-0">
          <span
            v-if="isBusy"
            class="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60"
          ></span>
          <span class="relative inline-flex h-2 w-2 rounded-full" :class="dotClass"></span>
        </span>
        <span
          class="truncate text-sm font-semibold"
          :class="isDarkMode ? 'text-zinc-100' : 'text-zinc-900'"
        >
          {{ t('p2p.retrieve.badge') }}
        </span>
      </div>
      <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" :class="badgeClass">
        {{ onlineText }}
      </span>
    </div>

    <div v-if="state.name" class="mt-3 flex items-center justify-between gap-3 text-xs">
      <span class="truncate" :class="isDarkMode ? 'text-zinc-300' : 'text-zinc-700'">
        {{ state.name }}
      </span>
      <span class="shrink-0 tabular-nums" :class="isDarkMode ? 'text-zinc-500' : 'text-slate-500'">
        {{ formatBytes(state.size) }}
      </span>
    </div>

    <div v-if="state.expired" class="mt-3">
      <p class="text-xs text-amber-500">{{ t('p2p.retrieve.errors.share_expired') }}</p>
    </div>

    <div v-else-if="state.phase === 'idle' && !state.online" class="mt-3">
      <p class="text-xs text-amber-500">{{ t('p2p.retrieve.waitingPublisher') }}</p>
    </div>

    <div v-else-if="isBusy || state.phase === 'completed'" class="mt-4">
      <div class="flex items-center justify-between text-[11px]">
        <span :class="isDarkMode ? 'text-zinc-400' : 'text-slate-500'">
          {{ progressLabel }}
        </span>
        <span class="tabular-nums" :class="isDarkMode ? 'text-zinc-300' : 'text-zinc-700'">
          {{ state.progress }}%
        </span>
      </div>
      <div
        class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
        :class="isDarkMode ? 'bg-zinc-800' : 'bg-slate-200'"
      >
        <div
          class="h-full rounded-full transition-[width] duration-300"
          :class="state.phase === 'completed' ? 'bg-emerald-500' : 'bg-sky-500'"
          :style="{ width: `${state.progress}%` }"
        ></div>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        <span class="tabular-nums" :class="isDarkMode ? 'text-zinc-400' : 'text-slate-500'">
          {{
            t('p2p.retrieve.bytes', {
              received: formatBytes(state.receivedBytes),
              total: formatBytes(state.totalBytes || state.size)
            })
          }}
        </span>
        <span
          v-if="state.speed > 0 && isBusy"
          class="tabular-nums"
          :class="isDarkMode ? 'text-zinc-400' : 'text-slate-500'"
        >
          {{ t('p2p.retrieve.speed', { speed: formatBytes(state.speed) }) }}
        </span>
        <span v-if="state.transport" :class="isDarkMode ? 'text-zinc-500' : 'text-slate-400'">
          {{ state.transport === 'relay' ? 'Relay' : 'Direct' }}
        </span>
      </div>
      <p
        v-if="state.phase === 'completed'"
        class="mt-2 text-[11px]"
        :class="state.verified === false ? 'text-red-500' : 'text-emerald-500'"
      >
        {{
          state.verified === false
            ? t('p2p.retrieve.verifiedFail')
            : t('p2p.retrieve.verifiedOk')
        }}
      </p>
      <p
        v-if="state.phase === 'completed' && state.savedName"
        class="mt-1 text-[11px]"
        :class="isDarkMode ? 'text-zinc-500' : 'text-slate-500'"
      >
        {{ t('p2p.retrieve.savedAs', { name: state.savedName }) }}
      </p>
    </div>

    <p
      v-if="state.phase === 'failed' && errorText"
      class="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500"
    >
      {{ errorText }}
    </p>

    <div class="mt-4 flex items-center gap-2">
      <button
        v-if="state.phase === 'idle' && !state.expired"
        type="button"
        class="flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50"
        :class="
          isDarkMode
            ? 'bg-zinc-200 text-zinc-950 hover:bg-white'
            : 'bg-zinc-800 text-white hover:bg-zinc-900'
        "
        :disabled="!state.online"
        @click="emit('download')"
      >
        {{ t('p2p.retrieve.download') }}
      </button>
      <button
        v-else-if="isBusy"
        type="button"
        class="flex-1 rounded-xl border px-3 py-2 text-xs font-medium transition-colors"
        :class="actionClass"
        @click="emit('cancel')"
      >
        {{ t('p2p.retrieve.cancel') }}
      </button>
      <button
        type="button"
        class="flex-1 rounded-xl border px-3 py-2 text-xs font-medium transition-colors"
        :class="actionClass"
        @click="emit('close')"
      >
        {{ t('p2p.publish.close') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInjectedDarkMode } from '@/composables'
import { formatBytes } from '@/utils/p2p-transfer'

export type P2PDownloadPanelState = {
  phase: string
  name: string
  size: number
  online: boolean
  expired: boolean
  receivedBytes: number
  totalBytes: number
  progress: number
  speed: number
  transport: string | null
  savedName: string
  verified: boolean | null
  errorMessage: string
}

const props = defineProps<{ state: P2PDownloadPanelState }>()

const emit = defineEmits<{
  download: []
  cancel: []
  close: []
}>()

const { t } = useI18n()
const isDarkMode = useInjectedDarkMode()

const isBusy = computed(
  () =>
    props.state.phase === 'checking' ||
    props.state.phase === 'connecting' ||
    props.state.phase === 'waiting' ||
    props.state.phase === 'receiving'
)

const onlineText = computed(() =>
  props.state.online ? t('p2p.retrieve.online') : t('p2p.retrieve.offline')
)

const progressLabel = computed(() => {
  switch (props.state.phase) {
    case 'checking':
      return t('p2p.retrieve.connecting')
    case 'connecting':
    case 'waiting':
      return t('p2p.retrieve.connecting')
    case 'receiving':
      return t('p2p.retrieve.receiving')
    case 'completed':
      return t('p2p.retrieve.completed')
    default:
      return t('p2p.retrieve.downloading')
  }
})

const dotClass = computed(() => {
  if (props.state.expired) return 'bg-amber-400'
  if (isBusy.value) return 'bg-sky-500'
  if (props.state.phase === 'failed') return 'bg-red-500'
  if (props.state.phase === 'completed') return 'bg-emerald-500'
  return props.state.online ? 'bg-emerald-500' : 'bg-zinc-400'
})

const badgeClass = computed(() => {
  if (props.state.phase === 'failed') {
    return isDarkMode.value ? 'bg-red-500/15 text-red-400' : 'bg-red-50 text-red-600'
  }
  if (props.state.phase === 'completed') {
    return isDarkMode.value
      ? 'bg-emerald-500/15 text-emerald-400'
      : 'bg-emerald-50 text-emerald-600'
  }
  return props.state.online
    ? isDarkMode.value
      ? 'bg-emerald-500/15 text-emerald-400'
      : 'bg-emerald-50 text-emerald-600'
    : isDarkMode.value
      ? 'bg-amber-500/15 text-amber-400'
      : 'bg-amber-50 text-amber-600'
})

/** 后端返回的是错误标识（如 not_p2p_share），映射到文案；未知标识退回通用失败文案 */
const errorText = computed(() => {
  const raw = props.state.errorMessage
  if (!raw) return ''
  const key = `p2p.retrieve.errors.${raw}`
  const translated = t(key)
  return translated === key ? t('p2p.retrieve.failed') : translated
})

const actionClass = computed(() =>
  isDarkMode.value
    ? 'border-zinc-700/60 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100'
    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-zinc-900'
)
</script>