/**
 * P2P 站点配置的读取归一化。
 *
 * 后端 `build_public_p2p_config()` 下发的是布尔值，但站点配置可经管理面板改写，
 * 落库后可能是 `0/1`、`"0"/"1"`、`"true"/"on"` 等形态。
 * 前端只在这一个地方做归一，避免各处自行判断出现 `"0"` 被当成真值的经典错误。
 */

const TRUTHY = new Set(['1', 'true', 'on', 'yes'])

export function isP2PFlagOn(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : fallback
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (!normalized) return fallback
    return TRUTHY.has(normalized)
  }
  return fallback
}

/** P2P 单文件上限，取值非法时退回 0（表示不限制）。 */
export function normalizeP2PMaxSize(value: unknown): number {
  const size = Number(value)
  return Number.isFinite(size) && size > 0 ? size : 0
}