import { apiBaseURL } from '@/services/client'

const getApiOrigin = () => {
  if (!apiBaseURL) return window.location.origin
  return new URL(apiBaseURL, window.location.origin).origin
}

export function buildAbsoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${getApiOrigin()}${normalizedPath}`
}

export function buildRetrieveUrl(code: string): string {
  return `${window.location.origin}/#/?code=${code}`
}

export function buildDownloadUrl(downloadUrl: string | null): string {
  return downloadUrl ? buildAbsoluteUrl(downloadUrl) : ''
}

export function buildReceivedRecordQrValue(record: {
  code: string
  downloadUrl: string | null
}): string {
  return record.downloadUrl ? buildDownloadUrl(record.downloadUrl) : buildRetrieveUrl(record.code)
}

export function buildSentRecordQrValue(record: { retrieveCode: string }): string {
  return buildRetrieveUrl(record.retrieveCode)
}

export function buildWgetCommand(retrieveCode: string, fileName: string): string {
  return `wget ${buildAbsoluteUrl(`/share/select?code=${retrieveCode}`)} -O "${fileName}"`
}

/**
 * P2P 信令的 WebSocket 地址。
 * 只在这里把 http(s) 协议映射成 ws(s)，避免其它模块直接读 window.location。
 */
export function buildP2PSignalUrl(
  code: string,
  role: 'publisher' | 'downloader',
  token?: string
): string {
  const signalOrigin = getApiOrigin().replace(/^https/i, 'wss').replace(/^http/i, 'ws')
  const params = new URLSearchParams({ role })
  if (token) {
    params.set('token', token)
  }
  return `${signalOrigin}/p2p/signal/${encodeURIComponent(code)}?${params.toString()}`
}
