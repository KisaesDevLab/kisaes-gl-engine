-- Fix: payroll_check_register_rows.amount must use decimal(19,4) per project convention
ALTER TABLE "payroll_check_register_rows" ALTER COLUMN "amount" TYPE numeric(19,4);
