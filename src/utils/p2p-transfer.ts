/**
 * P2P 直传的数据面协议（浏览器 ↔ 浏览器，服务端不参与）。
 *
 * 为什么用 CRC32 而不是 SHA-256：`crypto.subtle` 只在安全上下文（HTTPS /
 * localhost）可用，而本部署跑在 http://<lan-ip>:32345 上，`isSecureContext`
 * 为 false。为保证两种环境下校验逻辑一致，这里用可增量的纯 JS CRC32 同时
 * 承担「每块校验」与「整文件校验」。
 */

/**
 * 单块 payload 大小。数据帧总大小 = 8B 帧头 + P2P_CHUNK_SIZE，
 * 必须严格小于浏览器 SCTP 单条消息上限（max-message-size，Chromium 间协商为
 * 262144B，历史上Firefox 最低为 65536B）。此前取 256KB 时加上帧头恰好超限
 * 8 字节，导致每一帧都 `Trying to send message larger than max-message-size`，
 * 传输 100% 失败。取 32KB 在所有浏览器下都有充足余量。
 */
export const P2P_CHUNK_SIZE = 32 * 1024

/** 数据帧头：[4B 块序号][4B CRC32]，均大端 */
export const P2P_FRAME_HEADER_BYTES = 8

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 可增量：把上一次的返回值作为下一次的 seed 即可得到累计校验值。 */
export function crc32Update(seed: number, bytes: Uint8Array): number {
  let crc = (seed ^ 0xffffffff) >>> 0
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function crc32Hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

export type P2PChunkFrame = {
  index: number
  payload: Uint8Array
}

export function buildChunkFrame(index: number, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(P2P_FRAME_HEADER_BYTES + payload.byteLength)
  const view = new DataView(buffer)
  view.setUint32(0, index, false)
  view.setUint32(4, crc32Update(0, payload), false)
  new Uint8Array(buffer, P2P_FRAME_HEADER_BYTES).set(payload)
  return buffer
}

/** 校验失败返回 null，由调用方决定重试或中断。 */
export function parseChunkFrame(frame: ArrayBuffer): P2PChunkFrame | null {
  if (frame.byteLength <= P2P_FRAME_HEADER_BYTES) return null
  const view = new DataView(frame)
  const index = view.getUint32(0, false)
  const checksum = view.getUint32(4, false)
  const payload = new Uint8Array(frame, P2P_FRAME_HEADER_BYTES)
  if (crc32Update(0, payload) !== checksum) return null
  return { index, payload }
}

export type P2PFileMeta = {
  name: string
  size: number
  chunkSize: number
  totalChunks: number
  checksum: string
}

export type P2PControlFrame =
  | ({ k: 'meta' } & P2PFileMeta)
  | { k: 'end'; checksum: string }
  | { k: 'abort'; reason?: string }

export function encodeControlFrame(frame: P2PControlFrame): string {
  return JSON.stringify(frame)
}

export function decodeControlFrame(raw: string): P2PControlFrame | null {
  try {
    const parsed = JSON.parse(raw) as P2PControlFrame
    if (!parsed || typeof parsed !== 'object' || typeof parsed.k !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function chunkCountFor(size: number, chunkSize: number = P2P_CHUNK_SIZE): number {
  if (size <= 0) return 0
  return Math.ceil(size / chunkSize)
}

export async function readChunkAt(
  file: File,
  index: number,
  chunkSize: number = P2P_CHUNK_SIZE
): Promise<Uint8Array> {
  const start = index * chunkSize
  const end = Math.min(start + chunkSize, file.size)
  const buffer = await file.slice(start, end).arrayBuffer()
  return new Uint8Array(buffer)
}

export function buildFileMeta(file: File, chunkSize: number = P2P_CHUNK_SIZE): P2PFileMeta {
  return {
    name: file.name,
    size: file.size,
    chunkSize,
    totalChunks: chunkCountFor(file.size, chunkSize),
    checksum: ''
  }
}

export function canStreamToDisk(): boolean {
  const target = window as Window & { showSaveFilePicker?: unknown }
  return window.isSecureContext && typeof target.showSaveFilePicker === 'function'
}

/**
 * 非流式回退路径的内存上限（见设计文档 D9）。
 * HTTP 明文访问时浏览器不暴露 File System Access API（仅 HTTPS/localhost），
 * 只能走内存拼 Blob；Chromium 的 Blob storage 会自动把大 Blob 落盘缓存，
 * 桌面环境 2GB 以内可靠（峰值内存约为文件大小的 2 倍）。
 */
export const P2P_BLOB_FALLBACK_LIMIT = 2 * 1024 * 1024 * 1024

export type P2PWriteSink = {
  readonly streaming: boolean
  write: (payload: Uint8Array) => Promise<void>
  finalize: () => Promise<void>
  abort: () => Promise<void>
}

type WritableStreamLike = {
  write: (data: Uint8Array) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<WritableStreamLike>
  }>
}

export type P2PSinkSaveHandler = (blob: Blob, fileName: string) => Promise<void>

/**
 * 建一个落盘 sink。
 * - 支持 File System Access API 时边收边写（大文件友好）；
 * - 否则在内存里拼 Blob，由 saveBlob 在 finalize 时交给下载动作保存。
 */
export async function createP2PWriteSink(
  fileName: string,
  size: number,
  saveBlob: P2PSinkSaveHandler
): Promise<P2PWriteSink> {
  const target = window as SavePickerWindow

  if (canStreamToDisk() && target.showSaveFilePicker) {
    try {
      const handle = await target.showSaveFilePicker({ suggestedName: fileName })
      const stream = await handle.createWritable()
      return {
        streaming: true,
        write: (payload) => stream.write(payload),
        finalize: () => stream.close(),
        abort: () => stream.abort()
      }
    } catch {
      // 缺少用户手势（SecurityError）或用户取消时回退到内存拼装
    }
  }

  if (size > P2P_BLOB_FALLBACK_LIMIT) {
    throw new Error('blob_fallback_too_large')
  }

  const parts: BlobPart[] = []
  return {
    streaming: false,
    write: async (payload) => {
      parts.push(payload.slice())
    },
    finalize: async () => {
      await saveBlob(new Blob(parts), fileName)
      parts.length = 0
    },
    abort: async () => {
      parts.length = 0
    }
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`
}