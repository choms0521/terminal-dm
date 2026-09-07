# KakaoTalk inline image preview — implementation plan

Status: planned (staged). Follows the spike findings in
`received-media-terminal-preview.md`.

## Goal

Let the user preview a received/visible KakaoTalk image (photo or sticker)
inline in the terminal-dm TUI, rendered with the Kitty graphics protocol.
Delivered in two stages:

- **Stage 1** — `/preview`: preview the most recent image in the active
  conversation.
- **Stage 2** — message-cursor selection: move a cursor over messages and
  preview the selected image, scrolling KakaoTalk into view when needed.

## What is already proven

- **Rendering**: JPEG/PNG → (sips → PNG) → base64 → Kitty graphics escape
  renders inline in Ghostty (the user's terminal). Verified end to end.
- **Kinds**: the bridge already tags photo (`image` → "(사진)"), sticker
  (`sticker` → "(이모티콘)"), and file attachments ("(파일: name)"). Videos are
  indistinguishable from photos over Accessibility and stay `image`.
- **Path spike**: AX exposes no image path; `Finder에서 보기` yields an exact
  path but only for file attachments and pops Finder; the temp cache is
  content-hashed with no per-message/per-conversation mapping. Conclusion:
  photos/stickers must be obtained by **capturing the on-screen bubble region**.

## Hard constraints (apply to every stage)

1. **On-screen only.** Capturing pixels requires the target bubble to be
   currently visible in the KakaoTalk chat window. A message scrolled out of
   view cannot be captured unless KakaoTalk is first scrolled to it (Stage 2).
2. **Screen Recording permission.** `screencapture` of window contents needs the
   macOS Screen Recording permission for the host process (one-time grant). The
   feature must fail with a clear message when it is not granted.
3. **Privacy / ephemeral.** The project persists no media. The captured image
   goes to a temp file that is deleted immediately after it is rendered; nothing
   durable is written.
4. **Terminal capability.** Only terminals that speak the Kitty graphics
   protocol can render. Detect capability and fall back to a text notice
   ("this terminal cannot show images") otherwise.
5. **Video limitation.** Videos render as their thumbnail (same as a photo);
   there is no separate video handling.

## Architecture

Three layers, mirroring the existing send/messages flow.

### 1. Swift bridge — a `captureMessageImage` action

- Input: the chat window title, plus a selector for *which* image bubble
  (Stage 1: "latest"; Stage 2: an index among image/sticker bubbles from the
  bottom, matching the order `messages()` returns).
- Locate the target bubble's `AXImage` in the chat window's message table (reuse
  the row-walking and `mediaMarker` logic already in `messages()`), read its
  screen rect (`AXPosition` + `AXSize`).
- Capture just that window's pixels without stealing focus, using
  `screencapture -l <CGWindowID> -o -x <tmp>.png` (window capture, no shadow,
  no sound), then crop the bubble rect from the window image — OR
  `screencapture -R x,y,w,h -o -x <tmp>.png` if window-id capture proves
  awkward. Prefer window capture so KakaoTalk need not be frontmost.
  (**Spike required — see Stage 0.**)
- Return the temp PNG path (and the bubble's pixel size for sizing the render).
- If the bubble is not on screen (no rect, or zero size), return a
  "not visible" result so the UI can explain instead of capturing the wrong
  region.

### 2. TS connector — an optional capability

- Add `previewImage?(selector): Promise<{ path: string; width: number;
  height: number } | { unavailable: reason }>` to the connector interface
  (only KakaoTalk implements it), calling the bridge action.
- The connector owns temp-file lifetime: hand the path to the renderer, then
  delete it.

### 3. TUI — command, rendering, and Ink integration

- **Terminal probe**: detect Kitty support (`TERM`/`TERM_PROGRAM`, e.g.
  `ghostty`, `xterm-kitty`, `WezTerm`); expose `image: "kitty" | "none"`.
- **Kitty renderer**: pure function `bytes → escape string`, chunked at 4096
  base64 chars, sized to a sensible column width. Unit-testable.
- **Ink integration (the tricky part)**: Ink owns the screen and redraws on
  every state change, which will erase a raw image escape. Options to evaluate,
  cheapest first:
  1. Write the escape once directly to `stdout` *below* the current Ink frame
     and let it scroll into the transcript (simplest; image stays in scrollback).
  2. Briefly suspend Ink rendering, emit the image, resume.
  3. Use the Kitty protocol's placement/placeholder so Ink text can coexist.
  Start with (1); it matches how the app already does raw writes
  (`write("[2J…")`).

## Stage 0 — capture spike — DONE (resolved)

Verified in the real GUI environment (Claude Code session, which has
Accessibility + Screen Recording). Region capture of a specific bubble works:

1. Find the target image bubble's `AXImage` (reuse the `messages()` /
   `mediaMarker` row walk). Read its screen rect via `AXPosition` + `AXSize`
   (points, top-left origin).
2. Raise the chat window (`AXRaise` + `NSRunningApplication.activate()`, ~500ms
   settle) so the bubble is not occluded by the terminal.
3. `/usr/sbin/screencapture -x -R "<x>,<y>,<w>,<h>" -o <tmp>.png`
   (`-x` silent, `-R` region, `-o` no shadow). On a Retina display the PNG is 2x
   the point size (a 212x132pt bubble → 424x264px), and the file carries real
   image content (~57KB, not a blank frame). Confirmed on a real photo bubble.

Notes:
- Region capture requires the bubble on screen and KakaoTalk raised (a brief
  focus flash). Window-id capture (`screencapture -l <CGWindowID>`) + crop could
  avoid the flash later, but region capture is proven and is the baseline.
- **This step cannot be verified inside the Codex sandbox** (no display access:
  `screencapture` reports "does not intersect any displays"). Runtime GUI
  verification is done by the coordinator, not Codex.

## Stage 1 — `/preview` most recent image

1. Bridge `captureMessageImage` with selector "latest": the last
   image/sticker bubble in the current chat.
2. Connector `previewImage("latest")`.
3. `/preview` slash command (+ alias) in `slash-commands.ts`; i18n copy for
   "capturing…", "shown", "not visible", "terminal unsupported",
   "no image in this conversation".
4. Terminal probe + Kitty renderer; emit below the Ink frame.
5. Temp file deleted after render.

Acceptance: with an image visible at the bottom of the active KakaoTalk chat,
`/preview` shows it inline in Ghostty; unsupported terminals and missing
permission give clear notices; no temp file remains.

## Stage 2 — message-cursor selection

1. Message-selection mode in the TUI (reuse `selectedIndex` /
   `getSelectionWindow` / `wrapSelectionIndex` patterns): arrow keys move a
   highlight over the message window; a key (or `/preview` with the cursor
   active) previews the selected message when it is an image/sticker.
2. Map the selected TUI message to the bridge selector — an index among
   image/sticker messages counted from the bottom, consistent with
   `messages()` ordering.
3. Scroll-into-view: if the selected bubble is not on screen, ask the bridge to
   scroll the KakaoTalk message table to that row (reuse `scrollOlder`-style
   AX scrolling) before capturing; if it still cannot be shown, report "not
   visible".

Acceptance: selecting any image message in the current window previews that
specific image; selecting a text message does nothing (or a hint); off-screen
selections are scrolled into view or clearly reported.

## Testing / verification

- Unit tests (TS): terminal-capability probe; Kitty escape generation
  (chunking, size); selector index math.
- Manual/live: Stage 1 and Stage 2 acceptance above, in Ghostty.
- Bridge changes verified via `swiftc` compile + a live capture check, as with
  the existing send/messages work.

## Open questions

- Exact `screencapture` invocation (window-id capture + crop vs region) —
  resolved by Stage 0.
- Render sizing: fixed column width vs. proportional to the bubble's pixel size.
- Whether Stage 2's scroll-into-view is reliable enough, or should be deferred.

## Out of scope

- Instagram preview (separate connector path).
- Video playback or a distinct video marker (AX cannot distinguish videos).
- Persisting or exporting media.
