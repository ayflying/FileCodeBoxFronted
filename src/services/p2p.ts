import api from './client'
import type {
  ApiResponse,
  P2PIceResponse,
  P2PPublishResponse,
  P2PStatusResponse
} from '@/types'

export type P2PPublishInput = {
  file_name: string
  file_size: number
  expire_value: number
  expire_style: string
}

export type P2PUnpublishResult = {
  code: string
  status: string
}

/**
 * P2P 直传控制面。文件始终留在发布者浏览器里，服务端只登记元数据。
 * 信令走 WebSocket（见 utils/share-url.ts 的 buildP2PSignalUrl）。
 */
export class P2PService {
  static async publish(payload: P2PPublishInput): Promise<ApiResponse<P2PPublishResponse>> {
    return api.post('/p2p/publish', payload)
  }

  static async status(code: string): Promise<ApiResponse<P2PStatusResponse>> {
    return api.get(`/p2p/status/${encodeURIComponent(code)}`)
  }

  static async unpublish(
    code: string,
    publishToken: string
  ): Promise<ApiResponse<P2PUnpublishResult>> {
    return api.post('/p2p/unpublish', { code, publish_token: publishToken })
  }

  static async ice(): Promise<ApiResponse<P2PIceResponse>> {
    return api.post('/p2p/ice')
  }
}
