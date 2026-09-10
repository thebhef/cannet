// The project logger's panel: where a logger is pointed at a folder and
// a file, and switched on.
//
// It is the export dialog's controls, standing still. The same templates
// resolve through the same host command (`preview_export_template`), so
// the tokens and their strftime formats stay the model's, and the
// preview and the resolved folder are both the host's answers rather
// than anything derived here.
//
// The panel does not start or stop the writing. It edits the element;
// the host reconciles — a logger writes exactly while it is enabled and
// something is connected — so the switch is a project fact, not a
// command. That is also why the enabled flag survives a save: logging
// writes locally and transmits nothing.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { useConnectionStates } from "./connectionStates";
import { LOGGERS_CHANGED_EVENT, loggerPreviewName, type LoggerElement } from "./logger";
import { useElementPanel } from "./useElementPanel";
import { useHostMirror } from "./useHostMirror";
import { projectName } from "./windowTitle";
import { useProjectContext } from "./projectContext";
import { TemplateTokenHelp } from "./templateTokenHelp";

/// The host's answer for one template.
interface TemplatePreview {
  resolved: string | null;
  error: string | null;
  startResolvedAsNow: boolean;
}

/// One logger's host-side status, as `get_logger_statuses` reports it.
interface LoggerStatus {
  id: string;
  writing: boolean;
  path: string | null;
  bytes: number;
  frameCount: number;
  error: string | null;
}

const NO_PREVIEW: TemplatePreview = { resolved: null, error: null, startResolvedAsNow: false };

/// Module-level so the host mirror's fallback identity never changes.
const NO_STATUSES: readonly LoggerStatus[] = [];

export function LoggerPanel(props: IDockviewPanelProps) {
  const { elementId, registry, element } = useElementPanel(props, "logger");
  const { update } = registry;
  const { projectPath } = useProjectContext();
  const connectionStates = useConnectionStates();
  const connected = useMemo(
    () => Object.values(connectionStates).some((s) => s.kind === "connected"),
    [connectionStates],
  );

  const logger: LoggerElement | null =
    element && element.kind === "logger" ? element : null;
  const name = logger?.name ?? "";
  const project = projectName(projectPath) ?? "capture";

  // The capture's wall-clock start, for `{start}`. Re-read whenever a
  // bus's connection state moves, which is when a live session begins.
  const [startSeconds, setStartSeconds] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void invoke<{ sessionStartNs: number | null }>("capture_extent")
      .then((extent) => {
        if (live) {
          setStartSeconds(
            extent.sessionStartNs == null ? null : extent.sessionStartNs / 1e9,
          );
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connectionStates]);

  // Whether the host has this logger's file open. Everything that
  // cannot change part-way through a file is locked on it. The host
  // mirror is the shared pattern: one snapshot, re-read on the host's
  // own change event.
  const fetchStatuses = useCallback(
    () => invoke<LoggerStatus[]>("get_logger_statuses").then((all) => all ?? NO_STATUSES),
    [],
  );
  const statuses = useHostMirror<readonly LoggerStatus[], LoggerStatus[]>({
    fetch: fetchStatuses,
    fallback: NO_STATUSES,
    event: LOGGERS_CHANGED_EVENT,
    fromPayload: (payload) => payload ?? NO_STATUSES,
  }).value;
  const status = statuses.find((s) => s.id === elementId) ?? null;
  const writing = status?.writing === true;

  const folder = logger?.folder ?? "";
  const file = logger?.file ?? "";

  // Both previews are the host's, re-asked whenever a template, the
  // logger's name, or the capture's start changes.
  const [folderPreview, setFolderPreview] = useState<TemplatePreview>(NO_PREVIEW);
  const [filePreview, setFilePreview] = useState<TemplatePreview>(NO_PREVIEW);
  useEffect(() => {
    let live = true;
    const ask = (template: string, isFolder: boolean) =>
      invoke<TemplatePreview>("preview_export_template", {
        template,
        project,
        logger: name,
        startSeconds,
        isFolder,
      }).catch(() => NO_PREVIEW);
    void Promise.all([ask(folder, true), ask(file, false)]).then(([f, n]) => {
      if (!live) return;
      setFolderPreview(f);
      setFilePreview(n);
    });
    return () => {
      live = false;
    };
  }, [folder, file, project, name, startSeconds]);

  const patch = useCallback(
    (fields: Partial<LoggerElement>) => update(elementId, { kind: "logger", ...fields }),
    [update, elementId],
  );

  const browse = useCallback(() => {
    void open({ directory: true, multiple: false })
      .then((chosen) => {
        if (typeof chosen === "string") patch({ folder: chosen });
      })
      .catch(() => {});
  }, [patch]);

  if (!logger) return <div className="logger-panel">loading…</div>;

  const previewText =
    filePreview.resolved == null ? "—" : loggerPreviewName(filePreview.resolved);
  // One message line, for what has gone wrong or what is being waited
  // on. Not a logging status line: the file being written shows in the
  // folder's file list, not here.
  const message = status?.error
    ? `⚠ ${status.error}`
    : filePreview.error
      ? `⚠ ${filePreview.error}`
      : logger.enabled && !connected
        ? "Enabled — waiting for connection; logging starts on connect."
        : logger.enabled && filePreview.startResolvedAsNow
          ? "The capture has no wall-clock start, so {start} names the moment logging begins."
          : "";

  return (
    <div className="logger-panel">
      <div className="logger-head">
        <label className="logger-switch">
          <input
            type="checkbox"
            checked={logger.enabled}
            aria-label="Enabled"
            onChange={(e) => patch({ enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
      </div>

      <div className="logger-row">
        <label htmlFor={`${elementId}-folder`}>Folder</label>
        <input
          id={`${elementId}-folder`}
          type="text"
          spellCheck={false}
          value={folder}
          disabled={writing}
          onChange={(e) => patch({ folder: e.target.value })}
        />
        <button type="button" disabled={writing} onClick={browse}>
          Browse…
        </button>
        <TemplateTokenHelp logger />
      </div>
      <div
        className={folderPreview.error ? "logger-resolved bad" : "logger-resolved"}
        data-testid="logger-folder-resolved"
      >
        {folderPreview.error ? `⚠ ${folderPreview.error}` : `→ ${folderPreview.resolved ?? ""}`}
      </div>

      <div className="logger-row">
        <label htmlFor={`${elementId}-file`}>File</label>
        <input
          id={`${elementId}-file`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={file}
          onChange={(e) => patch({ file: e.target.value })}
        />
        <TemplateTokenHelp logger />
      </div>

      <div className="logger-row">
        <span className="logger-lbl">Preview</span>
        <span className="logger-preview" data-testid="logger-preview">
          {previewText}
        </span>
      </div>

      {/* No format control: a logger writes BLF, and a select with one
          choice asks a question that has one answer. The element keeps
          its `format` field — the host, the project file and the
          preview's extension all read it — so the control can come back
          when there is a second format to log in. */}
      <div className="logger-row">
        <label htmlFor={`${elementId}-max-size`}>Max size</label>
        <input
          id={`${elementId}-max-size`}
          type="number"
          min={1}
          className="logger-max"
          value={logger.maxFileSizeMb}
          disabled={writing}
          onChange={(e) => {
            const mb = Number(e.target.value);
            if (Number.isFinite(mb) && mb >= 1) patch({ maxFileSizeMb: Math.floor(mb) });
          }}
        />
        <span className="logger-hint">MB — splits when reached</span>
      </div>

      {message !== "" && (
        <div className="logger-message" data-testid="logger-message">
          {message}
        </div>
      )}
    </div>
  );
}
