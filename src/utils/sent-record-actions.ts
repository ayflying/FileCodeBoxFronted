import type { SentFileRecord } from '@/types'
import { copyRetrieveCode, copyRetrieveLink, copyWgetCommand } from '@/utils/clipboard'
import { buildSentRecordQrValue } from '@/utils/share-url'

type CopyNotify = (message: string, type: 'success' | 'error') => void

export function createSentRecordActions(notify: CopyNotify) {
  return {
    copyLink: (record: SentFileRecord) =>
      copyRetrieveLink(record.retrieveCode, { notify }),
    copyCode: (record: SentFileRecord) =>
      copyRetrieveCode(record.retrieveCode, { notify }),
    copyWgetCommand: (record: SentFileRecord) =>
      copyWgetCommand(record.retrieveCode, record.filename, { notify }),
    getQRCodeValue: (record: SentFileRecord) => buildSentRecordQrValue(record),
    // P2P 直传分享不产生发送记录（不入库、不占配额），取件码/链接复制仍统一由本工具负责。
    copyP2PCode: (code: string) => copyRetrieveCode(code, { notify }),
    copyP2PLink: (code: string) => copyRetrieveLink(code, { notify })
  }
}
