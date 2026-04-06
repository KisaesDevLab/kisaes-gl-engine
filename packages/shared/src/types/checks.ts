export type PrintStatus = 'queue' | 'printed' | 'hand_written';

export interface WriteCheckInput {
  bankAccountId: string;
  contactId?: string;
  payeeNameOnCheck: string;
  payeeAddress?: string;
  txnDate: string;
  amount: string;
  printedMemo?: string;
  memo?: string;
  printLater: boolean;
  lines: Array<{
    accountId: string;
    description?: string;
    amount: string;
  }>;
  tagIds?: string[];
}

export interface PrintCheckInput {
  bankAccountId: string;
  checkIds: string[];
  startingCheckNumber: number;
  format: 'voucher' | 'check_middle';
}

export interface CheckSettings {
  format: 'voucher' | 'check_middle';
  bankName: string;
  bankAddress: string;
  routingNumber: string;
  accountNumber: string;
  fractionalRouting: string;
  printOnBlankStock: boolean;
  printCompanyInfo: boolean;
  printSignatureLine: boolean;
  printDateLine: boolean;
  printPayeeLine: boolean;
  printAmountBox: boolean;
  printAmountWords: boolean;
  printMemoLine: boolean;
  printBankInfo: boolean;
  printMicrLine: boolean;
  printCheckNumber: boolean;
  printVoucherStub: boolean;
  alignmentOffsetX: number;
  alignmentOffsetY: number;
  nextCheckNumber: number;
  defaultBankAccountId: string | null;
}

export interface PrintBatchResult {
  batchId: string;
  checksPrinted: number;
  checkNumberRange: string;
}
