use wasm_bindgen::prelude::*;
use sgp4::{Elements, Constants};

#[wasm_bindgen]
pub struct Simulator {
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

    pub fn init(&mut self, omm_json: &str) -> Result<(), JsValue> {
        let elements_list: Vec<Elements> = serde_json::from_str(omm_json).map_err(|e| e.to_string())?;
        let count = elements_list.len();
        self.satrecs = Vec::with_capacity(count);
        self.positions = vec![0.0; count * 3];
        self.velocities = vec![0.0; count * 3];
        self.valid_flags = vec![0; count];

        for el in elements_list {
            let epoch_ms = el.datetime.and_utc().timestamp_millis() as f64;
            match Constants::from_elements(&el) {
                Ok(constants) => self.satrecs.push(Some((constants, epoch_ms))),
                Err(_) => self.satrecs.push(None),
            }
        }
        Ok(())
    }

    pub fn propagate(&mut self, timestamp_ms: f64) {
        let earth_radius_km = 6371.0;
        
        for (i, satrec_opt) in self.satrecs.iter().enumerate() {
            let i3 = i * 3;
            if let Some((constants, epoch_ms)) = satrec_opt {
                let mins = (timestamp_ms - epoch_ms) / 60000.0;
                
                // Enforce maximum propagation window (60 days = 86400 mins) to prevent
                // deep-space resonance integrator from freezing the Wasm thread.
                if mins.abs() > 86400.0 {
                    self.valid_flags[i] = 0;
                    continue;
                }
                if let Ok(prediction) = constants.propagate(sgp4::MinutesSinceEpoch(mins)) {
                    self.positions[i3] = (prediction.position[0] / earth_radius_km) as f32;
                    self.positions[i3 + 1] = (prediction.position[1] / earth_radius_km) as f32;
                    self.positions[i3 + 2] = (prediction.position[2] / earth_radius_km) as f32;
                    
                    self.velocities[i3] = (prediction.velocity[0] / earth_radius_km) as f32;
                    self.velocities[i3 + 1] = (prediction.velocity[1] / earth_radius_km) as f32;
                    self.velocities[i3 + 2] = (prediction.velocity[2] / earth_radius_km) as f32;
                    
                    self.valid_flags[i] = 1;
                    continue;
                }
            }
            
            // Invalid or propagation failed
            self.positions[i3] = 0.0;
            self.positions[i3 + 1] = 0.0;
            self.positions[i3 + 2] = 0.0;
            self.velocities[i3] = 0.0;
            self.velocities[i3 + 1] = 0.0;
            self.velocities[i3 + 2] = 0.0;
            self.valid_flags[i] = 0;
        }
    }

    pub fn positions_ptr(&self) -> *const f32 {
        self.positions.as_ptr()
    }

    pub fn velocities_ptr(&self) -> *const f32 {
        self.velocities.as_ptr()
    }

    pub fn valid_flags_ptr(&self) -> *const u8 {
        self.valid_flags.as_ptr()
    }
}
