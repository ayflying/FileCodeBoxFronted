import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAlertStore } from '@/stores/alertStore'
import { useAdminStore } from '@/stores/adminStore'
import { useConfigStore } from '@/stores/configStore'
import { useFileDataStore } from '@/stores/fileData'
import type { SendType, SentFileRecord, UploadProgress } from '@/types'
import { copyRetrieveCode, copyRetrieveLink } from '@/utils/clipboard'
import { getClipboardFile, insertTextAtSelection } from '@/utils/clipboard-paste'
import { getErrorMessage } from '@/utils/common'
import { getStorageUnit } from '@/utils/convert'
import { calculateFileHash } from '@/utils/file-processing'
import { isP2PFlagOn, normalizeP2PMaxSize } from '@/utils/p2p-config'
import { buildSentRecord, isExpirationWithinLimit } from '@/utils/send-record'
import { createSentRecordActions } from '@/utils/sent-record-actions'
import { useP2PPublisher } from './useP2PPublisher'
import { useSendSubmit } from './useSendSubmit'

export function useSendFlow() {
  const { t } = useI18n()
  const alertStore = useAlertStore()
  const adminStore = useAdminStore()
  const configStore = useConfigStore()
  const fileDataStore = useFileDataStore()
  const config = computed(() => configStore.config)
  const sendType = ref<SendType>('file')
  const selectedFile = ref<File | null>(null)
  const selectedFiles = ref<File[]>([])
  const textContent = ref('')
  const expirationMethod = ref(config.value.expireStyle[0] || 'day')
  const expirationValue = ref('1')
  const uploadProgress = ref(0)
  const uploadedBytes = ref(0)
  const totalBytes = ref(0)
  const uploadSpeed = ref(0)
  const lastProgressSnapshot = ref({ loaded: 0, time: 0 })
  const showDrawer = ref(false)
  const selectedRecord = ref<SentFileRecord | null>(null)
  const isSubmitting = ref(false)
  const fileHash = ref('')
  const sendRecords = computed(() => fileDataStore.shareData)
  const uploadDescription = computed(() =>
    t('send.uploadArea.descriptionWithLimit', {
      size: getStorageUnit(config.value.uploadSize)
    })
  )
  const allowedFileTypes = computed(() => {
    const types = config.value.allowedFileTypes || config.value.allowed_file_types || ['*']
    const normalized = types.map((type) => String(type).trim()).filter(Boolean)
    return normalized.length > 0 ? normalized : ['*']
  })
  const acceptedTypes = computed(() => {
    if (allowedFileTypes.value.some((type) => type === '*' || type === '*/*')) return '*'

    return allowedFileTypes.value
      .map((type) => {
        const normalizedType = type.toLowerCase()
        if (normalizedType.includes('/')) return normalizedType
        return normalizedType.startsWith('.') ? normalizedType : `.${normalizedType}`
      })
      .join(',')
  })
  const expirationOptions = computed(() =>
    config.value.expireStyle.map((value) => ({
      value,
      label: getUnit(value)
    }))
  )
  watch(
    () => config.value.expireStyle,
    (expireStyle) => {
      if (expireStyle.length > 0 && !expireStyle.includes(expirationMethod.value)) {
        expirationMethod.value = expireStyle[0]
      }
    },
    { immediate: true }
  )
  const notifyCopyResult = (message: string, type: 'success' | 'error') => {
    alertStore.showAlert(message, type)
  }
  const sentRecordActions = createSentRecordActions(notifyCopyResult)
  const { resetPresignUpload, submitFile, submitText } = useSendSubmit({
    getMaxFileSize: () => configStore.uploadSizeLimit,
    notify: (message, type) => alertStore.showAlert(message, type),
    translate: t,
    onProgress: (progress: UploadProgress) => {
      const now = performance.now()
      if (lastProgressSnapshot.value.time > 0 && now > lastProgressSnapshot.value.time) {
        const deltaBytes = Math.max(0, progress.loaded - lastProgressSnapshot.value.loaded)
        const deltaSeconds = (now - lastProgressSnapshot.value.time) / 1000
        uploadSpeed.value = deltaSeconds > 0 ? deltaBytes / deltaSeconds : 0
      }

      lastProgressSnapshot.value = {
        loaded: progress.loaded,
        time: now
      }
      uploadedBytes.value = progress.loaded
      totalBytes.value = progress.total
      uploadProgress.value = progress.percentage
    },
    onHashCalculated: (hash) => {
      fileHash.value = hash
    }
  })

  // ---- P2P 直传（详见 docs/p2p-design.md）----
  // 站点总开关与勾选框默认值都来自 /api/v1/config，且默认值可被管理面板改写。
  const p2pPublisher = useP2PPublisher()
  const p2pSiteEnabled = computed(() => isP2PFlagOn(config.value.enableP2P, false))
  const p2pMaxFileSize = computed(() => normalizeP2PMaxSize(config.value.p2pMaxSize))
  const p2pToggleChecked = ref(false)
  watch(
    () => config.value.p2pDefaultChecked,
    (value) => {
      p2pToggleChecked.value = isP2PFlagOn(value, true)
    },
    { immediate: true }
  )
  /**
   * 本次提交是否走 P2P 直传。
   * 多选文件时不走：P2P 的载荷是单个 File，若在这里打包 zip 会与「直传你选中的那几个文件」
   * 的语义不符，因此多选一律回落普通上传（UI 上开关会置灰并说明原因）。
   */
  const isP2PUploadActive = computed(
    () =>
      p2pSiteEnabled.value &&
      p2pToggleChecked.value &&
      sendType.value === 'file' &&
      selectedFiles.value.length === 0
  )
  const p2pToggleDisabled = computed(
    () => !p2pSiteEnabled.value || selectedFiles.value.length > 0
  )
  /** P2P 的文件不进服务器，因此上限取 p2pMaxSize，而不是 uploadSize */
  const effectiveMaxFileSize = computed(() =>
    isP2PUploadActive.value && p2pMaxFileSize.value > 0
      ? p2pMaxFileSize.value
      : config.value.uploadSize
  )
  /** 拍平成普通对象，避免模板里到处写 .value */
  const p2pPublishState = computed(() => ({
    phase: p2pPublisher.phase.value,
    code: p2pPublisher.code.value,
    fileName: p2pPublisher.fileName.value,
    fileSize: p2pPublisher.fileSize.value,
    expiresAt: p2pPublisher.expiresAt.value,
    progress: p2pPublisher.progress.value,
    servedCount: p2pPublisher.servedCount.value,
    activePeers: p2pPublisher.activePeers.value,
    transferredBytes: p2pPublisher.transferredBytes.value,
    currentChunk: p2pPublisher.currentChunk.value,
    totalChunks: p2pPublisher.totalChunks.value,
    maxPeers: p2pPublisher.maxPeers.value,
    lastTransport: p2pPublisher.lastTransport.value,
    errorMessage: p2pPublisher.errorMessage.value,
    isActive: p2pPublisher.isActive.value
  }))
  const stopP2PShare = async () => {
    await p2pPublisher.stop()
  }
  const dismissP2PShare = async () => {
    await p2pPublisher.stop()
    p2pPublisher.reset()
  }
  const copyP2PCode = () => copyRetrieveCode(p2pPublisher.code.value, { notify: notifyCopyResult })
  const copyP2PLink = () => copyRetrieveLink(p2pPublisher.code.value, { notify: notifyCopyResult })

  const checkOpenUpload = () => {
    if (config.value.openUpload === 0 && !adminStore.hasToken) {
      alertStore.showAlert(t('send.messages.guestUploadDisabled'), 'error')
      return false
    }
    return true
  }

  const resetUploadProgress = () => {
    uploadProgress.value = 0
    uploadedBytes.value = 0
    totalBytes.value = 0
    uploadSpeed.value = 0
    lastProgressSnapshot.value = { loaded: 0, time: 0 }
  }

  const checkFileSize = (file: File) => {
    const limit = effectiveMaxFileSize.value
    if (file.size > limit) {
      const size = getStorageUnit(limit)
      alertStore.showAlert(
        isP2PUploadActive.value
          ? t('p2p.sizeExceeded', { size })
          : t('send.messages.fileSizeExceeded', { size }),
        'error'
      )
      selectedFile.value = null
      return false
    }
    return true
  }

  const checkFileType = (file: File) => {
    if (allowedFileTypes.value.some((type) => type === '*' || type === '*/*')) {
      return true
    }

    const fileName = file.name.toLowerCase()
    const mimeType = file.type.toLowerCase()
    const isAllowed = allowedFileTypes.value.some((type) => {
      const rule = type.toLowerCase()
      if (rule.includes('/')) {
        if (rule.endsWith('/*')) {
          return mimeType.startsWith(rule.slice(0, -1))
        }
        return mimeType === rule
      }

      const extension = rule.startsWith('.') ? rule : `.${rule}`
      return fileName.endsWith(extension)
    })

    if (!isAllowed) {
      alertStore.showAlert(
        t('send.messages.fileTypeNotAllowed', { types: allowedFileTypes.value.join(', ') }),
        'error'
      )
    }

    return isAllowed
  }

  const checkExpirationTime = (method: string, value: string): boolean =>
    isExpirationWithinLimit(method, value, config.value.max_save_seconds || 0)

  const checkUpload = () => {
    if (!selectedFile.value) return false
    if (!checkOpenUpload()) return false
    if (!checkFileSize(selectedFile.value)) return false
    if (!checkFileType(selectedFile.value)) return false
    if (!checkExpirationTime(expirationMethod.value, expirationValue.value)) return false
    return true
  }

  const handleFileSelected = async (file: File) => {
    selectedFile.value = file
    selectedFiles.value = []
    if (!checkOpenUpload()) return
    if (!checkFileSize(file)) return
    if (!checkFileType(file)) return
    fileHash.value = await calculateFileHash(file)
  }

  const handleFilesSelected = async (files: File[]) => {
    if (!checkOpenUpload()) return
    const invalidFile = files.find((file) => !checkFileSize(file) || !checkFileType(file))
    if (invalidFile) return
    selectedFiles.value = files
    selectedFile.value = null
    fileHash.value = ''
  }

  const handleFileDrop = async (event: DragEvent) => {
    if (!event.dataTransfer?.files || event.dataTransfer.files.length === 0) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 1) {
      const file = files[0]
      selectedFile.value = file
      selectedFiles.value = []
      if (!checkUpload()) return
      fileHash.value = await calculateFileHash(file)
    } else {
      if (!checkOpenUpload()) return
      const invalidFile = files.find((file) => !checkFileSize(file) || !checkFileType(file))
      if (invalidFile) return
      selectedFiles.value = files
      selectedFile.value = null
      fileHash.value = ''
    }
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const items = event.clipboardData?.items
    if (!items) return

    const file = getClipboardFile(items)
    if (file) {
      if (file.size === 0) {
        alertStore.showAlert(t('send.messages.emptyFileError'), 'error')
        return
      }

      selectedFile.value = file
      if (!checkUpload()) return

      try {
        fileHash.value = await calculateFileHash(file)
        alertStore.showAlert(
          t('send.messages.fileAddedFromClipboard', { filename: file.name }),
          'success'
        )
      } catch (err) {
        alertStore.showAlert(t('send.messages.fileProcessingFailed'), 'error')
        console.error('File hash calculation failed:', err)
      }
      return
    }

    const textItem = items[0]
    if (!textItem) return

    sendType.value = 'text'
    textItem.getAsString((str: string) => {
      const trimmedStr = str.trim()
      if (!trimmedStr) return

      const textareaElement = document.getElementById('text-content') as HTMLTextAreaElement
      if (!textareaElement) {
        textContent.value += trimmedStr
        return
      }

      const insertion = insertTextAtSelection({
        text: textContent.value,
        insertText: trimmedStr,
        selectionStart: textareaElement.selectionStart,
        selectionEnd: textareaElement.selectionEnd
      })
      textContent.value = insertion.value

      setTimeout(() => {
        textareaElement.setSelectionRange(insertion.cursor, insertion.cursor)
        textareaElement.focus()
      }, 0)
    })
  }

  const getUnit = (value: string = expirationMethod.value) => {
    switch (value) {
      case 'day':
        return t('send.expiration.units.days')
      case 'hour':
        return t('send.expiration.units.hours')
      case 'minute':
        return t('send.expiration.units.minutes')
      case 'count':
        return t('send.expiration.units.times')
      case 'forever':
        return t('send.expiration.units.forever')
      default:
        return ''
    }
  }

  const handleSubmit = async () => {
    if (isSubmitting.value) return
    isSubmitting.value = true

    try {
      if (sendType.value === 'file' && !selectedFile.value && selectedFiles.value.length === 0) {
        alertStore.showAlert(t('send.messages.selectFile'), 'error')
        return
      }
      if (sendType.value === 'text' && !textContent.value.trim()) {
        alertStore.showAlert(t('send.messages.enterText'), 'error')
        return
      }
      if (!checkOpenUpload()) {
        return
      }
      if (expirationMethod.value !== 'forever' && !expirationValue.value) {
        alertStore.showAlert(t('send.messages.enterExpirationValue'), 'error')
        return
      }

      if (!checkExpirationTime(expirationMethod.value, expirationValue.value)) {
        const maxDays = Math.floor(config.value.max_save_seconds / 86400)
        alertStore.showAlert(t('send.messages.expirationTooLong', { days: maxDays }), 'error')
        return
      }

      const expireValue = expirationValue.value ? parseInt(expirationValue.value) : 1

      if (isP2PUploadActive.value) {
        // P2P 直传：文件不出浏览器，服务端只登记元数据，因此这里既没有上传进度，
        // 也不能清空 selectedFile —— 面板要保持在线才能把文件发给取件人。
        if (!selectedFile.value) {
          alertStore.showAlert(t('send.messages.selectFile'), 'error')
          return
        }

        try {
          await p2pPublisher.publish(selectedFile.value, expireValue, expirationMethod.value)
        } catch (error: unknown) {
          const raw = error instanceof Error ? error.message : ''
          alertStore.showAlert(
            raw && raw !== 'publish_failed' ? raw : t('p2p.prepareFailed'),
            'error'
          )
          return
        }

        alertStore.showAlert(
          t('send.messages.sendSuccess', { code: p2pPublisher.code.value }),
          'success'
        )
        resetUploadProgress()
        await copyRetrieveLink(p2pPublisher.code.value, { notify: notifyCopyResult })
        return
      }

      let response
      if (sendType.value === 'file') {
        response = await submitFile({
          selectedFile: selectedFile.value,
          selectedFiles: selectedFiles.value,
          expireValue,
          expireStyle: expirationMethod.value,
          enableChunk: Boolean(config.value.enableChunk),
          validateFileSize: checkFileSize
        })
      } else {
        response = await submitText({
          text: textContent.value,
          expireValue,
          expireStyle: expirationMethod.value
        })
      }

      if (!response) return

      if (response?.code === 200) {
        const newRecord = buildSentRecord({
          response,
          sendType: sendType.value,
          textContent: textContent.value,
          selectedFile: selectedFile.value,
          selectedFiles: selectedFiles.value,
          expirationMethod: expirationMethod.value,
          expirationValue: expirationValue.value,
          translate: t,
          getUnit
        })
        fileDataStore.addShareDataRecord(newRecord)
        alertStore.showAlert(
          t('send.messages.sendSuccess', { code: newRecord.retrieveCode }),
          'success'
        )
        selectedFile.value = null
        selectedFiles.value = []
        textContent.value = ''
        resetUploadProgress()
        resetPresignUpload()
        selectedRecord.value = newRecord
        await sentRecordActions.copyLink(newRecord)
      } else {
        throw new Error(t('send.messages.serverError'))
      }
    } catch (error: unknown) {
      alertStore.showAlert(getErrorMessage(error, t('send.messages.sendFailed')), 'error')
    } finally {
      resetUploadProgress()
      isSubmitting.value = false
    }
  }

  const toggleDrawer = () => {
    showDrawer.value = !showDrawer.value
  }

  const viewDetails = (record: SentFileRecord) => {
    selectedRecord.value = record
  }

  const closeDetails = () => {
    selectedRecord.value = null
  }

  const deleteRecord = (id: number) => {
    const index = fileDataStore.shareData.findIndex((record) => record.id === id)
    if (index !== -1) {
      fileDataStore.deleteShareData(index)
    }
  }

  return {
    config,
    sendType,
    selectedFile,
    selectedFiles,
    textContent,
    expirationMethod,
    expirationValue,
    uploadProgress,
    uploadedBytes,
    totalBytes,
    uploadSpeed,
    acceptedTypes,
    showDrawer,
    selectedRecord,
    isSubmitting,
    sendRecords,
    uploadDescription,
    expirationOptions,
    closeDetails,
    deleteRecord,
    copySentRecordCode: sentRecordActions.copyCode,
    copySentRecordLink: sentRecordActions.copyLink,
    copySentRecordWgetCommand: sentRecordActions.copyWgetCommand,
    getQRCodeValue: sentRecordActions.getQRCodeValue,
    getUnit,
    handleFileDrop,
    handleFileSelected,
    handleFilesSelected,
    handlePaste,
    handleSubmit,
    toggleDrawer,
    viewDetails,
    // ---- P2P 直传 ----
    p2pSiteEnabled,
    p2pToggleChecked,
    p2pToggleDisabled,
    p2pMaxFileSize,
    isP2PUploadActive,
    p2pPublishState,
    copyP2PCode,
    copyP2PLink,
    stopP2PShare,
    dismissP2PShare
  }
}
