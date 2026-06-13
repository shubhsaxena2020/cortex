import React, { useState } from 'react'
import { Brain } from 'lucide-react'
import MemoryEditor from '../components/MemoryEditor'
import FileViewer from '../components/FileViewer'
import InsightPopup from '../components/InsightPopup'
import { useStore } from '../store'

export default function Dashboard(): React.ReactElement {
  const { getSelectedFile, selectedMemoryId, isHydrated } = useStore()
  const selectedFile = getSelectedFile()
  const [showInsights, setShowInsights] = useState(false)

  // The editor must never mount on a light (content-less) row: its autosave
  // would write the empty content back over the real body. Hydration is
  // triggered by selectMemory; this gate holds until it lands.
  const editorReady = selectedMemoryId !== null && isHydrated(selectedMemoryId)

  return (
    <div className="flex w-full h-full relative overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {selectedFile ? (
          <FileViewer file={selectedFile} />
        ) : selectedMemoryId && !editorReady ? (
          <div className="flex-1 flex items-center justify-center bg-[#1a1a1a]">
            <div className="text-[#444] text-sm animate-pulse">Loading…</div>
          </div>
        ) : selectedMemoryId ? (
          <MemoryEditor />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-[#1a1a1a]">
            <div className="text-center text-[#333]">
              <div className="text-5xl mb-4">◆</div>
              <p className="text-[#555] text-sm">Select a memory or</p>
              <p className="text-[#444] text-sm mt-1">press <kbd className="px-1 py-0.5 bg-[#2d2d2d] rounded text-xs">Ctrl+N</kbd> to create one</p>
            </div>
          </div>
        )}

        <button
          onClick={() => setShowInsights(v => !v)}
          className={`absolute bottom-5 right-5 p-2.5 rounded-full shadow-lg border transition-all ${
            showInsights
              ? 'bg-[#6B9FD4] border-[#6B9FD4] text-white scale-110'
              : 'bg-[#242424] border-[#333] text-[#444] hover:text-[#E8E8E8] hover:border-[#6B9FD4]'
          }`}
          title="Memory Insights"
        >
          <Brain size={16} />
        </button>

        {showInsights && <InsightPopup onClose={() => setShowInsights(false)} />}
      </div>
    </div>
  )
}
