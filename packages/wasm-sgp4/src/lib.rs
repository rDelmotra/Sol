// ============================================================
// wasm-sgp4 — batch SGP4 propagation for the frontend worker.
//
// Replaces the satellite.js per-object loop in sgp4.worker.ts with one
// Rust/WASM call per tick. Contract (must stay in lockstep with the worker):
//   - init(ommJson): OMM array (same JSON served by /api/tle/all; EPOCH must
//     have no trailing 'Z' — chrono::NaiveDateTime rejects it; the worker
//     strips it). PER-OBJECT parse: a record that fails to parse, or whose
//     elements are rejected by SGP4 initialization, becomes a permanently-
//     invalid slot (flag 0). One bad elset must never take down the catalog —
//     parity with the old per-object try/catch around json2satrec.
//   - propagate(tMs, maxTsinceMin): TEME frame, km scaled by 1/6371 — SAME
//     units as the old worker (positions in earth-radii, velocities in
//     km/s / 6371), so downstream consumers (SatelliteRenderer, live-source)
//     are unchanged.
//   - maxTsinceMin mirrors @orbitwatch/orbital-core's propagation-window.ts
//     (MAX_PROPAGATION_DAYS / tsinceMinutes) and is passed in from JS so the window policy keeps ONE
//     home. Deep-space resonant orbits (GEO/GPS/Molniya) integrate from epoch
//     in fixed steps — cost grows with |tsince| — the cap is what makes a far
//     time-scrub unable to wedge the worker. NaN-safe: a non-finite timestamp
//     (Invalid Date upstream) is rejected by the same check.
//   - Invalid slots are ZEROED every tick (not just flagged) — parity with
//     the old markInvalid(), so a consumer that misses the flag reads the
//     origin, not a stale position.
// ============================================================

use sgp4::{Constants, Elements, MinutesSinceEpoch};
use wasm_bindgen::prelude::*;

// Scene/wire LENGTH UNIT (1 ER = 6371 km) — NOT the Earth's shape. Same value as
// orbital-core units.ts ER_KM. The Earth figure (WGS84) lives in orbital-core earth.ts.
const ER_KM: f64 = 6371.0;

#[wasm_bindgen]
pub struct Simulator {
    /// (initialized SGP4 constants, elset epoch in Unix ms) per object;
    /// None = bad elset, permanently invalid.
    satrecs: Vec<Option<(Constants, f64)>>,
    positions: Vec<f32>,
    velocities: Vec<f32>,
    valid_flags: Vec<u8>,
}

#[wasm_bindgen]
impl Simulator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            satrecs: Vec::new(),
            positions: Vec::new(),
            velocities: Vec::new(),
            valid_flags: Vec::new(),
        }
    }

    /// Parse an OMM JSON ARRAY and initialize one SGP4 slot per record.
    /// Errors only if the top-level array itself is malformed (a protocol
    /// bug, not a data problem). Returns the count of valid slots.
    pub fn init(&mut self, omm_json: &str) -> Result<u32, JsValue> {
        let records: Vec<serde_json::Value> =
            serde_json::from_str(omm_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let count = records.len();
        self.satrecs = Vec::with_capacity(count);
        self.positions = vec![0.0; count * 3];
        self.velocities = vec![0.0; count * 3];
        self.valid_flags = vec![0; count];

        let mut ok: u32 = 0;
        for record in records {
            let slot = serde_json::from_value::<Elements>(record)
                .ok()
                .and_then(|el| {
                    let epoch_ms = el.datetime.and_utc().timestamp_millis() as f64;
                    Constants::from_elements(&el).ok().map(|c| (c, epoch_ms))
                });
            if slot.is_some() {
                ok += 1;
            }
            self.satrecs.push(slot);
        }
        Ok(ok)
    }

    /// Propagate every object to `timestamp_ms` (Unix ms). Objects farther
    /// than `max_tsince_min` minutes from their elset epoch — or a non-finite
    /// timestamp — are marked invalid without propagating (see header).
    pub fn propagate(&mut self, timestamp_ms: f64, max_tsince_min: f64) {
        for (i, slot) in self.satrecs.iter().enumerate() {
            let i3 = i * 3;
            let mut ok = false;

            if let Some((constants, epoch_ms)) = slot {
                let mins = (timestamp_ms - epoch_ms) / 60_000.0;
                // is_finite() first: NaN comparisons are all false, so a bare
                // `mins.abs() > cap` check would PASS a NaN straight into SGP4.
                if mins.is_finite() && mins.abs() <= max_tsince_min {
                    if let Ok(p) = constants.propagate(MinutesSinceEpoch(mins)) {
                        let finite = p
                            .position
                            .iter()
                            .chain(p.velocity.iter())
                            .all(|v| v.is_finite());
                        if finite {
                            self.positions[i3] = (p.position[0] / ER_KM) as f32;
                            self.positions[i3 + 1] = (p.position[1] / ER_KM) as f32;
                            self.positions[i3 + 2] = (p.position[2] / ER_KM) as f32;
                            self.velocities[i3] = (p.velocity[0] / ER_KM) as f32;
                            self.velocities[i3 + 1] = (p.velocity[1] / ER_KM) as f32;
                            self.velocities[i3 + 2] = (p.velocity[2] / ER_KM) as f32;
                            ok = true;
                        }
                    }
                }
            }

            if ok {
                self.valid_flags[i] = 1;
            } else {
                self.positions[i3] = 0.0;
                self.positions[i3 + 1] = 0.0;
                self.positions[i3 + 2] = 0.0;
                self.velocities[i3] = 0.0;
                self.velocities[i3 + 1] = 0.0;
                self.velocities[i3 + 2] = 0.0;
                self.valid_flags[i] = 0;
            }
        }
    }

    /// Raw pointers into WASM linear memory — the worker wraps them with
    /// typed-array views EACH tick (memory may grow and detach old views).
    pub fn positions_ptr(&self) -> *const f32 {
        self.positions.as_ptr()
    }

    pub fn velocities_ptr(&self) -> *const f32 {
        self.velocities.as_ptr()
    }

    pub fn valid_flags_ptr(&self) -> *const u8 {
        self.valid_flags.as_ptr()
    }

    pub fn object_count(&self) -> u32 {
        self.satrecs.len() as u32
    }
}

impl Default for Simulator {
    fn default() -> Self {
        Self::new()
    }
}
