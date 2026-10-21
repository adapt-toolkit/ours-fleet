export interface FileDeliveryBinding { sessionGeneration: string; acpSessionId: string; turnId: string }
export interface DeliveredFile extends FileDeliveryBinding { id: string; name: string; mimeType: string; size: number; sha256: string }
export interface FileDeliveryInput { path: string; filename?: string; mime?: string }
export type CopyChatFile = (binding: FileDeliveryBinding) => Promise<DeliveredFile>;
export type SendChatFile = (input: FileDeliveryInput, signal: AbortSignal, copy: CopyChatFile) => Promise<DeliveredFile>;
