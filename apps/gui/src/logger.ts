// Project loggers, frontend side: the element's defaults, the
// defensive load-time coercion, and the payload the host is pushed.
//
// A logger writes the live capture to file for as long as it is
// enabled and something is connected. The host owns the writing (and
// the template resolution behind the panel's preview); this module
// holds only what a project element needs in order to be one.

import type { ProjectElement } from "./types";

export type LoggerElement = Extract<ProjectElement, { kind: "logger" }>;

/// The folder a freshly created logger writes to: a `logs` directory,
/// one subdirectory per logger. Relative, so it lands under the project
/// directory. Written with `/` — a template travels with the project,
/// and the host renders whichever separator the OS it opens on uses.
export const DEFAULT_LOGGER_FOLDER = "logs/{logger}";

/// The file a freshly created logger writes: the capture's wall-clock
/// start, which for a live session is when the session began.
export const DEFAULT_LOGGER_FILE = "{start}";

/// The size a freshly created logger splits at, megabytes.
export const DEFAULT_LOGGER_MAX_MB = 500;

/// The file extension live logging writes. BLF is the only live
/// format; export offers both.
export const LOGGER_EXTENSION = ".blf";

/// Host event carrying every logger's status — fired when one starts,
/// stops, or fails. Must match `logger::LOGGERS_CHANGED_EVENT`.
export const LOGGERS_CHANGED_EVENT = "loggers-changed";

/// The logger fields of a value fresh from a project file, coerced so
/// the panel can rely on them. Anything missing or malformed reads as
/// the default rather than poisoning the panel — the same tolerance
/// every other element kind's loader applies.
///
/// `enabled` defaults to **false**: a field that failed to parse is not
/// evidence that the user asked for logging.
export function normalizeLoggerFields(v: unknown): Omit<LoggerElement, "kind" | "id" | "name"> {
  const o = (v ?? {}) as {
    enabled?: unknown;
    folder?: unknown;
    file?: unknown;
    maxFileSizeMb?: unknown;
  };
  const max = typeof o.maxFileSizeMb === "number" && Number.isFinite(o.maxFileSizeMb)
    ? Math.max(1, Math.floor(o.maxFileSizeMb))
    : DEFAULT_LOGGER_MAX_MB;
  return {
    enabled: o.enabled === true,
    folder: typeof o.folder === "string" ? o.folder : DEFAULT_LOGGER_FOLDER,
    file: typeof o.file === "string" ? o.file : DEFAULT_LOGGER_FILE,
    // Live logging is BLF, so the field has one value; it is persisted
    // because the project records what the Format control says.
    format: "blf",
    maxFileSizeMb: max,
  };
}

/// What the preview reads once the host has resolved the File template:
/// the resolved text with the format's extension. The separators are
/// the host's — it renders a template in the running OS's own — so the
/// preview passes them through rather than picking one here, where the
/// platform is not known.
export function loggerPreviewName(resolvedFile: string): string {
  return `${resolvedFile}${LOGGER_EXTENSION}`;
}

/// The host's `set_loggers` payload for a project's elements: every
/// logger, in element order, with nothing the host does not read.
export function loggerConfigs(
  elements: readonly ProjectElement[],
): readonly {
  id: string;
  name: string;
  enabled: boolean;
  folder: string;
  file: string;
  maxFileSizeMb: number;
}[] {
  return elements
    .filter((el): el is LoggerElement => el.kind === "logger")
    .map((el) => ({
      id: el.id,
      // `{logger}` resolves against the display name, so a logger with
      // no name yet resolves against nothing rather than "undefined".
      name: el.name ?? "",
      enabled: el.enabled,
      folder: el.folder,
      file: el.file,
      maxFileSizeMb: el.maxFileSizeMb,
    }));
}
