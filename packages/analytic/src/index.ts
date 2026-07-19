// @orbitwatch/analytic — the pure Analytic IR v1 core (no runtime deps, no I/O).
// Contract docs: my_plans/marvin/perceptor_ir_v1.md + perceptor_analytic_schema.md.
// Consumed by frontend (live executor) and backend (prompt gen + validate repair loop).
export * from './types.js';
export * from './schema.js';
export * from './validate.js';
export * from './execute.js';
export * from './capability.js';
