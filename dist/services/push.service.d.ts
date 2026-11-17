interface PushPayload {
    title: string;
    body: string;
    data?: Record<string, string>;
}
export declare function sendPush(phone: string, payload: PushPayload, onlyNotification?: boolean): Promise<void>;
export {};
