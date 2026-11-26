/**
 * The complete default settings payload, grouped by section.
 *
 * Values mirror the Python oracle defaults defined in
 * `servermanage/models.py` (dataclass defaults) and loaded by
 * `servermanage/config.py`. They are derived from {@link SETTINGS_SCHEMA} so
 * there is a single source of truth and the two can never drift.
 */
import { defaultSection, SECTION_NAMES, SETTINGS_SCHEMA } from './schema';

export { SECTION_NAMES, defaultSection, SETTINGS_SCHEMA };

/** Defaults for every configurable section, keyed by section name. */
export const DEFAULT_SETTINGS: Record<string, Record<string, unknown>> = Object.fromEntries(
  SECTION_NAMES.map((name) => [name, defaultSection(name)]),
);
