import { ChatMessage } from '../services/assistant.service';
export declare const assistantRouter: import("express-serve-static-core").Router;
export declare function stripUiMarkers(text: string): string;
export declare function sanitizeMessages(raw: unknown): ChatMessage[];
