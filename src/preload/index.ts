import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from '../types'

const api: ElectronAPI = {
  memories: {
    getAll: () => ipcRenderer.invoke('memories:getAll'),
    get: id => ipcRenderer.invoke('memories:get', id),
    create: data => ipcRenderer.invoke('memories:create', data),
    update: (id, data) => ipcRenderer.invoke('memories:update', id, data),
    delete: id => ipcRenderer.invoke('memories:delete', id),
    search: (query, tags, source, dates) => ipcRenderer.invoke('memories:search', query, tags, source, dates)
  },
  relationships: {
    getAll: () => ipcRenderer.invoke('relationships:getAll'),
    getForMemory: memoryId => ipcRenderer.invoke('relationships:getForMemory', memoryId),
    create: data => ipcRenderer.invoke('relationships:create', data),
    delete: id => ipcRenderer.invoke('relationships:delete', id)
  },
  graph: {
    getMentionEdges: () => ipcRenderer.invoke('graph:getMentionEdges'),
  },
  extension: {
    getConfig: () => ipcRenderer.invoke('extension:getConfig'),
    armPairing: (durationMs) => ipcRenderer.invoke('extension:armPairing', durationMs)
  },
  system: {
    getStatus: () => ipcRenderer.invoke('system:getStatus')
  },
  vault: {
    getConfig: () => ipcRenderer.invoke('vault:getConfig'),
    choosePath: () => ipcRenderer.invoke('vault:choosePath'),
    initVault: (vaultPath) => ipcRenderer.invoke('vault:initVault', vaultPath),
    getFiles: () => ipcRenderer.invoke('vault:getFiles'),
    searchFiles: (query) => ipcRenderer.invoke('vault:searchFiles', query),
    deleteFile: (id) => ipcRenderer.invoke('vault:deleteFile', id),
    openInExplorer: (filepath) => ipcRenderer.invoke('vault:openInExplorer', filepath),
    readFile: (filepath) => ipcRenderer.invoke('vault:readFile', filepath),
    createFile: (dirPath, filename) => ipcRenderer.invoke('vault:createFile', dirPath, filename),
    createFolder: (dirPath, name) => ipcRenderer.invoke('vault:createFolder', dirPath, name),
    rename: (oldPath, newPath) => ipcRenderer.invoke('vault:rename', oldPath, newPath),
    deleteItem: (itemPath) => ipcRenderer.invoke('vault:deleteItem', itemPath),
    copyToVault: (sourcePaths, destDir) => ipcRenderer.invoke('vault:copyToVault', sourcePaths, destDir),
    openFile: (filepath) => ipcRenderer.invoke('vault:openFile', filepath),
    extractDocText: (filepath) => ipcRenderer.invoke('vault:extractDocText', filepath),
    semanticSearch: (query) => ipcRenderer.invoke('vault:semanticSearch', query),
    setWatchPath: (watchPath) => ipcRenderer.invoke('vault:setWatchPath', watchPath),
    removeWatchPath: () => ipcRenderer.invoke('vault:removeWatchPath'),
  },
  data: {
    exportMemories: (format) => ipcRenderer.invoke('data:exportMemories', format),
    importMemories: () => ipcRenderer.invoke('data:importMemories'),
  },
  tags: {
    getCounts: () => ipcRenderer.invoke('tags:getCounts'),
    rename: (from, to) => ipcRenderer.invoke('tags:rename', from, to),
    delete: (tag) => ipcRenderer.invoke('tags:delete', tag),
    suggest: (id) => ipcRenderer.invoke('tags:suggest', id),
  },
  embeddings: {
    getStatus: () => ipcRenderer.invoke('embeddings:getStatus'),
    pause: () => ipcRenderer.invoke('embeddings:pause'),
    resume: () => ipcRenderer.invoke('embeddings:resume'),
  },
  telemetry: {
    isEnabled: () => ipcRenderer.invoke('telemetry:isEnabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('telemetry:setEnabled', enabled),
    // Fire-and-forget — graph interactions fire often; no round-trip wait.
    capture: (type, data) => { ipcRenderer.send('telemetry:capture', type, data) },
    getAll: () => ipcRenderer.invoke('telemetry:getAll'),
    getStats: () => ipcRenderer.invoke('telemetry:getStats'),
    export: () => ipcRenderer.invoke('telemetry:export'),
    clear: () => ipcRenderer.invoke('telemetry:clear'),
  },
  feedback: {
    save: (submission) => ipcRenderer.invoke('feedback:save', submission),
    getAll: () => ipcRenderer.invoke('feedback:getAll'),
  },
  events: {
    onMemoriesChanged: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('memories:changed', handler)
      return () => ipcRenderer.removeListener('memories:changed', handler)
    },
    onExtensionPaired: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('extension:paired', handler)
      return () => ipcRenderer.removeListener('extension:paired', handler)
    },
    onVaultChanged: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('vault:changed', handler)
      return () => ipcRenderer.removeListener('vault:changed', handler)
    },
    onIndexProgress: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { current: number; total: number }) => callback(data)
      ipcRenderer.on('vault:indexProgress', handler)
      return () => ipcRenderer.removeListener('vault:indexProgress', handler)
    },
    onEmbeddingsProgress: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, data: import('../types').SeedStatus) => callback(data)
      ipcRenderer.on('embeddings:progress', handler)
      return () => ipcRenderer.removeListener('embeddings:progress', handler)
    }
  }
}

contextBridge.exposeInMainWorld('electron', api)
