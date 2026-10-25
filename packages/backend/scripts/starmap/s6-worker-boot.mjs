// SPIKE — not production. Worker bootstrap (tsx loader inside the worker thread).
import { register } from "tsx/esm/api";
register();
await import("./s6-worker.ts");
