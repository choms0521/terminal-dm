# KakaoTalk visible image gallery

Status: implemented on `feat/kakao-image-preview`; live GUI verification pending.
This supersedes the previous latest-image and message-cursor selection plan.

## Behavior

- `/preview` and `/p` show all currently visible photo/sticker bubbles in the
  active KakaoTalk chat, ordered top-to-bottom.
- Arguments are unsupported. `select`, `latest`, and numeric selection have
  been removed along with the message cursor and native preview index/count data.
- Chat text and photo/sticker markers remain unchanged. Videos still appear as
  thumbnails because Accessibility does not distinguish them from photos.
- Existing visibility checks require the entire bubble to fit in the chat
  viewport, window, and an active display. Partially clipped bubbles are skipped.
- No scrolling, window activation, or raising occurs during capture.

## Bridge

`captureVisibleImages` takes the active window title (`title` in the JSON RPC).
It checks `AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()` before
accessing the chat. Missing permission returns `permission-denied`.

The action uses `imageRows(in:)` and `visibleImageRect(_:in:window:)`, sorts the
resulting rectangles by vertical position, and returns `{ images: [] }` if none
qualify. It resolves the on-screen window id using `onScreenWindowID(pid:bounds:)`
and runs `/usr/sbin/screencapture -x -o -l <windowID> <temp>` exactly once through
`Process` with array arguments. This captures the window regardless of z-order.

One `NSBitmapImageRep` supplies the source image for every crop. The scale is
`windowImage.width / windowRect.width`; each bubble rectangle is translated to
window-relative coordinates, scaled, and intersected with image bounds.
Each crop becomes its own `mkstemps` mode-0600 PNG. The whole-window screenshot
is always removed. A failed batch removes all crops already created; success
returns `{ images: [{ path, width, height }, ...] }` and transfers file ownership.

The former `captureMessageImage` action and scroll-to-selection helper are gone.

## Connector and file ownership

`ChatConnector.previewImages?()` returns `ImageGalleryResult`:
`{ images: ImagePreview[] } | { unavailable: string }`. KakaoTalk implements it;
`UnifiedChatConnector` delegates to the active connector or reports unsupported.
Capture waits for an outstanding native refresh and rejects concurrent actions.
If shutdown or a conversation change abandons a result, the connector deletes
its crops. Otherwise the UI deletes every returned file in `finally`, including
files not reached when rendering fails. The shutdown path waits for capture
and abandoned-result cleanup before stopping the action bridge.

## Terminal handoff

The terminal probe and Kitty encoder remain in `src/ui/terminal-image.ts`.
Unsupported terminals are rejected before capture. Empty results and permission,
busy, unavailable-window, or capture failures produce localized notices.

After flushing pending output, `App` uses Ink 7's `useApp().suspendTerminal()`
handle to release rendering and input while retaining the mounted React tree and
connector subscriptions. The gallery clears the screen, writes each PNG through
Kitty with an index and blank spacing, and waits for a key after a localized hint.
Rows are reserved before image placement so `C=1` cannot clip an image at the
bottom edge. A tall gallery uses the terminal's normal scrollback.

A temporary raw-input reader consumes the dismissal chunk and restores its modes
and listeners on keypress, end-of-input, error, or abort. Gallery image ids are
explicitly deleted from the terminal when the view closes. The UI resumes Ink
and increments the Static transcript epoch to replay chat history. Resize redraws
are suppressed while preview owns the terminal. Unmount aborts the wait and
cleans files without reattaching Ink input to an exited app.

## Verification

- Compile: `CLANG_MODULE_CACHE_PATH=/tmp/tdm-mc swiftc scripts/kakao-bridge.swift -o /tmp/tdm-bridge-check`.
- Run `npm run build`, `npm run typecheck`, and `npm test`.
- Automated tests cover gallery order, Kitty encoding, file cleanup, capture
  races, unsupported/empty/error results, input isolation, snapshot/resize
  silence, transcript restoration, and unmount cleanup using fake connectors.
- Live acceptance still requires a logged-in KakaoTalk chat and a Kitty-capable
  terminal: inspect photo/sticker crops, chronological order, tall-gallery
  scrollback, Retina scaling, and return to the normal TUI. Automated terminal
  stream checks do not establish actual GUI pixel or terminal rendering quality.
