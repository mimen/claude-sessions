import { join } from "node:path";

process.env.CCS_MODEL_REGISTRY_PATH ??= join(import.meta.dir, "models", "fixtures", "models.toml");
