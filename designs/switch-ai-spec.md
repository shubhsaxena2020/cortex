# Design Spike: "Switch AI"

> 30-minute spike to give v0.3 planning a real brief instead of a placeholder. Status: **decision document, not a build spec.** Several questions need Shubh's input before this becomes implementable.

## Problem statement

Users hit a wall they think is on the AI's side: "Claude refused this request — would ChatGPT do it?" Or hit a wall they think is on their side: "I want my Claude conversation about X to inform my next ChatGPT session." Today they manually copy-paste, lose formatting, lose the link back to the original conversation, and lose any chance for Cortex to know the two threads are related.

## The strategic question (answer this first)

**"Switch AI" can mean three different products.** The choice cascades into every other decision in this doc.

| Interpretation | What it is | What Cortex becomes |
|---|---|---|
| **A. Handoff helper** | "Prepare a context blob from my Claude chat + open ChatGPT in a new tab with it pre-loaded into the input box." Cortex never makes a model API call. | A power-user productivity layer on top of the existing capture extension. **Stays on charter.** |
| **B. Cross-model chat client** | "Cortex has a chat UI; switch the underlying model from a dropdown; conversation history travels with you." Cortex orchestrates API calls with user-supplied keys. | A local-first ChatGPT/Claude/Gemini client. **Major scope expansion** — direct competitor to LibreChat, Open WebUI, Msty. |
| **C. Cross-model query** | "Ask the same question to all three at once; show me the answers side-by-side; save all three to the graph." Synchronous fan-out API calls. | A comparison tool. Narrower than B but still requires API keys and orchestration. |

**The Cortex roadmap to date does NOT contemplate B or C.** v0.1's positioning is "privacy-first capture + knowledge graph." A is additive to that. B/C add a second product surface (chat client) that competes for the same engineering hours as the v0.2 P0 list (dedup, perf, telemetry) and pulls Cortex toward a much more crowded category.

**Recommendation: A. Defer B/C until A is shipped and we know whether users actually use it.** A is ~1-2 days of work and ships value immediately; B/C are 2-3 weeks minimum and bet the roadmap on becoming a chat client.

Everything below assumes interpretation **A** unless a section is explicitly marked otherwise.

## User stories (interpretation A)

1. **The pivot.** "I asked Claude to write a SQL migration, it gave me an answer I want to double-check with ChatGPT before I run it. One click in the Cortex extension → opens chatgpt.com with my prompt + Claude's answer + 'please critique this' prefix already pasted into the input."
2. **The continuation.** "I had a great Claude conversation about Postgres internals last week. I want to start a new ChatGPT chat that *begins with* that context. One click in a memory's detail view → ChatGPT opens with a one-message summary of the prior chat in the input."
3. **The fallback.** "Claude said it can't do X. I want to try the same prompt on Gemini." From the extension popup on claude.ai, pick "retry on Gemini" → Gemini tab opens with my last user message pre-filled.
4. **The cross-reference (deferred).** "Show me everywhere I've asked any AI about Postgres internals — across all three providers." This is **search**, not switch. Belongs on the v0.2 P0 #4 search latency work, not here.

## UX flow (interpretation A)

```
  ┌──────────────────────────────────────┐
  │ claude.ai conversation (active)       │
  │                                       │
  │  [Cortex extension icon] ▼            │
  │   ┌──────────────────────────────┐    │
  │   │ Save This Chat               │    │
  │   │ ─────────────────────────    │    │
  │   │ Continue with ▸              │    │
  │   │    ▸ ChatGPT (new tab)       │    │
  │   │    ▸ Gemini   (new tab)      │    │
  │   │ Retry last prompt with ▸     │    │
  │   │    ▸ ChatGPT                 │    │
  │   │    ▸ Gemini                  │    │
  │   └──────────────────────────────┘    │
  └──────────────────────────────────────┘
              │
              ▼
       New tab: chatgpt.com/?cortex-payload=<id>
              │
              ▼
   Content script on chatgpt.com sees the
   cortex-payload param, reads the payload
   from extension storage by id, pastes
   it into the input box, focuses, scrolls.
   User reviews and hits Send manually.
```

**Key UX decisions baked in:**
- **User always hits Send themselves.** Cortex never submits on the user's behalf — keeps the trust line clear.
- **Always opens a new tab** with the destination provider's web UI. Cortex doesn't become a chat shell.
- **Payload is passed via extension storage, not URL params.** URL length limits + privacy (no sensitive content in URLs that show up in browser history).
- **"Continue" produces a brief recap, not a verbatim dump.** A 50-turn conversation can't fit in a chat input box; the handoff sends a summary + the last 2-3 turns. Summary generation reuses the v0.3 summarization work (already on the roadmap).

## Context-passing rules

For each user story, what travels:

| Story | What's pasted into the destination chat |
|---|---|
| Pivot ("critique this") | Last user message + last AI response + a one-line wrapper: `"Earlier Claude said the following — please review for errors:\n\n<prompt>\n\n<claude reply>"` |
| Continuation | Cortex-generated summary of the source conversation (v0.3 summarization dep) + last 2 turns verbatim + one-line wrapper |
| Fallback ("retry") | Just the last user message, unchanged |

**Old model's responses go to the new model in stories 1 and 2.** That's the whole point — the new model gets to see what the previous one said. The user understands they're sharing one AI's output with another; this is explicit, opt-in, and they review before sending.

## Backend plumbing

**For interpretation A, almost zero new backend.**
- **No API keys.** Cortex never calls model APIs.
- **No orchestration.** Cortex prepares a payload, hands it off via the existing extension storage channel.
- **One new IPC + one new endpoint:** `extension.preparePayload(memoryId, mode)` → returns a payload ID. The new-tab content script reads it back from extension storage.
- **One new content-script per provider** that recognizes the cortex-payload param, pastes into the input, and clears the param from the URL so refresh doesn't re-paste.
- **Summarization dep** for story 2: Cortex needs to summarize the source conversation. **This is blocked on v0.3 summarization (already on the roadmap as a separate v0.3 item).** Until summarization lands, story 2 ships with a "first 200 chars + last 200 chars" stub.

**If we later do B (chat client):** API key custody becomes the design problem. Options:
- Keys live in `userData/keys.json` encrypted at rest, decrypted in main process only, never sent to renderer. User pays per call.
- Keys live in OS keychain (electron-store + keytar).
- BYO Ollama-compatible endpoint (free, local, but only for open models).
- **Cortex never holds keys; uses the user's existing browser session via the extension to proxy through the web UI.** Sketchy, breaks TOS for all three providers. Not viable.

The cleanest B answer is OS keychain + per-call billing display in the UI. Out of scope for this spike.

## Rollout phases + effort

| Phase | Scope | Effort | Ship target |
|---|---|---|---|
| **v0.3.x** | Interpretation A. Stories 1 + 3 (pivot, fallback) only — they need no summarization dep. ChatGPT + Gemini as destinations, Claude as source. | **6-10 hrs** | v0.3 mid-cycle |
| **v0.3.y** | Add story 2 (continuation) once v0.3 summarization lands. Backfill Claude as a destination too. | **3-5 hrs** | v0.3 late |
| **v0.4 (maybe)** | Interpretation C (cross-model query, fan-out). Requires API keys → key-management UI → billing disclosure → at least one provider SDK. | **15-25 hrs** | Only if v0.3.x story 1 sees real usage in telemetry |
| **Never (probably)** | Interpretation B (full chat client). Reopens the strategic question. | n/a | — |

## Decision blockers (these need Shubh's input before v0.3 planning)

1. **Confirm the interpretation.** Is A what you wanted, or did you mean B or C? If B/C, this spike needs a redo as a full PRD because it's a different product.
2. **What's the input-box paste mechanism per provider?** Each web UI has a different way of accepting injected text. ChatGPT uses a contenteditable div; Gemini uses a textarea-like web component; Claude uses something else again. Each needs its own content-script paste helper. Want to scope a 30-min spike to verify all three before committing the v0.3.x estimate? Otherwise the 6-10 hr range could be off by 2-3 hrs in either direction.
3. **The summarization dep ordering.** Story 2 (continuation) only works if v0.3 summarization lands first. Two options: (a) ship v0.3.x with stories 1 + 3 only, summarization adds story 2 later in v0.3; (b) hold the whole switch-AI feature until summarization is done, ship them together as one v0.3 release note.
4. **Telemetry hook.** v0.2 P0 #5 telemetry should record `switch_ai_initiated{from_provider, to_provider, mode}` events so we can answer "do users actually use this?" before deciding on interpretation C in v0.4. **Worth adding this event to the P0 #5 event vocab now**, even though the feature itself ships in v0.3.

## Anti-recommendations (things we should NOT do)

- **Don't auto-submit on the user's behalf.** Hidden cost: TOS risk + user trust. Even if it "feels magic," one bad-output incident on the user's account is unrecoverable for Cortex's reputation.
- **Don't store API keys in v0.3.** If we go to B/C, it's a v0.4+ decision with proper key-management UX. Don't sneak it in.
- **Don't ship interpretation A as "use any model in Cortex."** The marketing claim has to match what it does — "open this conversation in your other AI" is honest; "switch models seamlessly" implies B and will draw complaints when users discover it's a tab-opener.
- **Don't build a meta-prompt template UI in v0.3.** Story 1's "please critique this" wrapper is hardcoded. If users want custom wrappers, that's a v0.4 setting.

## Going-into-v0.3-backlog status

- **Lands in `v0.2-FULL-ROADMAP.md` backlog as:** "P1 #5 switch-AI (interpretation A, stories 1+3) — 6-10 hrs, v0.3.x. Pending: Shubh confirms A vs B/C; 30-min paste-mechanism spike per provider."
- **Adds to v0.2 P0 #5 telemetry event list:** `switch_ai_initiated{from, to, mode}`.
- **Reopens at v0.3 planning meeting.** If interpretation A is confirmed and the paste-spike is green, this is a clean 6-10 hr v0.3 deliverable.
