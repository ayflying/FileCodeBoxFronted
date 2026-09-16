<template>
  <div
    class="rounded-2xl border p-4 transition-colors duration-300 sm:rounded-[1.5rem] sm:p-5"
    :class="
      isDarkMode
        ? 'border-zinc-800/70 bg-zinc-950/60'
        : 'border-slate-200/80 bg-slate-50/80'
    "
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <span class="relative flex h-2 w-2 shrink-0">
          <span
            v-if="state.isActive && state.phase !== 'stopped'"
            class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            :class="state.phase === 'serving' ? 'bg-emerald-400' : 'bg-amber-400'"
          ></span>
          <span class="relative inline-flex h-2 w-2 rounded-full" :class="dotClass"></span>
        </span>
        <span
          class="truncate text-sm font-semibold"
          :class="isDarkMode ? 'text-zinc-100' : 'text-zinc-900'"
        >
          {{ t('p2p.publish.title') }}
        </span>
      </div>
      <span
        class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
        :class="badgeClass"
      >
        {{ phaseText }}
      </span>
    </div>

    <div v-if="state.fileName" class="mt-3 flex items-center justify-between gap-3 text-xs">
      <span class="truncate" :class="isDarkMode ? 'text-zinc-300' : 'text-zinc-700'">
        {{ state.fileName }}
      </span>
      <span class="shrink-0 tabular-nums" :class="isDarkMode ? 'text-zinc-500' : 'text-slate-500'">
        {{ formattedSize }}
      </span>
    </div>

    <div v-if="state.code" class="mt-4">
      <p class="text-[11px] font-medium" :class="isDarkMode ? 'text-zinc-500' : 'text-slate-500'">
        {{ t('p2p.publish.codeLabel') }}
      </p>
      <div class="mt-1.5 flex items-center gap-2">
        <span
          class="flex-1 rounded-xl border px-3 py-2 text-center font-mono text-lg font-bold tracking-[0.3em]"
          :class="
            isDarkMode
              ? 'border-zinc-700/60 bg-zinc-900/70 text-zinc-100'
              : 'border-slate-200 bg-white text-zinc-900'
          "
        >
          {{ state.code }}
        </span>
      </div>
      <div class="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          class="rounded-xl border px-3 py-2 text-xs font-medium transition-colors"
          :class="actionClass"
          @click="emit('copy-code')"
        >
          {{ t('p2p.publish.copyCode') }}
        </button>
        <button
          type="button"
          class="rounded-xl border px-3 py-2 text-xs font-medium transition-colors"
          :class="actionClass"
          @click="emit('copy-link')"
        >
          {{ t('p2p.publish.copyLink') }}
        </button>
      </div>
    </div>

    <div v-if="state.isActive" class="mt-4 grid grid-cols-2 gap-2 text-xs">
      <div
        class="rounded-xl px-3 py-2"
        :class="isDarkMode ? 'bg-zinc-900/70' : 'bg-white'"
      >
        <p :class="isDarkMode ? 'text-zinc-500' : 'text-slate-500'">
          {{ t('p2p.publish.peers') }}
        </p>
        <p class="mt-0.5 font-semibold tabular-nums" :class="isDarkMode ? 'text-zinc-100' : 'text-zinc-900'">
          {{ state.activePeers }}<span v-if="state.maxPeers"> / {{ state.maxPeers }}</span>
        </p>
      </div>
      <div
        class="rounded-xl px-3 py-2"
        :class="isDarkMode ? 'bg-zinc-900/70' : 'bg-white'"
      >
        <p :class="isDarkMode ? 'text-zinc-500' : 'text-slate-500'">
          {{ t('p2p.publish.served') }}
        </p>
        <p class="mt-0.5 font-semibold tabular-nums" :class="isDarkMode ? 'text-zinc-100' : 'text-zinc-900'">
          {{ state.servedCount }}
        </p>
      </div>
    </div>

    <div v-if="state.phase === 'serving'" class="mt-4">
      <div class="flex items-center justify-between text-[11px]">
        <span :class="isDarkMode ? 'text-zinc-400' : 'text-slate-500'">
          {{ t('p2p.publish.progress') }}
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
          class="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
          :style="{ width: `${state.progress}%` }"
        ></div>
      </div>
      <p class="mt-1.5 text-[11px] tabular-nums" :class="isDarkMode ? 'text-zinc-500' : 'text-slate-500'">
        {{
          t('p2p.publish.chunkProgress', {
            current: state.currentChunk,
            total: state.totalChunks
          })
        }}
      </p>
    </div>

    <p
      v-if="state.errorMessage"
      class="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500"
    >
      {{ state.errorMessage }}
    </p>

    <p
      v-else-if="state.isActive"
      class="mt-3 text-[11px] leading-relaxed"
      :class="isDarkMode ? 'text-zinc-500' : 'text-slate-500'"
    >
      {{ t('p2p.publish.keepOpen') }}
    </p>

    <div class="mt-4 flex items-center gap-2">
      <button
        v-if="state.isActive"
        type="button"
        class="flex-1 rounded-xl border px-3 py-2 text-xs font-medium transition-colors"
        :class="actionClass"
        @click="emit('stop')"
      >
        {{ t('p2p.publish.stop') }}
      </button>
      <button
        v-else
        type="button"
        class="flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition-all"
        :class="
          isDarkMode
            ? 'bg-zinc-200 text-zinc-950 hover:bg-white'
            : 'bg-zinc-800 text-white hover:bg-zinc-900'
        "
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

export type P2PPublishPanelState = {
  phase: string
  code: string
  fileName: string
  fileSize: number
  progress: number
  servedCount: number
  activePeers: number
  currentChunk: number
  totalChunks: number
  maxPeers: number
  lastTransport: string | null
  errorMessage: string
  isActive: boolean
}

const props = defineProps<{ state: P2PPublishPanelState }>()

const emit = defineEmits<{
  stop: []
  close: []
  'copy-code': []
  'copy-link': []
}>()

const { t } = useI18n()
const isDarkMode = useInjectedDarkMode()

const formattedSize = computed(() => formatBytes(props.state.fileSize))

const phaseText = computed(() => {
  switch (props.state.phase) {
    case 'publishing':
      return t('p2p.publish.preparing')
    case 'waiting':
      return t('p2p.publish.waiting')
    case 'serving':
      return t('p2p.publish.serving')
    case 'stopped':
      return t('p2p.publish.stopped')
    case 'error':
      return t('p2p.publish.error')
    default:
      return t('p2p.publish.online')
  }
})

const dotClass = computed(() => {
  switch (props.state.phase) {
    case 'serving':
      return 'bg-emerald-500'
    case 'publishing':
    case 'waiting':
      return 'bg-amber-400'
    case 'error':
      return 'bg-red-500'
    default:
      return props.state.isActive ? 'bg-emerald-500' : 'bg-zinc-400'
  }
})

const badgeClass = computed(() => {
  switch (props.state.phase) {
    case 'serving':
      return isDarkMode.value ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-50 text-emerald-600'
    case 'publishing':
    case 'waiting':
      return isDarkMode.value ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-50 text-amber-600'
    case 'error':
      return isDarkMode.value ? 'bg-red-500/15 text-red-400' : 'bg-red-50 text-red-600'
    default:
      return isDarkMode.value ? 'bg-white/10 text-zinc-300' : 'bg-white text-zinc-600'
  }
})

const actionClass = computed(() =>
  isDarkMode.value
    ? 'border-zinc-700/60 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100'
    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-zinc-900'
)
</script>