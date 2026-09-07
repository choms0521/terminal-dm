# Received media terminal preview (future task)

Status: planned (to be implemented after KakaoTalk file send)

## Goal

Let users preview media that other people send (photos, and possibly files)
directly inside the terminal-dm terminal UI, instead of only seeing a text marker
such as `(사진)` / `(파일)`.

## Current behavior

- The connectors normalize incoming media into text markers only. Photos,
  videos, Reels, posts, stickers, etc. are shown as connector-independent
  message kinds (`image`, `video`, ...) rendered as short text labels.
  See `README.md` (platform/content support) and `src/domain.ts` `MessageKind`.
- The raw media files are never downloaded or rendered. For KakaoTalk the
  Accessibility tree exposes the message bubble (and buttons like `열기` /
  `Finder에서 보기`) but not the pixels in a form the TUI renders.
- Result today: "a photo arrived" is visible as a marker, but the image itself
  cannot be seen in the terminal.

## Why it is non-trivial

1. **Terminal image support is not universal.** Only some terminals render
   inline images:
   - iTerm2 inline images protocol (OSC 1337 `File=...:base64`)
   - Kitty graphics protocol
   - Sixel (a subset of terminals)
   Plain Terminal.app and many others cannot show images at all. We must detect
   capability and fall back to the current text marker.
2. **We must obtain the actual bytes.** The connectors are deliberately
   read-only over the visible UI and do not fetch media.
   - Instagram: the image is a DOM `<img>`; we could read its `src` and fetch
     the bytes via the existing Playwright page context (staying within the
     logged-in session), then hand raw bytes to the renderer.
   - KakaoTalk: the desktop app stores received files locally; the AX bubble may
     expose a file path via the `열기` / `Finder에서 보기` affordances. Needs
     investigation to find a stable way to resolve the on-disk path without
     saving anything new ourselves.
3. **Privacy/design fit.** terminal-dm is intentionally ephemeral and does not
   persist media. Any preview must be transient (in-memory / temp only) and must
   not create a durable media archive. This must stay consistent with the
   project's local-first, no-storage stance.

## Proposed approach (draft)

1. Add a terminal-capability probe (env + terminfo) → one of
   `iterm2 | kitty | sixel | none`.
2. Add an optional connector capability to resolve raw bytes for a given media
   message id (Instagram via page fetch; KakaoTalk via resolved local path).
3. Add a renderer that emits the correct inline-image escape sequence for the
   detected protocol, sized to the composer width, with a text-marker fallback.
4. Gate behind a setting/flag (default off) so unsupported terminals and
   privacy-sensitive users are unaffected.

## Open questions

- Reliable way to resolve a KakaoTalk received file's on-disk path from the AX
  tree (or is a different mechanism required?).
- Should preview be automatic for the active conversation, or on-demand
  (e.g. a `/preview` command or a key on the selected message)?
- Size/again-fetch policy to avoid re-downloading on every refresh.

## Notes

- Findings captured during the KakaoTalk file-send work: the app's Accessibility
  tree shows received file bubbles with `열기` and `Finder에서 보기` buttons,
  which is a promising lead for resolving local file paths.

## Spike results (KakaoTalk path resolution)

Terminal capability of the target environment: **Ghostty** → Kitty graphics
protocol is available, so inline preview is feasible.

Path-resolution findings for KakaoTalk received media:

- **AX tree exposes no path.** `AXImage` bubbles carry only a role description;
  the `열기` / `Finder에서 보기` buttons and the filename `AXStaticText` expose no
  `AXURL`, `AXFilename`, or path attribute.
- **`AXShowMenu` is unsupported** on image elements (error -25206), and a
  synthesized right-click did not surface a context menu reachable through the AX
  tree, so a "copy image → read clipboard" path is not currently viable.
- **`Finder에서 보기` works.** Pressing that button via `AXPress` and then reading
  the Finder selection with AppleScript
  (`POSIX path of (item 1 of (get selection) as alias)`) returns the exact
  on-disk path (verified: `/Users/mscho/Downloads/1782871715266.png`). Reliable,
  but it pops a Finder window to the foreground (disruptive) and only applies to
  bubbles that expose the button (downloaded file/photo attachments).
- **Local cache exists.** KakaoTalk caches displayed media as real JPEGs under
  `~/Library/Containers/com.kakao.KakaoTalkMac/Data/tmp/<hash>/tempMedia/`.
  Filenames are content hashes with no message mapping, so selecting the right
  file for a specific message is a heuristic (e.g. most-recent by mtime) rather
  than exact.

Implications: reliable resolution requires an active step (Finder reveal), which
is disruptive; the non-disruptive cache route is approximate. Inline photos that
have not been downloaded may lack the `Finder에서 보기` affordance and need a
download trigger first.
