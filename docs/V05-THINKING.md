# V05-THINKING

Written 2026-06-13 after shipping v0.4. The original ROADMAP scoped v0.5 as
"Connect — your own machines, not other people's" (digest, local web
companion, P2P sync). Half of that — the digest — is now in v0.4. This
document argues v0.5 should drop the rest of the original scope and tackle
the gap v0.4 revealed.

## What v0.4 revealed

v0.4 shipped four things: the CLI, summarization, the digest, and pinned
memories. After a few hours of using them, here's what I notice.

The CLI is exactly what I hoped. Running `cortex search architecture` and
getting back a one-line summary plus a snippet in 200ms is fast enough that
I do it without thinking. The semantic-mode pivot to keyword when Ollama is
down keeps it useful even when the model isn't running. The digest is
pleasant. Pinning is satisfying — the star icon takes one click and the
sidebar reorganises immediately.

But there's a deeper thing missing, and it shows up when I try to USE the
digest.

I read this morning's digest. Six tag groups. One-line summary per memory.
I see "Cortex auto-tagging design" and "MCP server end-to-end smoke." I
click in. The full conversation is there — 30 messages of debugging, 60 of
spec'ing, 12 of me losing the plot. The summary tells me the *topic*. It
doesn't tell me what I *learned*. To recover the actual lesson I have to
re-read the conversation. So I skip it.

This is the gap. **Cortex captures conversations, but it doesn't capture
learnings.** A captured chat is the raw material. A learning is the
distilled product. A second brain that only stores raw material is
basically a chat-archive search engine. A second brain that stores
distilled learnings is something you can actually think with.

The summaries help a little — a one-line summary is closer to a learning
than the raw chat. But a summary tells you what the conversation was
*about*. It rarely tells you what was *concluded*, what was *decided*,
what *failed*, what's *worth remembering past this week*. Those are
different things.

Second observation. v0.4 added pinned memories as an "always-relevant
context" surface. But there's nothing in Cortex right now that *I* wrote.
Everything is captured from somewhere else. Even the 13 seed memories were
written for the seed pipeline, not the way I'd write a note. There is no
place in Cortex for my own thinking — no journal, no scratchpad, no "I
just realised X" entry. That means Cortex has no record of the synthesis
I do across captures. It only has the captures themselves.

Third observation. The CLI proved that surfaces outside the Electron
window are huge. But there are still two contexts I work in where Cortex
can't reach me:

- A meeting. I'm not in front of my keyboard. I want to capture a
  sentence-long note.
- The kitchen / a walk / a podcast. Same — I want a one-line note "the
  scheduler-by-priority idea from this episode is what I should try for
  the layout step." But I can't, because Cortex is on my laptop.

The web companion was the original v0.5 answer to this. It's still a
reasonable answer — read-only Cortex on the LAN means I can pull up my
brain on my phone. But "read-only on my phone" doesn't solve the
*write* problem. I don't need to look something up from the kitchen; I
need to capture a thought from the kitchen.

## What I'd build if I were the user

Three things, in this order. I'm trying hard to be honest about what's
load-bearing vs. what's a nice-to-have.

1. **Atomic learnings extracted from conversations.** After a chat is
   captured, an Ollama pass extracts up to N "atomic" learnings — single
   sentences that capture what was concluded, decided, or worth
   remembering. These learnings are stored as their own kind of memory
   (source `derived`), linked back to the parent conversation, and
   surfaced in the digest INSTEAD of the parent. Search returns them
   first because they're the high-signal layer. Conversations stay as the
   substrate for "show me the original" but aren't what the digest reads
   from.

   This is the unlock. It turns Cortex from "a place where chats land"
   into "a place where my thinking accumulates." The chats are the
   trash; the learnings are the gold; the digest reads gold.

2. **A daily journal — first-class memory type.** One short journal
   entry per day. Composable via `cortex journal "text"` or by opening
   the in-app Journal view. The entry is a memory like any other, but
   it's mine, not captured. The digest pairs it with the day's
   conversations: "here's what you captured, here's what you wrote about
   it." Pinned recent entries become a default context surface — the
   "this is what I've been thinking" view.

   This pairs with #1. The atomic learnings are extracted; the journal
   is composed. Together they're the difference between an archive and
   a working brain.

3. **`cortex add` for quick capture from the terminal.** One-line ideas
   straight from the shell. `cortex add "scheduler-by-priority idea
   from podcast"`. Tags, source `cli`. Hits the same FTS5/embedding
   pipeline. Combined with the journal command, this is enough to
   bridge "I had a thought in a meeting" to "Cortex saw it."

Plus, if budget allows:

4. **A tiny local read-only web companion** at `http://127.0.0.1:48742`
   (bound to loopback by default, opt-in to LAN). Renders the digest,
   pinned set, recent memories, and search. Mobile-friendly. This is
   the v0.5-as-roadmapped item, scoped down. It buys phone access for
   "look up" but doesn't solve "capture" — that's what #3 does.

## What I'd cut from the original v0.5

- **Encrypted P2P sync between own machines.** Cryptographic key
  management, conflict resolution on SQLite, NAT traversal. Enormous
  engineering cost for a feature most users don't need (one machine is
  the common case). When sync becomes urgent — when a real second
  device shows up in my workflow — it can land in v0.6. For now, the
  vault is one machine and that's fine.
- **Daily / weekly digest.** Already shipped in v0.4.

## v0.5 thesis: "The brain that thinks back"

After v0.5, Cortex is no longer a place where chats land and get
re-searched. It's a place where my own thinking accumulates. Three
mechanisms:

1. **Extraction** — atomic learnings derived from conversations, stored
   as their own kind of memory. The digest reads from these, not from
   the parent chats. Search ranks them first.
2. **Composition** — daily journal, first-class memory type, manual
   entry, paired with the digest.
3. **Capture-anywhere** — `cortex add` lets the terminal be a one-line
   inbox.

If I had to keep only one of these, I'd keep #1 — it's the unlock that
makes everything else worth more. But all three together is what makes
v0.5 feel coherent, the way v0.4's CLI + summaries + digest + pinned
felt coherent.

## What this means for the architecture

- New memory source `derived` (extracted learnings) and `journal`
  (manual entries). Both are full first-class memories — same schema,
  same search, same MCP / CLI surface. The difference is provenance.
- New `extract` worker that runs after the existing summarization
  worker. Uses the same Ollama model (`llama3.2:3b`) with a different
  system prompt and stricter output parsing. Emits zero-to-five derived
  memories per parent.
- New `journal_entries` table — actually no, this is a memory like any
  other; provenance is in `source = 'journal'`. No new table.
- A `derived_from` field added to `memories` (NULLable string column)
  so a derived memory can point back to its parent conversation. The
  parent's detail panel shows "5 learnings derived" and the derived
  memory's panel shows "from: <parent title>".
- Renderer: graph edges of a new signal type `derived` (a fourth color
  alongside tag/keyword/embedding) connecting derived memories to
  their parents.
- CLI: `cortex add`, `cortex journal [text]`. Without arguments,
  `cortex journal` opens `$EDITOR` on today's entry, creating one if
  needed.
- MCP: a new `cortex_extract` tool to trigger extraction on demand,
  and `cortex_search` learns a `learnings_only` flag.

## How I'll measure if v0.5 worked

Same honest framing as v0.4:

1. After a week of v0.5, am I reading derived learnings in the digest
   more often than I'm re-reading captured chats? If no, the extraction
   prompt isn't producing real signal and I need to revisit.
2. Have I written at least 5 journal entries unprompted? If no, the
   journal UX isn't frictionless enough.
3. Have I used `cortex add` from a context where I would otherwise
   have lost the thought (a meeting, a walk via voice-to-text, a
   podcast)? If yes, capture-anywhere is the right shape.

## What this means for v1.0

v1.0 was originally "documented public plugin API, perf benchmark
suite in CI, schema migration story, non-AI source adapters, user
docs + screencast." Most of that still belongs in v1.0.

But if v0.5 ships well, the plugin API conversation changes. Plugins
make sense when the surface area is stable and the use cases are clear.
After v0.5 the use cases are: capture (extension + CLI + journal),
extraction (Ollama summarisation + learning extraction), retrieval
(MCP + CLI + app + web companion). That's coherent enough to expose.

The non-AI source adapters (Obsidian vault, RSS, email-to-vault)
become natural extensions of #3 above — `cortex add` from a script
that polls RSS, or a Mail.app rule that pipes new mail through
`cortex add --tag mail`. So that work is already half-done by v0.5.
