import { describe, it, expect } from 'vitest';
import {
  sanitize,
  detectPiiTypes,
  sanitizeStatementHeader,
  sanitizeTransactionDescription,
  pickMode,
} from './pii-sanitizer.service.js';

describe('pii-sanitizer', () => {
  describe('SSN', () => {
    it('masks XXX-XX-XXXX format in strict mode', () => {
      const { text, detected } = sanitize('SSN 123-45-6789 on file', 'strict');
      expect(text).toContain('[SSN_REDACTED]');
      expect(text).not.toContain('123-45-6789');
      expect(detected).toContain('ssn');
    });
    it('masks SSN even in minimal mode (always dangerous)', () => {
      const { text } = sanitize('Employee 123-45-6789 paid', 'minimal');
      expect(text).toContain('[SSN_REDACTED]');
    });
  });

  describe('EIN', () => {
    it('masks XX-XXXXXXX format', () => {
      const { text, detected } = sanitize('EIN 12-3456789', 'minimal');
      expect(text).toContain('[EIN_REDACTED]');
      expect(detected).toContain('ein');
    });
  });

  describe('credit card', () => {
    it('masks a valid 16-digit Visa-shaped number', () => {
      const { text, detected } = sanitize('Card 4111 1111 1111 1111 on receipt', 'standard');
      expect(text).toContain('[CARD_REDACTED]');
      expect(text).not.toContain('4111');
      expect(detected).toContain('credit_card');
    });
    it('leaves non-Luhn-passing long digit runs alone', () => {
      // Order ID — 16 digits but fails Luhn.
      const { text, detected } = sanitize('Order 1234567890123456', 'standard');
      expect(text).toContain('1234567890123456');
      expect(detected).not.toContain('credit_card');
    });
    it('preserves "ending in 4567" card last-4 as a canonical token', () => {
      const { text } = sanitize('Charged to card ending in 4567', 'standard');
      expect(text).toContain('[CARD_ENDING_4567]');
      // Original phrasing is gone.
      expect(text).not.toMatch(/ending\s+in\s+4567/i);
    });
  });

  describe('bank account / routing (contextual)', () => {
    it('masks an account number only when preceded by "account" keyword', () => {
      const { text, detected } = sanitize('Account: 123456789012', 'standard');
      expect(text).toContain('[ACCT_REDACTED]');
      expect(detected).toContain('bank_account');
    });
    it('does NOT mask bare 12-digit numbers without context', () => {
      // Arbitrary transaction reference number — no "account" nearby.
      const { text, detected } = sanitize('REF 987654321098 posted', 'standard');
      expect(text).toContain('987654321098');
      expect(detected).not.toContain('bank_account');
    });
    it('masks routing number with ABA keyword', () => {
      const { text, detected } = sanitize('Routing: 091000019', 'standard');
      expect(text).toContain('[ROUTING_REDACTED]');
      expect(detected).toContain('routing');
    });
  });

  describe('payment-app personal names', () => {
    it('redacts names after VENMO', () => {
      const { text, detected } = sanitize('VENMO PAYMENT JOHN SMITH $50', 'minimal');
      expect(text).toContain('[NAME_REDACTED]');
      expect(text).toContain('$50');
      expect(text).not.toContain('JOHN SMITH');
      expect(detected).toContain('payment_app_name');
    });
    it('redacts names after ZELLE', () => {
      const { text } = sanitize('ZELLE TO JANE DOE', 'minimal');
      expect(text).toContain('[NAME_REDACTED]');
      expect(text).not.toContain('JANE DOE');
    });
    it('redacts names after CASH APP', () => {
      const { text } = sanitize('CASH APP PAYMENT ALICE WONDERLAND', 'minimal');
      expect(text).toContain('[NAME_REDACTED]');
      expect(text).not.toContain('ALICE');
    });
  });

  describe('merchant / amount / date preservation', () => {
    it('preserves merchant names in categorization-style text', () => {
      const { text } = sanitize('AMZN MKTP US*2K1AB3CD0 $24.99', 'minimal');
      expect(text).toContain('AMZN MKTP US');
      expect(text).toContain('$24.99');
    });
    it('preserves common date formats', () => {
      const { text } = sanitize('Posted 03/15/2026 to account', 'standard');
      expect(text).toContain('03/15/2026');
    });
  });

  describe('phone / email', () => {
    it('masks US phone shape in standard+', () => {
      const { text, detected } = sanitize('Call (555) 123-4567 for support', 'standard');
      expect(text).toContain('[PHONE_REDACTED]');
      expect(detected).toContain('phone');
    });
    it('masks email in standard+', () => {
      const { text, detected } = sanitize('Contact john@example.com', 'standard');
      expect(text).toContain('[EMAIL_REDACTED]');
      expect(detected).toContain('email');
    });
    it('leaves phone alone in minimal mode', () => {
      const { text } = sanitize('Call (555) 123-4567', 'minimal');
      expect(text).toContain('(555) 123-4567');
    });
  });

  describe('mailing address (strict only)', () => {
    it('masks a multi-line US address in strict mode', () => {
      const input = 'Send to 123 Main St\nSpringfield, MO 65801';
      const { text, detected } = sanitize(input, 'strict');
      expect(text).toContain('[ADDRESS_REDACTED]');
      expect(detected).toContain('address');
    });
    it('does NOT mask addresses in standard mode', () => {
      const input = '123 Main St, Springfield, MO 65801';
      const { text, detected } = sanitize(input, 'standard');
      expect(text).toContain('Main St');
      expect(detected).not.toContain('address');
    });
  });

  describe('mode gradient', () => {
    const text = 'VENMO PAYMENT JOHN SMITH $50 account 123456789012 card 4111-1111-1111-1111 email x@y.com 123 Main St Springfield MO 65801';

    it('none = pass-through', () => {
      expect(sanitize(text, 'none').text).toBe(text);
    });
    it('minimal < standard < strict for redaction count', () => {
      const minCount = sanitize(text, 'minimal').detected.length;
      const stdCount = sanitize(text, 'standard').detected.length;
      const strictCount = sanitize(text, 'strict').detected.length;
      expect(minCount).toBeLessThanOrEqual(stdCount);
      expect(stdCount).toBeLessThanOrEqual(strictCount);
    });
  });

  describe('null / empty inputs', () => {
    it('handles null', () => {
      expect(sanitize(null, 'strict').text).toBe('');
    });
    it('handles undefined', () => {
      expect(sanitize(undefined, 'strict').text).toBe('');
    });
    it('handles empty string', () => {
      expect(sanitize('', 'strict').text).toBe('');
    });
  });

  describe('detectPiiTypes', () => {
    it('reports all types present without mutating state', () => {
      const types = detectPiiTypes('SSN 123-45-6789 and card 4111-1111-1111-1111');
      expect(types).toContain('ssn');
      expect(types).toContain('credit_card');
    });
  });

  describe('specialized helpers', () => {
    it('sanitizeStatementHeader uses strict mode', () => {
      const { text } = sanitizeStatementHeader('John Smith\n123 Main St\nSpringfield MO 65801\nAccount: 12345678');
      expect(text).toContain('[ADDRESS_REDACTED]');
      expect(text).toContain('[ACCT_REDACTED]');
    });
    it('sanitizeTransactionDescription uses minimal mode (preserves merchant + amount)', () => {
      const { text } = sanitizeTransactionDescription('STARBUCKS #4567 SEATTLE WA $6.50');
      expect(text).toContain('STARBUCKS');
      expect(text).toContain('$6.50');
    });
  });

  describe('regex performance safety', () => {
    it('address regex does not catastrophically backtrack on adversarial input', () => {
      const adversarial = '123 ' + 'Word '.repeat(200) + 'not a real address';
      const start = performance.now();
      sanitize(adversarial, 'strict');
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100);
    });

    it('handles very long input without excessive latency', () => {
      const longInput = 'VENMO PAYMENT JOHN SMITH $50 '.repeat(500);
      const start = performance.now();
      const { text } = sanitize(longInput, 'strict');
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
      expect(text).toContain('[NAME_REDACTED]');
    });
  });

  describe('pickMode', () => {
    it('self-hosted providers bypass sanitization', () => {
      expect(pickMode('ollama', 'ocr_statement')).toBe('none');
      expect(pickMode('glm_ocr_local', 'ocr_receipt')).toBe('none');
    });
    it('cloud statement = strict', () => {
      expect(pickMode('anthropic', 'ocr_statement')).toBe('strict');
    });
    it('cloud receipt / invoice = standard', () => {
      expect(pickMode('openai', 'ocr_receipt')).toBe('standard');
      expect(pickMode('openai', 'ocr_invoice')).toBe('standard');
    });
    it('cloud categorization / classification = minimal', () => {
      expect(pickMode('anthropic', 'categorize')).toBe('minimal');
      expect(pickMode('gemini', 'classify_document')).toBe('minimal');
    });
  });
});
