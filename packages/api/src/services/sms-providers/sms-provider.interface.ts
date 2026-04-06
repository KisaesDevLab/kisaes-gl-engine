export interface SendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  name: string;
  sendCode(phoneNumber: string, code: string, appName: string): Promise<SendResult>;
  testConnection(): Promise<boolean>;
}
