import { computed, ref, shallowRef } from 'vue'
import { P2PService } from '@/services'
import type { P2PIceServer, P2PSignalMessage, P2PTransport } from '@/types'
import {
  P2P_CHUNK_SIZE,
  buildChunkFrame,
  chunkCountFor,
  crc32Hex,
  crc32Update,
  encodeControlFrame,
  readChunkAt
} from '@/utils/p2p-transfer'
import { buildP2PSignalUrl } from '@/utils/share-url'

export type P2PPublishPhase =
  | 'idle'
  | 'publishing'
  | 'waiting'
  | 'serving'
  | 'stopped'
  | 'error'

type PeerSession = {
  peerId: string
  connection: RTCPeerConnection
  channel: RTCDataChannel | null
  busy: boolean
  sentBytes: number
}

/** 心跳间隔：后端 heartbeat_timeout 默认 30s，留出充足余量 */
const HEARTBEAT_INTERVAL_MS = 10000
/** DataChannel 缓冲高水位，超过则等 bufferedamountlow（背压） */
const BUFFER_HIGH_WATER = 8 * 1024 * 1024

const toRtcIceServers = (servers: P2PIceServer[]): RTCIceServer[] =>
  servers.map((server) => ({
    urls: server.urls,
    username: server.username,
    credential: server.credential
  }))

export function useP2PPublisher() {
  const phase = ref<P2PPublishPhase>('idle')
  const code = ref('')
  const publishToken = ref('')
  const fileName = ref('')
  const fileSize = ref(0)
  const expiresAt = ref<string | null>(null)
  const servedCount = ref(0)
  const activePeers = ref(0)
  const transferredBytes = ref(0)
  const currentChunk = ref(0)
  const totalChunks = ref(0)
  const errorMessage = ref('')
  const maxPeers = ref(0)
  const lastTransport = ref<P2PTransport | null>(null)

  const sourceFile = shallowRef<File | null>(null)
  const iceServers = ref<RTCIceServer[]>([])
  const sessions = new Map<string, PeerSession>()
  let socket: WebSocket | null = null
  let heartbeatTimer: number | null = null
  let wakeLock: { release: () => Promise<void> } | null = null
  let unloadHandler: ((event: BeforeUnloadEvent) => void) | null = null

  const isActive = computed(
    () => phase.value === 'publishing' || phase.value === 'waiting' || phase.value === 'serving'
  )

  const progress = computed(() => {
    const total = sourceFile.value?.size ?? 0
    if (!total) return 0
    return Math.min(100, Math.round((transferredBytes.value / total) * 100))
  })

  const releaseWakeLock = async () => {
    if (!wakeLock) return
    const lock = wakeLock
    wakeLock = null
    try {
      await lock.release()
    } catch {
      /* 释放失败不影响主流程 */
    }
  }

  const detachUnloadGuard = () => {
    if (unloadHandler) {
      window.removeEventListener('beforeunload', unloadHandler)
      unloadHandler = null
    }
  }

  const attachKeepAlive = async () => {
    if (!unloadHandler) {
      unloadHandler = (event: BeforeUnloadEvent) => {
        if (!isActive.value) return
        event.preventDefault()
        event.returnValue = ''
      }
      window.addEventListener('beforeunload', unloadHandler)
    }

    if (!wakeLock) {
      try {
        const target = navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> }
        }
        wakeLock = (await target.wakeLock?.request('screen')) ?? null
      } catch {
        wakeLock = null
      }
    }
  }

  const sendSignal = (payload: Record<string, unknown>) => {
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(payload))
  }

  const teardownSessions = () => {
    sessions.forEach((session) => {
      try {
        session.channel?.close()
      } catch {
        /* 忽略关闭异常 */
      }
      try {
        session.connection.close()
      } catch {
        /* 忽略关闭异常 */
      }
    })
    sessions.clear()
    activePeers.value = 0
  }

  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const waitForBuffer = (channel: RTCDataChannel) =>
    new Promise<void>((resolve) => {
      if (channel.bufferedAmount <= BUFFER_HIGH_WATER) {
        resolve()
        return
      }
      channel.bufferedAmountLowThreshold = BUFFER_HIGH_WATER / 2
      const onLow = () => {
        channel.removeEventListener('bufferedamountlow', onLow)
        resolve()
      }
      channel.addEventListener('bufferedamountlow', onLow)
    })

  const streamFileToPeer = async (session: PeerSession) => {
    const file = sourceFile.value
    const channel = session.channel
    if (!file || !channel || channel.readyState !== 'open' || session.busy) return

    session.busy = true
    phase.value = 'serving'
    currentChunk.value = 0

    try {
      let checksum = 0
      const total = chunkCountFor(file.size, P2P_CHUNK_SIZE)

      for (let index = 0; index < total; index += 1) {
        if (channel.readyState !== 'open') throw new Error('channel_closed')
        const payload = await readChunkAt(file, index, P2P_CHUNK_SIZE)
        checksum = crc32Update(checksum, payload)
        await waitForBuffer(channel)
        channel.send(buildChunkFrame(index, payload))
        session.sentBytes += payload.byteLength
        currentChunk.value = index + 1
        transferredBytes.value = session.sentBytes
      }

      channel.send(encodeControlFrame({ k: 'end', checksum: crc32Hex(checksum) }))
      servedCount.value += 1
      lastTransport.value = 'direct'
      sendSignal({
        t: 'done',
        peer: session.peerId,
        bytes: file.size,
        mode: 'direct'
      })
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
    } finally {
      session.busy = false
      phase.value = sessions.size > 0 ? 'waiting' : 'waiting'
    }
  }

  const createSession = async (peerId: string, initiator: boolean) => {
    if (sessions.has(peerId)) return sessions.get(peerId) as PeerSession

    const connection = new RTCPeerConnection({ iceServers: iceServers.value })
    const session: PeerSession = {
      peerId,
      connection,
      channel: null,
      busy: false,
      sentBytes: 0
    }
    sessions.set(peerId, session)
    activePeers.value = sessions.size

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          t: 'ice',
          peer: peerId,
          candidate: event.candidate.toJSON()
        })
      }
    }

    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        sessions.delete(peerId)
        activePeers.value = sessions.size
      }
    }

    if (initiator) {
      const channel = connection.createDataChannel('file', { ordered: true })
      channel.binaryType = 'arraybuffer'
      session.channel = channel
      channel.onopen = () => {
        const file = sourceFile.value
        if (!file) return
        channel.send(
          encodeControlFrame({
            k: 'meta',
            name: file.name,
            size: file.size,
            chunkSize: P2P_CHUNK_SIZE,
            totalChunks: chunkCountFor(file.size, P2P_CHUNK_SIZE),
            checksum: ''
          })
        )
        void streamFileToPeer(session)
      }

      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      sendSignal({
        t: 'offer',
        peer: peerId,
        sdp: { type: offer.type, sdp: offer.sdp }
      })
    }

    return session
  }

  const handleSignal = async (message: P2PSignalMessage) => {
    const type = String(message.t || '').toLowerCase()

    // 连接建立时后端会下发房间快照；若发布者后上线，已有下载者只在这里出现
    if (type === 'room') {
      const peers = Array.isArray(message.peers) ? message.peers : []
      for (const item of peers) {
        const peerId = String((item as { peer?: string } | null)?.peer || '')
        if (peerId && !sessions.has(peerId)) {
          await createSession(peerId, true)
        }
      }
      return
    }

    if (type === 'peer-join') {
      const peerId = String(message.peer || '')
      if (peerId) {
        await createSession(peerId, true)
      }
      return
    }

    if (type === 'peer-left') {
      const peerId = String(message.peer || '')
      const session = sessions.get(peerId)
      if (session) {
        try {
          session.connection.close()
        } catch {
          /* 忽略 */
        }
        sessions.delete(peerId)
        activePeers.value = sessions.size
      }
      return
    }

    if (type === 'answer') {
      const peerId = String(message.from || '')
      const session = sessions.get(peerId)
      if (!session) return
      const sdp = message.sdp as RTCSessionDescriptionInit | undefined
      if (sdp) {
        await session.connection.setRemoteDescription(new RTCSessionDescription(sdp))
      }
      return
    }

    if (type === 'ice') {
      const peerId = String(message.from || '')
      const session = sessions.get(peerId)
      const candidate = message.candidate as RTCIceCandidateInit | undefined
      if (session && candidate) {
        try {
          await session.connection.addIceCandidate(new RTCIceCandidate(candidate))
        } catch {
          /* 单条候选失败不致命 */
        }
      }
      return
    }

    if (type === 'error') {
      const errorCode = String(message.code || '')
      if (errorCode === 'relay_unavailable') {
        lastTransport.value = null
        return
      }
      errorMessage.value = String(message.message || errorCode)
      return
    }
  }

  const openSocket = () => {
    const url = buildP2PSignalUrl(code.value, 'publisher', publishToken.value)
    const ws = new WebSocket(url)
    socket = ws

    ws.onopen = () => {
      phase.value = 'waiting'
      sendSignal({ t: 'hello' })
      stopHeartbeat()
      heartbeatTimer = window.setInterval(() => {
        sendSignal({ t: 'ping' })
      }, HEARTBEAT_INTERVAL_MS)
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
      if (phase.value !== 'stopped') {
        errorMessage.value = 'signaling_error'
      }
    }

    ws.onclose = (event) => {
      stopHeartbeat()
      if (phase.value === 'stopped' || phase.value === 'idle') return
      phase.value = 'error'
      errorMessage.value = `signaling_closed_${event.code}`
    }
  }

  const publish = async (file: File, expireValue: number, expireStyle: string) => {
    phase.value = 'publishing'
    errorMessage.value = ''
    transferredBytes.value = 0
    servedCount.value = 0

    try {
      const iceResponse = await P2PService.ice()
      iceServers.value = toRtcIceServers(iceResponse.detail?.ice_servers ?? [])

      const response = await P2PService.publish({
        file_name: file.name,
        file_size: file.size,
        expire_value: expireValue,
        expire_style: expireStyle
      })

      if (response.code !== 200 || !response.detail) {
        throw new Error(response.message || response.msg || 'publish_failed')
      }

      sourceFile.value = file
      code.value = response.detail.code
      publishToken.value = response.detail.publish_token
      fileName.value = response.detail.name
      fileSize.value = response.detail.size
      expiresAt.value = response.detail.expires_at
      maxPeers.value = response.detail.max_peers
      totalChunks.value = chunkCountFor(file.size, P2P_CHUNK_SIZE)

      await attachKeepAlive()
      openSocket()

      return response.detail
    } catch (error) {
      phase.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  const stop = async (unpublish = true) => {
    const stoppingCode = code.value
    const stoppingToken = publishToken.value
    phase.value = 'stopped'
    stopHeartbeat()
    detachUnloadGuard()
    await releaseWakeLock()
    teardownSessions()

    if (socket) {
      const ws = socket
      socket = null
      try {
        ws.close(1000, 'publisher stopped')
      } catch {
        /* 忽略 */
      }
    }

    if (unpublish && stoppingCode && stoppingToken) {
      try {
        await P2PService.unpublish(stoppingCode, stoppingToken)
      } catch {
        /* 下线失败不阻塞前端状态收敛 */
      }
    }
  }

  const reset = () => {
    phase.value = 'idle'
    code.value = ''
    publishToken.value = ''
    fileName.value = ''
    fileSize.value = 0
    expiresAt.value = null
    servedCount.value = 0
    activePeers.value = 0
    transferredBytes.value = 0
    currentChunk.value = 0
    totalChunks.value = 0
    errorMessage.value = ''
    lastTransport.value = null
    sourceFile.value = null
  }

  return {
    phase,
    code,
    fileName,
    fileSize,
    expiresAt,
    servedCount,
    activePeers,
    transferredBytes,
    currentChunk,
    totalChunks,
    errorMessage,
    maxPeers,
    lastTransport,
    progress,
    isActive,
    publish,
    stop,
    reset
  }
}
