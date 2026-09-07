export type ConnectionState =
  | "starting"
  | "login-required"
  | "connected"
  | "disconnected"
  | "error";

export interface Conversation {
  id: string;
  provider?: string;
  identity?: string;
  title: string;
  href: string;
  preview?: string;
  unread: boolean;
}

export type MessageKind =
  | "text"
  | "image"
  | "video"
  | "reel"
  | "post"
  | "sticker"
  | "reaction"
  | "reply"
  | "deleted"
  | "system";

export interface MessageReference {
  sender?: string;
  text?: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  kind: MessageKind;
  text: string;
  sender: string;
  senderInferred?: boolean;
  timestamp?: string;
  edited?: boolean;
  replyTo?: MessageReference;
  /** Position in the native image window, including messages outside the UI cache. */
  previewIndex?: number;
  previewImageCount?: number;
}

export type ImagePreviewSelector = "latest" | number;
export type ImagePreviewResult =
  | { path: string; width: number; height: number }
  | { unavailable: string };

export interface ChatSnapshot {
  state: ConnectionState;
  conversations: Conversation[];
  activeConversationId?: string;
  messages: ChatMessage[];
  detail?: string;
  connectors?: ConnectorStatus[];
}

export interface ConnectorStatus {
  id: string;
  label: string;
  state: ConnectionState;
  detail?: string;
}

export interface ConnectorEvents {
  snapshot: [snapshot: ChatSnapshot];
  error: [error: Error];
}

export interface ChatConnector {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSnapshot(): ChatSnapshot;
  refresh(): Promise<void>;
  loadMoreConversations(provider?: string): Promise<number>;
  loadOlderMessages(): Promise<number>;
  openConversation(id: string): Promise<void>;
  sendMessage(text: string): Promise<void>;
  sendFile?(paths: string[]): Promise<void>;
  /** The caller must delete a returned temporary PNG after consuming it. */
  previewImage?(selector: ImagePreviewSelector): Promise<ImagePreviewResult>;
  on<K extends keyof ConnectorEvents>(
    event: K,
    listener: (...args: ConnectorEvents[K]) => void,
  ): this;
  off<K extends keyof ConnectorEvents>(
    event: K,
    listener: (...args: ConnectorEvents[K]) => void,
  ): this;
}
