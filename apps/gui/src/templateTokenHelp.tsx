// The template-token help affordance: a small ? whose hover lists the
// tokens a name/folder template accepts. The tokens are the host's
// (`export_template.rs`); this is only their legend, shared by the
// export dialog and the logger panel so the two never disagree.

import { Icon } from "./Icon";

export function TemplateTokenHelp({ logger }: { logger: boolean }) {
  const lines = [
    "{project} — the project's name, slugified",
    ...(logger ? ["{logger} — this logger's name, slugified"] : []),
    "{start} — the capture's wall-clock start ({now} when unanchored)",
    "{now} — when the file is written",
    "",
    "A bare token renders as ISO 8601 basic with offset,",
    "e.g. 20260905T091502-0600.",
    "{start:%Y-%m-%d} and friends pass straight through strftime.",
  ];
  return (
    <span
      className="template-token-help"
      title={lines.join("\n")}
      aria-label="template tokens"
      role="img"
    >
      <Icon name="help" />
    </span>
  );
}
