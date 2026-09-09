import { fileURLToPath } from 'node:url'

/** Absolute path to the directory holding the numbered .sql migration pairs. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

/** Absolute path to the directory holding seed data. */
export const SEED_DIR = fileURLToPath(new URL('../seed/', import.meta.url))
