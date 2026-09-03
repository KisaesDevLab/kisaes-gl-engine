-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Release the suspense role. The accounts themselves and every line posted to
-- them are left exactly as they are -- only the role marking is undone, so
-- rolling back never moves money.

UPDATE accounts
SET system_tag = NULL,
    is_system  = FALSE,
    updated_at = now()
WHERE system_tag = 'suspense';
