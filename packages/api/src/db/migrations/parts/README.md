Per-phase SQL parts for the single consolidated migration 0201_tax_estimator.sql
(MODULE.md D6). Each parallel worker writes only its own part file, applies it by hand to
the TEST database for its tests, and the orchestrator assembles the parts into 0201
(in phase order) and verifies the assembled file on a fresh scratch database.
