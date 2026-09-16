export type P2PShareStatus = 'online' | 'offline' | 'expired'

export type P2PRole = 'publisher' | 'downloader'

export type P2PTransport = 'direct' | 'relay'

/** /p2p/publish 的返回：取件码 + 发布令牌（零等待，文件不上传） */
export interface P2PPublishResponse {
  code: string
  publish_token: string
  name: string
  size: number
  expires_at: string | null
  max_size: number
  relay_enabled: boolean
  heartbeat_timeout: number
  max_peers: number
}

/** /p2p/status/{code} 的返回：只给事实，不给预估在线时长 */
export interface P2PStatusResponse {
  code: string
  name: string
  size: number
  type: 'file' | 'text'
  is_text: boolean
  is_p2p: boolean
  online: boolean
  expired: boolean
  status: P2PShareStatus
  expired_at: string | null
  last_seen_ago: number | null
  served_count: number
  bytes_sent: number
  transport: P2PTransport | null
  downloaders: number
  max_peers: number
  relay_enabled: boolean
}

export interface P2PIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface P2PIceResponse {
  ice_servers: P2PIceServer[]
  turn_enabled: boolean
  turn_expires_at: string | null
  expires_in: number
}

/** 信令文本帧。后端允许的 t：ping/hello/offer/answer/ice/mode/done 等 */
export interface P2PSignalMessage {
  t: string
  peer?: string
  from?: string
  [key: string]: unknown
}

/** 房间快照（连接建立时后端主动下发） */
export interface P2PRoomSnapshot extends P2PSignalMessage {
  t: 'room'
  code: string
  role: P2PRole
  peer: string
  peers: Array<{ peer: string; peer_id: string; role: string; joined_at: number }>
  downloaders: number
  publisher_online: boolean
  max_peers: number
}
