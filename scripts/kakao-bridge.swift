import ApplicationServices
import AppKit
import Foundation

enum BridgeError: Error, CustomStringConvertible {
  case message(String)

  var description: String {
    switch self {
    case .message(let value): return value
    }
  }
}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}

func setAttribute(_ element: AXUIElement, _ name: CFString, _ value: CFTypeRef) throws {
  let result = AXUIElementSetAttributeValue(element, name, value)
  if result != .success { throw BridgeError.message("Accessibility 값을 설정하지 못했습니다: \(result.rawValue)") }
}

func children(of element: AXUIElement) -> [AXUIElement] {
  attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
  attribute(element, name) as? String
}

func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool {
  attribute(element, name) as? Bool ?? false
}

func role(of element: AXUIElement) -> String {
  stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
}

func title(of element: AXUIElement) -> String {
  stringAttribute(element, kAXTitleAttribute as CFString)
    ?? stringAttribute(element, kAXValueAttribute as CFString)
    ?? ""
}

func position(of element: AXUIElement) -> CGPoint? {
  guard let value = attribute(element, kAXPositionAttribute as CFString) else { return nil }
  let axValue = unsafeBitCast(value, to: AXValue.self)
  guard AXValueGetType(axValue) == .cgPoint else { return nil }
  var point = CGPoint.zero
  guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
  return point
}

func size(of element: AXUIElement) -> CGSize? {
  guard let value = attribute(element, kAXSizeAttribute as CFString) else { return nil }
  let axValue = unsafeBitCast(value, to: AXValue.self)
  guard AXValueGetType(axValue) == .cgSize else { return nil }
  var size = CGSize.zero
  guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
  return size
}

func descendants(of element: AXUIElement, matching targetRole: String) -> [AXUIElement] {
  var result: [AXUIElement] = []
  var pending = Array(children(of: element).reversed())
  while let current = pending.popLast() {
    if role(of: current) == targetRole { result.append(current) }
    pending.append(contentsOf: children(of: current).reversed())
  }
  return result
}

func senderCandidate(_ value: String) -> String? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  if trimmed == "수정됨" || trimmed == "삭제됨" { return nil }
  let lines = trimmed.split(whereSeparator: \Character.isNewline).map {
    String($0).trimmingCharacters(in: .whitespaces)
  }
  if lines.contains(where: { $0.hasPrefix("오전 ") || $0.hasPrefix("오후 ") }) { return nil }
  if trimmed.range(of: #"^\d+\+?$"#, options: .regularExpression) != nil { return nil }
  return trimmed
}

final class KakaoAccessibility {
  private var previousApplication: NSRunningApplication?
  private var composerCache: [String: (input: AXUIElement, sendButton: AXUIElement)] = [:]
  private var runningApplication: NSRunningApplication {
    get throws {
      guard let application = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleIdentifier == "com.kakao.KakaoTalkMac" || $0.localizedName == "KakaoTalk"
      }) else { throw BridgeError.message("KakaoTalk이 실행 중이 아닙니다.") }
      return application
    }
  }

  private var applicationElement: AXUIElement {
    get throws { AXUIElementCreateApplication(try runningApplication.processIdentifier) }
  }

  private func windows() throws -> [AXUIElement] {
    attribute(try applicationElement, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
  }

  private func window(named name: String) throws -> AXUIElement {
    guard let window = try windows().first(where: { title(of: $0) == name }) else {
      throw BridgeError.message("KakaoTalk 창을 찾을 수 없습니다: \(name)")
    }
    return window
  }

  private func mainList() throws -> (AXUIElement, AXUIElement, AXUIElement) {
    let mainWindow = try window(named: "카카오톡")
    guard let scrollArea = children(of: mainWindow).first(where: { role(of: $0) == kAXScrollAreaRole as String }),
          let table = children(of: scrollArea).first(where: { role(of: $0) == kAXTableRole as String }),
          let scrollBar = children(of: scrollArea).first(where: { role(of: $0) == kAXScrollBarRole as String }) else {
      throw BridgeError.message("KakaoTalk 대화 목록을 찾을 수 없습니다.")
    }
    return (mainWindow, table, scrollBar)
  }

  func ensureMainWindow() throws {
    if try windows().contains(where: { title(of: $0) == "카카오톡" }) { return }
    let previousApplication = NSWorkspace.shared.frontmostApplication
    let application = try runningApplication
    application.activate()
    let appElement = try applicationElement
    guard let menuBar = children(of: appElement).first(where: { role(of: $0) == kAXMenuBarRole as String }),
          let windowMenu = children(of: menuBar).first(where: { title(of: $0) == "창" }),
          let menu = children(of: windowMenu).first,
          let chatItem = descendants(of: menu, matching: kAXMenuItemRole as String).first(where: { title(of: $0) == "채팅" }) else {
      throw BridgeError.message("KakaoTalk 채팅 메뉴를 찾을 수 없습니다.")
    }
    let result = AXUIElementPerformAction(chatItem, kAXPressAction as CFString)
    if result != .success { throw BridgeError.message("KakaoTalk 채팅 목록을 열지 못했습니다.") }
    usleep(500_000)
    if let previousApplication, previousApplication != application {
      previousApplication.activate()
    }
  }

  func conversations(limit: Int) throws -> [[String: Any]] {
    try ensureMainWindow()
    let (_, table, scrollBar) = try mainList()
    try setAttribute(scrollBar, kAXValueAttribute as CFString, NSNumber(value: 0))
    defer { try? setAttribute(scrollBar, kAXValueAttribute as CFString, NSNumber(value: 0)) }
    usleep(250_000)
    var rows = children(of: table).filter { role(of: $0) == kAXRowRole as String }
    let requestedCount = min(max(1, limit), rows.count)
    let pageSize = 8
    var result: [[String: Any]] = []

    for offset in 0..<requestedCount {
      // KakaoTalk virtualizes the descendants of rows outside the viewport.
      // Move each page into view before resolving its labels; otherwise a row
      // can expose stale title/preview nodes from a neighbouring conversation.
      if offset > 0 && offset % pageSize == 0 {
        let denominator = max(1, rows.count - 5)
        let targetRow = offset + 1
        let scrollValue = min(1, Double(max(0, targetRow - 4)) / Double(denominator))
        try setAttribute(scrollBar, kAXValueAttribute as CFString, NSNumber(value: scrollValue))
        usleep(250_000)
        rows = children(of: table).filter { role(of: $0) == kAXRowRole as String }
      }

      guard offset < rows.count else { break }
      let row = rows[offset]
      guard let cell = children(of: row).first else { continue }
      let labels = descendants(of: cell, matching: kAXStaticTextRole as String)
      guard let roomTitle = labels.first.map(title), !roomTitle.isEmpty else { continue }
      let preview = descendants(of: cell, matching: kAXTextAreaRole as String).first.map(title) ?? ""
      let time = labels.last.map(title) ?? ""
      result.append([
        "row": offset + 1,
        "title": roomTitle,
        "preview": preview,
        "time": time,
        "unread": labels.count >= 3,
      ])
    }

    return result
  }

  func prepareOpen(row: Int, expectedTitle: String) throws -> [String: Double] {
    try ensureMainWindow()
    if try windows().contains(where: { title(of: $0) == expectedTitle }) {
      return ["alreadyOpen": 1]
    }
    previousApplication = NSWorkspace.shared.frontmostApplication
    let kakaoApplication = try runningApplication
    let (mainWindow, table, scrollBar) = try mainList()
    let rows = children(of: table).filter { role(of: $0) == kAXRowRole as String }
    guard row > 0, row <= rows.count else { throw BridgeError.message("KakaoTalk 대화 행이 없습니다.") }
    if row > 5 {
      let denominator = max(1, rows.count - 5)
      try setAttribute(scrollBar, kAXValueAttribute as CFString, NSNumber(value: Double(row - 4) / Double(denominator)))
    } else {
      try setAttribute(scrollBar, kAXValueAttribute as CFString, NSNumber(value: 0))
    }
    usleep(350_000)
    // KakaoTalk virtualizes and may reorder row objects while scrolling. Read
    // the AX rows again, then resolve the exact title from the current tree;
    // never click a stale coordinate that now belongs to another room.
    let refreshedRows = children(of: table).filter { role(of: $0) == kAXRowRole as String }
    let expectedIndex = row - 1
    let indexedCell = expectedIndex < refreshedRows.count ? children(of: refreshedRows[expectedIndex]).first : nil
    let indexedTitle = indexedCell.flatMap {
      descendants(of: $0, matching: kAXStaticTextRole as String).first.map(title)
    } ?? ""
    let matchingCell = indexedTitle == expectedTitle ? indexedCell : refreshedRows.compactMap {
      children(of: $0).first
    }.first {
      descendants(of: $0, matching: kAXStaticTextRole as String).first.map(title) == expectedTitle
    }
    guard let cell = matchingCell else {
      throw BridgeError.message("KakaoTalk 대화 순서가 변경되었습니다. 다시 시도해주세요.")
    }
    guard let cellPosition = position(of: cell), let cellSize = size(of: cell) else {
      throw BridgeError.message("KakaoTalk 대화 행 좌표를 읽지 못했습니다.")
    }
    kakaoApplication.activate()
    try? setAttribute(mainWindow, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    let raiseResult = AXUIElementPerformAction(mainWindow, kAXRaiseAction as CFString)
    if raiseResult != .success {
      throw BridgeError.message("KakaoTalk 대화 목록 창을 앞으로 가져오지 못했습니다.")
    }
    usleep(150_000)
    return [
      "x": cellPosition.x + min(140, cellSize.width / 2),
      "y": cellPosition.y + cellSize.height / 2,
    ]
  }

  func waitForWindow(expectedTitle: String) throws {
    let kakaoApplication = try runningApplication
    for _ in 0..<15 {
      if try windows().contains(where: { title(of: $0) == expectedTitle }) {
        if let previousApplication, previousApplication != kakaoApplication {
          previousApplication.activate()
        }
        return
      }
      usleep(200_000)
    }
    throw BridgeError.message("KakaoTalk 대화창을 열지 못했습니다: \(expectedTitle)")
  }

  func doubleClick(x: Double, y: Double) throws {
    let originalPosition = CGEvent(source: nil)?.location
    let target = CGPoint(x: x, y: y)

    func post(_ type: CGEventType, clickCount: Int64) throws {
      guard let event = CGEvent(
        mouseEventSource: nil,
        mouseType: type,
        mouseCursorPosition: target,
        mouseButton: .left
      ) else { throw BridgeError.message("KakaoTalk 클릭 이벤트를 만들지 못했습니다.") }
      event.setIntegerValueField(.mouseEventClickState, value: clickCount)
      event.post(tap: .cghidEventTap)
    }

    try post(.leftMouseDown, clickCount: 1)
    try post(.leftMouseUp, clickCount: 1)
    usleep(120_000)
    try post(.leftMouseDown, clickCount: 2)
    try post(.leftMouseUp, clickCount: 2)
    usleep(120_000)
    if let originalPosition { CGWarpMouseCursorPosition(originalPosition) }
  }

  func messages(windowTitle: String, direction: String, limit: Int) throws -> [[String: String]] {
    let chatWindow = try window(named: windowTitle)
    guard let windowPosition = position(of: chatWindow), let windowSize = size(of: chatWindow) else {
      throw BridgeError.message("KakaoTalk 대화창 좌표를 읽지 못했습니다.")
    }
    let scrollAreas = children(of: chatWindow).filter { role(of: $0) == kAXScrollAreaRole as String }
    guard let messageTable = scrollAreas.first.flatMap({ area in
      children(of: area).first(where: { role(of: $0) == kAXTableRole as String })
    }) else { throw BridgeError.message("KakaoTalk 메시지 표를 찾지 못했습니다.") }
    let rows = children(of: messageTable).filter { role(of: $0) == kAXRowRole as String }
    let windowLimit = max(1, min(20, limit))
    // KakaoTalk gives photos, videos and large emoticons their own rows, but
    // those rows usually have no readable text area. Counting raw rows first
    // made an 8-message request return only 3-4 text messages. Walk past media
    // rows until the requested number of readable messages has been collected.
    var selectedRows: [AXUIElement] = []
    var readableCount = 0
    let candidateRows = direction == "older" ? rows : Array(rows.reversed())
    for row in candidateRows {
      selectedRows.append(row)
      if readableMessageText(in: row) != nil { readableCount += 1 }
      if readableCount >= windowLimit { break }
    }
    if direction != "older" { selectedRows.reverse() }
    var output: [[String: String]] = []
    var lastSender = ""
    for row in selectedRows {
      guard let cell = children(of: row).first else { continue }
      let cellElements = children(of: cell)
      var textAreas: [AXUIElement] = []
      var labels: [AXUIElement] = []
      for element in cellElements {
        let elementRole = role(of: element)
        if elementRole == kAXTextAreaRole as String { textAreas.append(element) }
        else if elementRole == kAXStaticTextRole as String { labels.append(element) }
      }
      guard let messageArea = textAreas.last,
            let rawMessageText = stringAttribute(messageArea, kAXValueAttribute as CFString),
            !rawMessageText.isEmpty,
            let messagePosition = position(of: messageArea),
            let messageSize = size(of: messageArea) else { continue }
      let messageText = rawMessageText.trimmingCharacters(in: .whitespacesAndNewlines)
      if messageText == "여기까지 읽었습니다." ||
         messageText == "여기까지 읽었습니다" ||
         messageText == "메시지가 삭제되었습니다." ||
         messageText == "메시지가 삭제되었습니다" { continue }
      let isEdited = labels.contains {
        title(of: $0).trimmingCharacters(in: .whitespacesAndNewlines) == "수정됨"
      }
      var sender = "나"
      let leftInset = messagePosition.x - windowPosition.x
      let rightInset = windowPosition.x + windowSize.width - (messagePosition.x + messageSize.width)
      if leftInset <= rightInset {
        for label in labels {
          if let candidate = senderCandidate(title(of: label)) { lastSender = candidate }
        }
        sender = lastSender.isEmpty ? "unknown" : lastSender
      }
      output.append(["text": isEdited ? "\(messageText) (수정됨)" : messageText, "sender": sender])
    }
    return output
  }

  private func readableMessageText(in row: AXUIElement) -> String? {
    guard let cell = children(of: row).first else { return nil }
    let messageArea = children(of: cell).last(where: {
      role(of: $0) == kAXTextAreaRole as String
    })
    guard let messageArea,
          let rawText = stringAttribute(messageArea, kAXValueAttribute as CFString) else {
      return nil
    }
    let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty ||
       text == "여기까지 읽었습니다." ||
       text == "여기까지 읽었습니다" ||
       text == "메시지가 삭제되었습니다." ||
       text == "메시지가 삭제되었습니다" {
      return nil
    }
    return text
  }

  private func composer(windowTitle: String) throws -> (input: AXUIElement, sendButton: AXUIElement) {
    if let cached = composerCache[windowTitle] { return cached }
    let chatWindow = try window(named: windowTitle)
    let scrollAreas = children(of: chatWindow).filter { role(of: $0) == kAXScrollAreaRole as String }
    guard let inputArea = scrollAreas.last.flatMap({ descendants(of: $0, matching: kAXTextAreaRole as String).first }) else {
      throw BridgeError.message("KakaoTalk 입력창을 찾지 못했습니다.")
    }
    guard let sendButton = descendants(of: chatWindow, matching: kAXButtonRole as String).first(where: { title(of: $0) == "전송" }) else {
      throw BridgeError.message("KakaoTalk 전송 버튼을 찾지 못했습니다.")
    }
    let result = (input: inputArea, sendButton: sendButton)
    composerCache[windowTitle] = result
    return result
  }

  func prepareComposer(windowTitle: String) throws {
    _ = try composer(windowTitle: windowTitle)
  }

  private func waitUntilEnabled(_ button: AXUIElement, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if boolAttribute(button, kAXEnabledAttribute as CFString) { return true }
      usleep(20_000)
    } while Date() < deadline
    return false
  }

  private func notifyComposerOfInput(_ input: AXUIElement, text: String) throws {
    // AXValue updates the visible NSTextView contents, but KakaoTalk does not
    // always run its normal text-change handler. In that state the send button
    // stays disabled and AXPress misleadingly returns success without sending.
    // A targeted space/backspace pair makes KakaoTalk process a real keyboard
    // edit while leaving the requested text unchanged and without touching the
    // user's clipboard or bringing KakaoTalk to the foreground.
    try setAttribute(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    var selection = CFRange(location: text.utf16.count, length: 0)
    guard let selectionValue = AXValueCreate(.cfRange, &selection) else {
      throw BridgeError.message("KakaoTalk 입력 커서 위치를 만들지 못했습니다.")
    }
    try setAttribute(input, kAXSelectedTextRangeAttribute as CFString, selectionValue)

    let processIdentifier = try runningApplication.processIdentifier
    usleep(100_000)
    var space: [UniChar] = [32]
    for isKeyDown in [true, false] {
      guard let event = CGEvent(
        keyboardEventSource: nil,
        virtualKey: 49,
        keyDown: isKeyDown
      ) else { throw BridgeError.message("KakaoTalk 입력 이벤트를 만들지 못했습니다.") }
      event.keyboardSetUnicodeString(stringLength: space.count, unicodeString: &space)
      event.postToPid(processIdentifier)
    }
    usleep(100_000)
    for isKeyDown in [true, false] {
      guard let event = CGEvent(
        keyboardEventSource: nil,
        virtualKey: 51,
        keyDown: isKeyDown
      ) else { throw BridgeError.message("KakaoTalk 입력 이벤트를 만들지 못했습니다.") }
      event.postToPid(processIdentifier)
    }
    usleep(100_000)
    guard stringAttribute(input, kAXValueAttribute as CFString) == text else {
      throw BridgeError.message("KakaoTalk 입력 내용을 안전하게 준비하지 못했습니다.")
    }
  }

  func send(windowTitle: String, text: String) throws -> [String: Bool] {
    var controls = try composer(windowTitle: windowTitle)
    do {
      try setAttribute(controls.input, kAXValueAttribute as CFString, text as CFString)
    } catch {
      composerCache.removeValue(forKey: windowTitle)
      controls = try composer(windowTitle: windowTitle)
      try setAttribute(controls.input, kAXValueAttribute as CFString, text as CFString)
    }

    if !waitUntilEnabled(controls.sendButton, timeout: 0.15) {
      try notifyComposerOfInput(controls.input, text: text)
    }
    if !waitUntilEnabled(controls.sendButton, timeout: 0.6) {
      // A cached AX element can outlive a recreated KakaoTalk chat window.
      // Resolve the controls once more before deciding the button is unusable.
      composerCache.removeValue(forKey: windowTitle)
      controls = try composer(windowTitle: windowTitle)
    }
    guard stringAttribute(controls.input, kAXValueAttribute as CFString) == text else {
      throw BridgeError.message("KakaoTalk 입력창 내용이 전송할 메시지와 일치하지 않습니다.")
    }
    guard waitUntilEnabled(controls.sendButton, timeout: 0.25) else {
      throw BridgeError.message("KakaoTalk 전송 버튼이 활성화되지 않았습니다.")
    }

    let pressResult = AXUIElementPerformAction(controls.sendButton, kAXPressAction as CFString)

    // KakaoTalk clears the composer only after accepting the send action. This
    // is the authoritative confirmation. AXPress can report cannotComplete
    // even when KakaoTalk accepted the click and sent the message, so never
    // reject solely from the Accessibility return code.
    // KakaoTalk occasionally keeps the text in the composer for several
    // seconds while its network connection catches up. The send button has
    // already been pressed exactly once, so only wait here; never press it
    // again or a late acknowledgement could duplicate the message.
    let confirmationDeadline = Date().addingTimeInterval(8)
    repeat {
      let remaining = stringAttribute(controls.input, kAXValueAttribute as CFString) ?? ""
      if remaining.isEmpty { return ["confirmed": true] }
      usleep(50_000)
    } while Date() < confirmationDeadline
    if pressResult != .success {
      throw BridgeError.message(
        "KakaoTalk 전송 동작을 완료하지 못했습니다. (Accessibility \(pressResult.rawValue))"
      )
    }
    throw BridgeError.message("KakaoTalk에서 8초 안에 메시지 전송을 확인하지 못했습니다.")
  }

  private func postCommandV() {
    // Command+V. Unlike the text composer's per-character keystrokes, a paste
    // has to be delivered while KakaoTalk is frontmost, so it is posted to the
    // HID event tap rather than directly to the process.
    let vKey: CGKeyCode = 9
    for keyDown in [true, false] {
      guard let event = CGEvent(
        keyboardEventSource: CGEventSource(stateID: .combinedSessionState),
        virtualKey: vKey,
        keyDown: keyDown
      ) else { continue }
      event.flags = .maskCommand
      event.post(tap: .cghidEventTap)
    }
  }

  private func fileSendButton(in window: AXUIElement) -> AXUIElement? {
    // KakaoTalk's file-transfer dialog exposes a confirm button titled
    // "N개 전송" (for example "2개 전송"). The plain text-composer button is
    // titled "전송" and must not be matched here.
    descendants(of: window, matching: kAXButtonRole as String).first(where: {
      let name = title(of: $0)
      return name.range(of: #"^\d+개 전송$"#, options: .regularExpression) != nil
    })
  }

  func sendFile(windowTitle: String, paths: [String]) throws -> [String: Bool] {
    guard !paths.isEmpty else { throw BridgeError.message("전송할 파일이 없습니다.") }
    let urls = paths.map { URL(fileURLWithPath: $0) }
    for url in urls where !FileManager.default.fileExists(atPath: url.path) {
      throw BridgeError.message("파일을 찾을 수 없습니다: \(url.path)")
    }

    let chatWindow = try window(named: windowTitle)
    let scrollAreas = children(of: chatWindow).filter { role(of: $0) == kAXScrollAreaRole as String }
    guard let input = scrollAreas.last.flatMap({ descendants(of: $0, matching: kAXTextAreaRole as String).first }) else {
      throw BridgeError.message("KakaoTalk 입력창을 찾지 못했습니다.")
    }

    // Pasting is the only reliable way to attach a file through Accessibility, so
    // the file URLs go on the clipboard just long enough to paste. The user's
    // previous clipboard contents are captured here and restored on exit.
    let pasteboard = NSPasteboard.general
    let savedItems: [NSPasteboardItem] = (pasteboard.pasteboardItems ?? []).map { item in
      let copy = NSPasteboardItem()
      for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
      return copy
    }
    defer {
      pasteboard.clearContents()
      if !savedItems.isEmpty { pasteboard.writeObjects(savedItems) }
    }
    pasteboard.clearContents()
    guard pasteboard.writeObjects(urls.map { $0 as NSURL }) else {
      throw BridgeError.message("클립보드에 파일을 올리지 못했습니다.")
    }

    // The paste keystroke only reaches KakaoTalk while it is frontmost, and its
    // file-transfer dialog cancels itself once the app loses focus. So raise the
    // chat window, paste, confirm the transfer, then restore the prior app.
    let previousApplication = NSWorkspace.shared.frontmostApplication
    let application = try runningApplication
    _ = AXUIElementPerformAction(chatWindow, kAXRaiseAction as CFString)
    try? setAttribute(chatWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
    try? setAttribute(chatWindow, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    application.activate()
    usleep(300_000)
    try? setAttribute(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(150_000)
    postCommandV()

    let openDeadline = Date().addingTimeInterval(3)
    var confirmButton: AXUIElement?
    repeat {
      if let button = fileSendButton(in: chatWindow) { confirmButton = button; break }
      usleep(100_000)
    } while Date() < openDeadline

    guard let confirmButton else {
      if let cancel = descendants(of: chatWindow, matching: kAXButtonRole as String).first(where: { title(of: $0) == "취소" }) {
        _ = AXUIElementPerformAction(cancel, kAXPressAction as CFString)
      }
      if let previousApplication, previousApplication != application { previousApplication.activate() }
      throw BridgeError.message("KakaoTalk 파일 전송 창을 열지 못했습니다.")
    }

    _ = AXUIElementPerformAction(confirmButton, kAXPressAction as CFString)

    // The dialog closing is the authoritative confirmation. The composer text
    // field stays empty for a file send, so its value can never signal delivery.
    let confirmDeadline = Date().addingTimeInterval(8)
    var confirmed = false
    repeat {
      if fileSendButton(in: chatWindow) == nil { confirmed = true; break }
      usleep(100_000)
    } while Date() < confirmDeadline

    if let previousApplication, previousApplication != application { previousApplication.activate() }
    return ["confirmed": confirmed]
  }

  func scrollOlder(windowTitle: String) throws {
    let chatWindow = try window(named: windowTitle)
    guard let scrollArea = children(of: chatWindow).first(where: { role(of: $0) == kAXScrollAreaRole as String }),
          let scrollBar = children(of: scrollArea).first(where: { role(of: $0) == kAXScrollBarRole as String }) else {
      throw BridgeError.message("KakaoTalk 메시지 스크롤을 찾지 못했습니다.")
    }
    let current = (attribute(scrollBar, kAXValueAttribute as CFString) as? NSNumber)?.doubleValue ?? 1
    try setAttribute(scrollBar, kAXValueAttribute as CFString, NSNumber(value: max(0, current - 0.25)))
    usleep(250_000)
  }
}

func respond(id: Int, result: Any) {
  let response: [String: Any] = ["id": id, "ok": true, "result": result]
  if let data = try? JSONSerialization.data(withJSONObject: response), let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

func respond(id: Int, error: Error) {
  let response: [String: Any] = ["id": id, "ok": false, "error": String(describing: error)]
  if let data = try? JSONSerialization.data(withJSONObject: response), let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

let kakao = KakaoAccessibility()
while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let id = command["id"] as? Int,
        let action = command["action"] as? String else { continue }
  do {
    switch action {
    case "ping": respond(id: id, result: ["ready": true])
    case "ensureMain": try kakao.ensureMainWindow(); respond(id: id, result: [:])
    case "conversations": respond(id: id, result: try kakao.conversations(limit: command["limit"] as? Int ?? 10))
    case "prepareOpen": respond(id: id, result: try kakao.prepareOpen(row: command["row"] as? Int ?? 0, expectedTitle: command["title"] as? String ?? ""))
    case "doubleClick": try kakao.doubleClick(x: command["x"] as? Double ?? 0, y: command["y"] as? Double ?? 0); respond(id: id, result: [:])
    case "waitForWindow": try kakao.waitForWindow(expectedTitle: command["title"] as? String ?? ""); respond(id: id, result: [:])
    case "messages": respond(id: id, result: try kakao.messages(windowTitle: command["title"] as? String ?? "", direction: command["direction"] as? String ?? "newer", limit: command["limit"] as? Int ?? 15))
    case "prepareComposer": try kakao.prepareComposer(windowTitle: command["title"] as? String ?? ""); respond(id: id, result: [:])
    case "send": respond(id: id, result: try kakao.send(windowTitle: command["title"] as? String ?? "", text: command["text"] as? String ?? ""))
    case "sendFile":
      let filePaths = (command["paths"] as? [String]) ?? (command["path"] as? String).map { [$0] } ?? []
      respond(id: id, result: try kakao.sendFile(windowTitle: command["title"] as? String ?? "", paths: filePaths))
    case "scrollOlder": try kakao.scrollOlder(windowTitle: command["title"] as? String ?? ""); respond(id: id, result: [:])
    default: throw BridgeError.message("지원하지 않는 action입니다: \(action)")
    }
  } catch {
    respond(id: id, error: error)
  }
}
