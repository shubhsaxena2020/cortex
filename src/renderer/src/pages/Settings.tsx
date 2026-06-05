import React, { useEffect, useRef, useState } from 'react'
import { Copy, Check, Globe, Key, FileText, Link2, FolderOpen, FolderSearch, ExternalLink, Eye, EyeOff, Cpu, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import PrivacySettings from '../components/PrivacySettings'
import type { ExtensionConfig, VaultConfig, SystemStatus } from '../../../types'

type PairState =
  | { kind: 'idle' }
  | { kind: 'armed'; secondsLeft: number }
  | { kind: 'paired' }

const PAIR_WINDOW_MS = 60_000

export default function Settings(): React.ReactElement {
  const { createMemory, selectMemory, setView, fetchVaultFiles } = useStore()
  const [config, setConfig] = useState<ExtensionConfig | null>(null)
  const [vaultConfig, setVaultConfig] = useState<VaultConfig | null | undefined>(undefined)
  const [vaultFileCount, setVaultFileCount] = useState(0)
  const [vaultLoading, setVaultLoading] = useState(false)
  const [watchLoading, setWatchLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [pair, setPair] = useState<PairState>({ kind: 'idle' })
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshVault = (): void => {
    void window.electron.vault.getConfig().then(cfg => {
      setVaultConfig(cfg)
      if (cfg?.vaultPath) {
        void window.electron.vault.getFiles().then(files => setVaultFileCount(files.length))
      }
    })
  }

  useEffect(() => {
    window.electron.extension.getConfig()
      .then(setConfig)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))

    refreshVault()

    // Reset to "Paired ✓" when /pair succeeds, then back to idle after a moment.
    const unsubscribe = window.electron.events.onExtensionPaired(() => {
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
      setPair({ kind: 'paired' })
      setTimeout(() => setPair({ kind: 'idle' }), 3000)
    })
    return () => {
      unsubscribe()
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [])

  const armPairing = async (): Promise<void> => {
    const deadline = await window.electron.extension.armPairing(PAIR_WINDOW_MS)
    if (countdownRef.current) clearInterval(countdownRef.current)
    const tick = (): void => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      if (remaining <= 0) {
        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
        setPair(prev => prev.kind === 'armed' ? { kind: 'idle' } : prev)
        return
      }
      setPair({ kind: 'armed', secondsLeft: remaining })
    }
    tick()
    countdownRef.current = setInterval(tick, 1000)
  }

  const copy = (label: string, value: string): void => {
    void navigator.clipboard.writeText(value)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  const handleNewMemory = async (): Promise<void> => {
    const m = await createMemory({ title: 'New Memory', content: '', source: 'manual', tags: [] })
    selectMemory(m.id)
    setView('editor')
  }

  const handleChooseWatchFolder = async (): Promise<void> => {
    const result = await (window as Window & typeof globalThis).electron.vault.choosePath()
    if (!result) return
    setWatchLoading(true)
    try {
      await window.electron.vault.setWatchPath(result)
      refreshVault()
      void fetchVaultFiles()
    } finally {
      setWatchLoading(false)
    }
  }

  const handleRemoveWatchFolder = async (): Promise<void> => {
    await window.electron.vault.removeWatchPath()
    refreshVault()
    void fetchVaultFiles()
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#0F0F0F]">
      <div className="max-w-3xl mx-auto px-10 py-8">
        <h1 className="text-2xl font-bold text-[#E8E8E8] mb-1">Settings</h1>
        <p className="text-sm text-[#555] mb-8">Cortex configuration</p>

          {error && (
            <div className="mb-6 p-4 bg-red-900/20 border border-red-800/50 rounded-lg text-sm text-red-300">
              Failed to load config: {error}
            </div>
          )}

          <section className="mb-10">
            <div className="flex items-center gap-2 mb-1">
              <Cpu size={14} className="text-[#6B9FD4]" />
              <h2 className="text-base font-semibold text-[#E8E8E8]">AI Features</h2>
            </div>
            <p className="text-xs text-[#555] mb-5 leading-relaxed">
              Semantic search uses a local AI model via Ollama. Without it, search still works in keyword mode.
            </p>
            <AiStatusPanel />
          </section>

          <section className="mb-10">
            <div className="flex items-center gap-2 mb-1">
              <FolderSearch size={14} className="text-[#6B9FD4]" />
              <h2 className="text-base font-semibold text-[#E8E8E8]">Vault Folder</h2>
            </div>
            <p className="text-xs text-[#555] mb-5 leading-relaxed">
              Your vault is a folder on disk — extension saves conversations here and files are watched automatically.
            </p>
            <VaultSection
              config={vaultConfig}
              fileCount={vaultFileCount}
              loading={vaultLoading}
              onChoose={async () => {
                const path = await window.electron.vault.choosePath()
                if (!path) return
                setVaultLoading(true)
                try {
                  await window.electron.vault.initVault(path)
                  refreshVault()
                } finally {
                  setVaultLoading(false)
                }
              }}
              onOpenExplorer={() => {
                if (vaultConfig?.vaultPath) void window.electron.vault.openInExplorer(vaultConfig.vaultPath)
              }}
            />
          </section>

          <section className="mb-10">
            <div className="flex items-center gap-2 mb-1">
              <Eye size={14} className="text-[#6B9FD4]" />
              <h2 className="text-base font-semibold text-[#E8E8E8]">Watch Folder</h2>
            </div>
            <p className="text-xs text-[#555] mb-5 leading-relaxed">
              Point to any existing folder (Downloads, Desktop, a project folder). Cortex indexes files into the graph — files are never moved or copied.
            </p>
            {vaultConfig === undefined ? (
              <div className="text-sm text-[#555]">Loading…</div>
            ) : vaultConfig?.watchPath ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 bg-[#1a1a1a] border border-[#333] rounded-lg">
                  <Eye size={14} className="text-[#6B9FD4] flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-[#555] uppercase tracking-wider mb-0.5">Watching</div>
                    <div className="text-sm text-[#E8E8E8] truncate select-text">{vaultConfig.watchPath}</div>
                  </div>
                  <button
                    onClick={() => void handleRemoveWatchFolder()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#2a2a2a] hover:bg-[#3a2a2a] text-[#888] hover:text-red-400 border border-[#333] transition-colors"
                  >
                    <EyeOff size={11} /> Remove
                  </button>
                </div>
                <IndexProgressInline />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-[#333] bg-[#111] p-6 text-center">
                <Eye size={24} className="mx-auto mb-3 text-[#444]" />
                <p className="text-sm text-[#666] mb-4">No watch folder configured.</p>
                <button
                  onClick={() => void handleChooseWatchFolder()}
                  disabled={watchLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#6B9FD4]/20 hover:bg-[#6B9FD4]/30 text-[#6B9FD4] text-sm font-medium transition-colors disabled:opacity-50"
                >
                  <FolderOpen size={14} />
                  {watchLoading ? 'Indexing…' : 'Choose Watch Folder'}
                </button>
              </div>
            )}
          </section>

          <section className="mb-10">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={14} className="text-[#6B9FD4]" />
              <h2 className="text-base font-semibold text-[#e0e0e0]">Browser Extension</h2>
            </div>
            <p className="text-xs text-[#555] mb-5 leading-relaxed">
              The Cortex browser extension talks to this app over a local HTTP server.
              Paste the values below into the extension popup the first time you connect.
            </p>

            {config ? (
              <div className="space-y-3">
                <PairButton state={pair} onArm={() => void armPairing()} />

                <details className="rounded-lg border border-[#404040] bg-[#222] open:bg-[#222]">
                  <summary className="px-3 py-2 text-xs text-[#888] cursor-pointer select-none hover:text-[#e0e0e0]">
                    Manual pairing (advanced)
                  </summary>
                  <div className="p-3 pt-1 space-y-3 border-t border-[#404040]">
                    <p className="text-xs text-[#555] leading-relaxed">
                      Copy the port and token, paste into the extension popup's Advanced section.
                    </p>
                    <Field
                      icon={<Globe size={12} />}
                      label="Port"
                      value={String(config.port)}
                      copied={copied === 'port'}
                      onCopy={() => copy('port', String(config.port))}
                    />
                    <Field
                      icon={<Key size={12} />}
                      label="Token"
                      value={config.token}
                      copied={copied === 'token'}
                      onCopy={() => copy('token', config.token)}
                      mono
                    />
                  </div>
                </details>

                <div className="flex items-center gap-2 mt-4 text-xs text-[#444]">
                  <FileText size={11} />
                  <span className="select-text break-all">{config.configPath}</span>
                </div>
              </div>
            ) : !error ? (
              <div className="text-sm text-[#555]">Loading…</div>
            ) : null}
          </section>

          <PrivacySettings />

          <section className="opacity-60">
            <h2 className="text-base font-semibold text-[#E8E8E8] mb-1">Coming soon</h2>
            <ul className="text-xs text-[#555] list-disc pl-5 space-y-1">
              <li>Rotate extension token</li>
              <li>View recent extension API requests</li>
            </ul>
          </section>
        </div>
    </div>
  )
}

interface FieldProps {
  icon: React.ReactNode
  label: string
  value: string
  copied: boolean
  onCopy: () => void
  mono?: boolean
}

function PairButton({ state, onArm }: { state: PairState; onArm: () => void }): React.ReactElement {
  if (state.kind === 'paired') {
    return (
      <button
        disabled
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#10a37f] text-white text-sm font-medium cursor-default"
      >
        <Check size={14} />
        Extension paired
      </button>
    )
  }
  if (state.kind === 'armed') {
    return (
      <button
        disabled
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#3a3a4a] border border-[#6366f1] text-[#a5b4fc] text-sm font-medium cursor-wait"
      >
        Waiting for extension… ({state.secondsLeft}s)
      </button>
    )
  }
  return (
    <button
      onClick={onArm}
      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] text-white text-sm font-medium transition-colors"
    >
      <Link2 size={14} />
      Pair Extension
    </button>
  )
}

interface VaultSectionProps {
  config: VaultConfig | null | undefined
  fileCount: number
  loading: boolean
  onChoose: () => void
  onOpenExplorer: () => void
}

function VaultSection({ config, fileCount, loading, onChoose, onOpenExplorer }: VaultSectionProps): React.ReactElement {
  if (config === undefined) return <div className="text-sm text-[#555]">Loading…</div>

  if (!config?.vaultPath) {
    return (
      <div className="rounded-lg border border-dashed border-[#404040] bg-[#1e1e1e] p-6 text-center">
        <FolderOpen size={24} className="mx-auto mb-3 text-[#555]" />
        <p className="text-sm text-[#888] mb-4">No vault configured yet.</p>
        <button
          onClick={onChoose}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] text-white text-sm font-medium transition-colors disabled:opacity-50"
        >
          <FolderSearch size={14} />
          {loading ? 'Setting up…' : 'Choose Vault Folder'}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 p-3 bg-[#222] border border-[#404040] rounded-lg">
        <FolderOpen size={14} className="text-[#6366f1] flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-[#555] uppercase tracking-wider mb-0.5">Vault Path</div>
          <div className="text-sm text-[#e0e0e0] truncate select-text">{config.vaultPath}</div>
        </div>
        <button
          onClick={onOpenExplorer}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#2d2d2d] hover:bg-[#3a3a4a] text-[#b0b0b0] border border-[#404040] hover:border-[#6366f1] transition-colors"
        >
          <ExternalLink size={11} />
          Open
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs text-[#555]">
        <FileText size={11} />
        <span>{fileCount} file{fileCount !== 1 ? 's' : ''} indexed</span>
        <span className="mx-1">·</span>
        <button onClick={onChoose} className="text-[#6366f1] hover:text-[#818cf8] transition-colors">
          Change folder
        </button>
      </div>
    </div>
  )
}

function AiStatusPanel(): React.ReactElement {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setStatus(await window.electron.system.getStatus())
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { void load() }, [])

  if (!status) return <div className="text-sm text-[#555]">Loading…</div>

  const ollamaOk = status.ollama.reachable
  const modelOk = status.ollama.reachable && status.ollama.modelPulled
  const vecOk = status.vectorSearch.enabled

  return (
    <div className="space-y-2">
      <StatusRow
        ok={ollamaOk}
        label="Ollama"
        detail={ollamaOk ? 'Reachable at 127.0.0.1:11434' : 'Not reachable — install from ollama.com'}
        actionLabel={ollamaOk ? undefined : 'Install Ollama'}
        actionUrl={ollamaOk ? undefined : 'https://ollama.com/download'}
      />
      <StatusRow
        ok={modelOk}
        label={`Embed model (${status.ollama.model})`}
        detail={
          !ollamaOk ? 'Waiting on Ollama'
          : modelOk ? 'Pulled'
          : `Not pulled — run: ollama pull ${status.ollama.model}`
        }
      />
      <StatusRow
        ok={vecOk}
        label="Vector search"
        detail={
          vecOk
            ? `Enabled — ${status.vectorSearch.embeddedCount}/${status.vectorSearch.totalMemories} memories embedded`
            : 'Disabled — sqlite-vec failed to load. Search will use keyword matching.'
        }
      />
      <button
        onClick={() => void load()}
        disabled={refreshing}
        className="flex items-center gap-1.5 text-xs text-[#6366f1] hover:text-[#818cf8] disabled:opacity-50"
      >
        <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
        {refreshing ? 'Checking…' : 'Refresh'}
      </button>
    </div>
  )
}

function StatusRow({
  ok, label, detail, actionLabel, actionUrl,
}: {
  ok: boolean; label: string; detail: string; actionLabel?: string; actionUrl?: string
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 p-3 bg-[#1a1a1a] border border-[#2d2d2d] rounded-lg">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ok ? 'bg-[#10a37f]' : 'bg-[#f59e0b]'}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[#E8E8E8]">{label}</div>
        <div className="text-xs text-[#666]">{detail}</div>
      </div>
      {actionLabel && actionUrl && (
        <a
          href={actionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-[#6366f1] hover:text-[#818cf8] flex-shrink-0"
        >
          <ExternalLink size={11} />
          {actionLabel}
        </a>
      )}
    </div>
  )
}

function IndexProgressInline(): React.ReactElement | null {
  const indexProgress = useStore(s => s.indexProgress)
  if (!indexProgress || indexProgress.total <= 0) return null

  const { current, total } = indexProgress
  const pct = Math.min(100, Math.round((current / total) * 100))

  return (
    <div className="flex items-center gap-3 p-3 bg-[#0e1620] border border-[#1f3553] rounded-lg">
      <span className="w-1.5 h-1.5 rounded-full bg-[#6B9FD4] animate-pulse flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-[#a5b4fc]">Indexing files</span>
          <span className="text-[11px] text-[#666] tabular-nums">{current} / {total} · {pct}%</span>
        </div>
        <div className="h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#6B9FD4] transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Indexing ${current} of ${total} files`}
          />
        </div>
      </div>
    </div>
  )
}

function Field({ icon, label, value, copied, onCopy, mono }: FieldProps): React.ReactElement {
  return (
    <div className="flex items-center gap-3 p-3 bg-[#222] border border-[#404040] rounded-lg">
      <div className="text-[#555] flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-[#555] uppercase tracking-wider mb-0.5">{label}</div>
        <div className={`text-sm text-[#e0e0e0] truncate select-text ${mono ? 'font-mono' : ''}`}>
          {value}
        </div>
      </div>
      <button
        onClick={onCopy}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
          copied
            ? 'bg-[#10a37f] text-white'
            : 'bg-[#2d2d2d] hover:bg-[#3a3a4a] text-[#b0b0b0] border border-[#404040] hover:border-[#6366f1]'
        }`}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
