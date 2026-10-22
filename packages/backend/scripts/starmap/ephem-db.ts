// SPIKE — not production. Shared DB constants for build-ephem / bench-ephem.
export const DB_URL = 'postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch';

export const DDL = `
CREATE TABLE IF NOT EXISTS starmap.ephem_day (
  norad_id int NOT NULL, day date NOT NULL, frame text NOT NULL DEFAULT 'TEME',
  elset_epoch timestamptz, tol_km real, line bytea NOT NULL, PRIMARY KEY (day, norad_id));
CREATE TABLE IF NOT EXISTS starmap.elset_day (
  norad_id int NOT NULL, day date NOT NULL, omm jsonb NOT NULL, PRIMARY KEY (day, norad_id));`;

