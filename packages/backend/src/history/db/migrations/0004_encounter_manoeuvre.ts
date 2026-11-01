// ============================================================
// Migration 0004 — recent-manoeuvre time on encounters.
//
// manoeuvre_a / manoeuvre_b: for the conjunction's two objects (norad_a < norad_b), the time (t_end, the epoch of the new element
// set) of the object's latest elements.jump in the 7 days before the run that last reported the encounter; NULL when there was none.
// An observed orbit change, as opposed to `manoeuvrable`, which only says the object belongs to a constellation that manoeuvres
// routinely. Not added to conjunction_update: the flag describes the object's recent history, not the prediction, and each run's
// value can be recovered from ssa_event; the conjunction row carries the latest.
// ============================================================

export const sql = `
ALTER TABLE conjunction ADD COLUMN IF NOT EXISTS manoeuvre_a TIMESTAMPTZ NULL;
ALTER TABLE conjunction ADD COLUMN IF NOT EXISTS manoeuvre_b TIMESTAMPTZ NULL;
`;

export const name = '0004_encounter_manoeuvre';
