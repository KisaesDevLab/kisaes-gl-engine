import { z } from 'zod';

export const writeCheckSchema = z.object({
  bankAccountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  payeeNameOnCheck: z.string().min(1).max(255),
  payeeAddress: z.string().optional(),
  txnDate: z.string().min(1),
  amount: z.string().min(1),
  printedMemo: z.string().max(255).optional(),
  memo: z.string().optional(),
  printLater: z.boolean().default(false),
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    description: z.string().optional(),
    amount: z.string().min(1),
  })).min(1),
  tagIds: z.array(z.string().uuid()).optional(),
});

export const printCheckSchema = z.object({
  bankAccountId: z.string().uuid(),
  checkIds: z.array(z.string().uuid()).min(1),
  startingCheckNumber: z.number().int().min(1),
  format: z.enum(['voucher', 'check_middle']),
});

export const checkSettingsSchema = z.object({
  format: z.enum(['voucher', 'check_middle']).optional(),
  bankName: z.string().optional(),
  bankAddress: z.string().optional(),
  routingNumber: z.string().max(9).optional(),
  accountNumber: z.string().optional(),
  fractionalRouting: z.string().optional(),
  printOnBlankStock: z.boolean().optional(),
  printCompanyInfo: z.boolean().optional(),
  printSignatureLine: z.boolean().optional(),
  printDateLine: z.boolean().optional(),
  printPayeeLine: z.boolean().optional(),
  printAmountBox: z.boolean().optional(),
  printAmountWords: z.boolean().optional(),
  printMemoLine: z.boolean().optional(),
  printBankInfo: z.boolean().optional(),
  printMicrLine: z.boolean().optional(),
  printCheckNumber: z.boolean().optional(),
  printVoucherStub: z.boolean().optional(),
  alignmentOffsetX: z.number().optional(),
  alignmentOffsetY: z.number().optional(),
  nextCheckNumber: z.number().int().min(1).optional(),
  defaultBankAccountId: z.string().uuid().nullish(),
});
