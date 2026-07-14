# MiddleGround — Your Setup & User Guide

**Your app is live right now at:**

## https://matthewj29-hills.github.io/middleground/

It runs entirely from GitHub Pages (free, forever, HTTPS) — your computer does **not** need to be on.

---

## 1. What was built

MiddleGround is a live conversation companion. Open it during a debate or disagreement and it:

- **Transcribes the conversation live** on screen, splitting it into speaker turns (Speaker 1 red, Speaker 2 blue). Tap any speaker label to correct who said it.
- **Min, the assistant** (purple), can be asked anything by saying **"Min, …"** or tapping the **Ask Min** button. It answers using the conversation as context, speaks aloud, and shows the answer on screen. Current-events questions trigger a real live web search with source links.
- **Automatic fact-checking** listens for concrete factual claims, verifies them against live web sources, and interrupts calmly — only for clearly false, material claims with high confidence. Opinions, predictions, and values are never "corrected." At most one interruption per 90 seconds, six per session.
- **Tap Stop** and it produces a common-ground report: what you talked about, each person's viewpoint, where you already agree, verified facts, unsettled claims, misunderstandings, the core disagreement, and realistic common ground. No winners, no scores.
- The full transcript is always available, everything stays on your phone, and you can clear it anytime.

Total cost: **$0, permanently.** No accounts in the app, no servers, no card ever.

## 2. One-time iPhone setup (2 minutes)

1. Open **Safari** on your iPhone (it must be Safari — see limitations).
2. Go to `https://matthewj29-hills.github.io/middleground/`
3. Tap **Settings** (bottom right) → paste your Groq key into **Groq API key**:
   `gsk_…` (the key you created at console.groq.com — you already have it). You should see "Key works. Full features enabled."
4. Tap **Back**.
5. Tap the **Share** button (square with arrow) → **Add to Home Screen** → **Add**. MiddleGround now opens like a normal app.
6. First time you tap the red **Record** button, Safari asks for microphone access → tap **Allow**.

The key is stored only on your phone (localStorage). It is not in the public code. Friends using the app on their own phones each enter a key once — or use it key-less in basic mode.

## 3. How to use it

- **Start:** open MiddleGround → tap the red circle. "Listening" appears at the top.
- **Talk normally.** Words appear live; turns get speaker colors. Tap a wrong speaker label to cycle Speaker 1 → 2 → 3.
- **Ask Min by voice:** say "**Min**, is that true?" / "Min, what did he say earlier?" / "Min, what's the current inflation rate?" — start the sentence with "Min."
- **Ask Min by button:** tap **Ask Min**, then just speak your question.
- **Skip an answer:** tap **Skip** while Min is speaking.
- **Fact-checks** arrive on their own as purple "Min · fact check" entries (spoken aloud), or as quiet "Worth checking" cards when confidence is moderate.
- **Finish:** tap **Stop** → read the common-ground report → **Transcript** for the full text → **Clear this conversation** when done.

## 4. Five-minute verification script (do this with a friend)

1. Tap Record. Both of you speak a few sentences. → Words appear; two speaker colors show up after natural pauses.
2. Say: "**Min, what did we just say?**" → Min acknowledges/answers on screen and aloud.
3. Say: "**Min, what's the latest news about the Federal Reserve?**" → Answer includes clickable source links.
4. Say: "**Water boils at 100 degrees Celsius.**" → Nothing happens (true claims are left alone).
5. Say: "**In my opinion pineapple belongs on pizza.**" → Nothing happens (opinions are never corrected).
6. Say: "**The Great Wall of China is visible from the Moon, that's a proven fact.**" Keep chatting ~30 seconds. → Min interjects with a calm factual note.
7. Tap **Stop** → report appears with agreements and the core disagreement. Open **Transcript**. Then **Clear**.

## 5. Troubleshooting

- **Mic doesn't work:** iPhone Settings → Apps → Safari → Microphone → Allow. Then reopen the app.
- **"Speech recognition unavailable":** you're in Chrome/a webview — use Safari or the home-screen icon.
- **Min doesn't respond to the wake word:** noisy room or mumbled trigger — use the **Ask Min** button (that's what it's for).
- **"Rate limit" / basic lookup answers:** the free Groq tier throttles occasionally. Wait a minute; the app automatically falls back and recovers. Fact-checks queue and retry on their own.
- **Answers stop being spoken:** check silent-mode switch/volume; answers always appear on screen regardless.
- **Screen locked / app backgrounded:** iOS pauses the mic. Reopen the app — it resumes automatically. Keep the screen on during a session.
- **Session vanished after a refresh:** it autosaves — tap "Resume last transcript" on the home screen.

## 6. Honest limitations

- **Speaker labels are a heuristic** (based on pauses), not real voice recognition — browsers don't expose voice identity. Expect errors when people talk fast over each other; tap labels to fix, and Min hedges attribution accordingly.
- **iOS Safari only** for live transcription (Chrome on iPhone lacks the API). Transcription requires internet (Apple's speech service).
- **The screen must stay on** — iOS does not allow background microphone use for web apps.
- **Free-tier limits:** Groq allows ~250 search-model requests/day and throttles bursts. Normal conversations fit comfortably; the app degrades gracefully (queues, retries, Wikipedia fallback) and tells you when it does.
- **Wake-word detection** comes from the transcription stream, so "Min" is only caught when transcribed correctly. The manual button always works.
- **Fact-checking is deliberately conservative.** It will miss some false claims rather than risk wrongly interrupting. That's by design.

## 7. Test evidence

- 30 unit tests passing (wake word, speaker turns, fact-check gating, dedupe, context compression, source extraction, search routing).
- 7 live API integration tests against Groq (claim screening flags false claims, ignores opinions; verification cites sources; context Q&A; live-search Q&A; report fairness).
- Full end-to-end tests on the **deployed** site in a real browser at iPhone size (390×844): recording flow, live transcript, wake word → Min answer → resume listening, automatic fact-check interruption of a false claim, no interruption for opinions/true claims, report generation, transcript view, session clear, no-key degraded mode, TTS-failure fallback, refresh recovery. Zero console errors.
- Production build clean; PWA manifest + service worker verified on the live URL.
- Source code: https://github.com/matthewj29-hills/middleground

*Remaining manual check (needs your physical iPhone): microphone quality in your rooms, wake-word hit rate with your voices, and TTS voice choice — all covered by the verification script above.*
