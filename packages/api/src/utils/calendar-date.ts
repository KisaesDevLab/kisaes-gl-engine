// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Calendar-date arithmetic on YYYY-MM-DD strings (U-86). The helper lives in
 * @kis-books/shared so the engine and the web forms compute due dates the
 * same way (review L2); re-exported here for the engine's callers.
 */
export { isCalendarDate, addCalendarDays } from '@kis-books/shared';
