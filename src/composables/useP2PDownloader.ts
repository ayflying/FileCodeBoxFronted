import { computed, ref, shallowRef } from 'vue'
import { P2PService } from '@/services'
import type { P2PIceServer, P2PSignalMessage, P2PStatusResponse, P2PTransport } from '@/types'
import { saveBlobAsDownload } from '@/utils/download-action'
import {
  createP2PWriteSink,
  crc32Hex,
  crc32Update,
  decodeControlFrame,
  encodeControlFrame,
  parseChunkFrame,
  type P2PFileMeta,
  type P2PWriteSink
} from '@/utils/p2p-transfer'
import { buildP2PSignalUrl } from '@/utils/share-url'

export type P2PDownloadPhase =
  | 'idle'
  | 'checking'
  | 'connecting'
  | 'waiting'
  | 'receiving'
  | 'completed'
  | 'failed'

const toRtcIceServers = (servers: P2PIceServer[]): RTCIceServer[] =>
  servers.map((server) => ({
    urls: server.urls,
    username: server.username,
    credential: server.credential
  }))

export function useP2PDownloader() {
  const phase = ref<P2PDownloadPhase>('idle')
  const remoteStatus = ref<P2PStatusResponse | null>(null)
  const receivedBytes = ref(0)
  const totalBytes = ref(0)
  const errorMessage = ref('')
  const savedName = ref('')
  const verified = ref<boolean | null>(null)
  const transport = ref<P2PTransport | null>(null)
  const isP2PShare = ref(false)

  const sink = shallowRef<P2PWriteSink | null>(null)
  let socket: WebSocket | null = null
  let peerConnection: RTCPeerConnection | null = null
  let dataChannel: RTCDataChannel | null = null
  let heartbeatTimer = 0
  let queue: Promise<void> = Promise.resolve()
  let lastSampleAt = 0
  let lastSampleBytes = 0
  let expectedChecksum = 0
  let expectedChunkIndex = 0
  const iceServers = ref<RTCIceServer[]>([])
  const speed = ref(0)

  const progress = computed(() => {
    if (!totalBytes.value) return 0
    return Math.min(100, Math.round((receivedBytes.value / totalBytes.value) * 100))
  })

  const isBusy = computed(
    () =>
      phase.value === 'checking' ||
      phase.value === 'connecting' ||
      phase.value === 'waiting' ||
      phase.value === 'receiving'
  )

  const cleanup = () => {
    window.clearInterval(heartbeatTimer)
    heartbeatTimer = 0
    try {
      peerConnection?.close()
    } catch {
      /* 忽略 */
    }
    peerConnection = null
    dataChannel = null

    if (socket) {
      const ws = socket
      socket = null
      try {
        ws.close(1000, 'downloader closed')
      } catch {
        /* 忽略 */
      }
    }

    queue = Promise.resolve()
  }

  /** 通道仍可用时告知发布端停止发送，避免发布端继续向已断开的通道写数据 */
  const notifyAbort = (reason: string) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      try {
        dataChannel.send(encodeControlFrame({ k: 'abort', reason }))
      } catch {
        /* 通道已不可用 */
      }
    }
  }

  const fail = async (reason: string) => {
    notifyAbort(reason)
    errorMessage.value = reason
    phase.value = 'failed'
    try {
      await sink.value?.abort()
    } catch {
      /* 忽略 */
    }
    sink.value = null
    cleanup()
  }

  const sendSignal = (payload: Record<string, unknown>) => {
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(payload))
  }

  const updateSpeed = () => {
    const now = performance.now()
    if (lastSampleAt > 0 && now > lastSampleAt) {
      const deltaBytes = receivedBytes.value - lastSampleBytes
      speed.value = (deltaBytes / (now - lastSampleAt)) * 1000
    }
    lastSampleAt = now
    lastSampleBytes = receivedBytes.value
  }

  const handleControlFrame = async (raw: string) => {
    const control = decodeControlFrame(raw)
    if (!control) return

    if (control.k === 'meta') {
      const meta: P2PFileMeta = control
      totalBytes.value = meta.size
      receivedBytes.value = 0
      lastSampleAt = 0
      lastSampleBytes = 0
      phase.value = 'receiving'
      try {
        sink.value = await createP2PWriteSink(meta.name, meta.size, saveBlobAsDownload)
        savedName.value = meta.name
      } catch (error) {
        await fail(error instanceof Error ? error.message : 'sink_unavailable')
      }
      return
    }

    if (control.k === 'end') {
      const current = sink.value
      sink.value = null
      if (!current) {
        await fail('missing_sink')
        return
      }
      try {
        await current.finalize()
      } catch (error) {
        await fail(error instanceof Error ? error.message : 'finalize_failed')
        return
      }
      verified.value = crc32Hex(expectedChecksum) === control.checksum
      phase.value = 'completed'
      transport.value = 'direct'
      cleanup()
      return
    }

    if (control.k === 'abort') {
      await fail(control.reason || 'publisher_aborted')
    }
  }

  const handleBinaryFrame = async (frame: ArrayBuffer) => {
    const parsed = parseChunkFrame(frame)
    if (!parsed) {
      await fail('chunk_checksum_failed')
      return
    }
    if (parsed.index !== expectedChunkIndex) {
      await fail(`chunk_out_of_order_${parsed.index}`)
      return
    }

    expectedChecksum = crc32Update(expectedChecksum, parsed.payload)
    expectedChunkIndex += 1

    try {
      await sink.value?.write(parsed.payload)
    } catch (error) {
      await fail(error instanceof Error ? error.message : 'write_failed')
      return
    }

    receivedBytes.value += parsed.payload.byteLength
    updateSpeed()
  }

  const attachChannel = (channel: RTCDataChannel) => {
    dataChannel = channel
    channel.binaryType = 'arraybuffer'
    expectedChunkIndex = 0
    expectedChecksum = 0

    channel.onmessage = (event) => {
      const data = event.data
      queue = queue.then(async () => {
        if (typeof data === 'string') {
          await handleControlFrame(data)
          return
        }
        if (data instanceof ArrayBuffer) {
          await handleBinaryFrame(data)
        }
      })
    }

    channel.onclose = () => {
      if (phase.value === 'receiving' || phase.value === 'waiting') {
        void fail('channel_closed')
      }
    }
  }

  const handleSignal = async (message: P2PSignalMessage) => {
    const type = String(message.t || '').toLowerCase()

    if (type === 'offer') {
      const sdp = message.sdp as RTCSessionDescriptionInit | undefined
      if (!sdp) return

      const connection = new RTCPeerConnection({ iceServers: iceServers.value })
      peerConnection = connection

      connection.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({ t: 'ice', candidate: event.candidate.toJSON() })
        }
      }

      connection.ondatachannel = (event) => {
        attachChannel(event.channel)
      }

      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'failed') {
          void fail('peer_connection_failed')
        }
      }

      await connection.setRemoteDescription(new RTCSessionDescription(sdp))
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      sendSignal({ t: 'answer', sdp: { type: answer.type, sdp: answer.sdp } })
      phase.value = 'waiting'
      return
    }

    if (type === 'ice') {
      const candidate = message.candidate as RTCIceCandidateInit | undefined
      if (peerConnection && candidate) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
        } catch {
          /* 单条候选失败不致命 */
        }
      }
      return
    }

    if (type === 'publisher-offline') {
      if (phase.value !== 'receiving' && phase.value !== 'completed') {
        await fail('publisher_offline')
      }
      return
    }

    if (type === 'error') {
      const errorCode = String(message.code || '')
      await fail(errorCode || 'signal_error')
    }
  }

  /** 判断取件码是否为 P2P 分享；非 P2P 返回 null，交回原流程处理。 */
  const inspect = async (code: string): Promise<P2PStatusResponse | null> => {
    phase.value = 'checking'
    errorMessage.value = ''
    try {
      const response = await P2PService.status(code)
      if (response.code === 200 && response.detail?.is_p2p) {
        remoteStatus.value = response.detail
        isP2PShare.value = true
        phase.value = 'idle'
        return response.detail
      }
      isP2PShare.value = false
      remoteStatus.value = null
      phase.value = 'idle'
      return null
    } catch {
      isP2PShare.value = false
      remoteStatus.value = null
      phase.value = 'idle'
      return null
    }
  }

  const download = async (code: string) => {
    errorMessage.value = ''
    verified.value = null
    receivedBytes.value = 0
    totalBytes.value = remoteStatus.value?.size ?? 0
    savedName.value = ''
    transport.value = null
    expectedChunkIndex = 0
    expectedChecksum = 0

    const status = remoteStatus.value ?? (await inspect(code))
    if (!status) {
      await fail('not_p2p_share')
      return
    }
    if (status.expired) {
      await fail('share_expired')
      return
    }
    if (!status.online) {
      await fail('publisher_offline')
      return
    }

    phase.value = 'connecting'
    try {
      const iceResponse = await P2PService.ice()
      iceServers.value = toRtcIceServers(iceResponse.detail?.ice_servers ?? [])
    } catch {
      /* 无 STUN/TURN 时仍可尝试本机直连 */
    }

    const ws = new WebSocket(buildP2PSignalUrl(code, 'downloader'))
    socket = ws

    ws.onopen = () => {
      phase.value = 'waiting'
      // 信令保活：传输中信令通道完全静默，跨网时空闲 TCP 会被 NAT/防火墙回收，
      // 后端 ping 对所有角色放行，借此保持信令链路活跃
      window.clearInterval(heartbeatTimer)
      heartbeatTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'ping' }))
        }
      }, 10000)
    }

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      try {
        void handleSignal(JSON.parse(event.data) as P2PSignalMessage)
      } catch {
        /* 非 JSON 帧忽略 */
      }
    }

    ws.onerror = () => {
      if (!isBusy.value) return
      void fail('signaling_error')
    }

    ws.onclose = (event) => {
      window.clearInterval(heartbeatTimer)
      if (phase.value === 'completed' || phase.value === 'failed') return
      // 直连已建立时信令断开不影响媒体面：meta/end/abort 全走 DataChannel 控制帧，
      // 此时绝不能 fail()——它会主动关闭还活着的 P2P 连接（自杀式中断）
      if (
        (phase.value === 'receiving' || phase.value === 'waiting') &&
        dataChannel?.readyState === 'open'
      ) {
        return
      }
      void fail(`signaling_closed_${event.code}`)
    }
  }

  const cancel = async () => {
    notifyAbort('downloader_cancelled')
    await sink.value?.abort()
    sink.value = null
    cleanup()
    phase.value = 'idle'
  }

  const reset = () => {
    void cancel()
    remoteStatus.value = null
    isP2PShare.value = false
    receivedBytes.value = 0
    totalBytes.value = 0
    errorMessage.value = ''
    savedName.value = ''
    verified.value = null
    speed.value = 0
    transport.value = null
    phase.value = 'idle'
  }

  return {
    phase,
    remoteStatus,
    receivedBytes,
    totalBytes,
    errorMessage,
    savedName,
    verified,
    speed,
    transport,
    isP2PShare,
    progress,
    isBusy,
    inspect,
    download,
    cancel,
    reset
  }
}
