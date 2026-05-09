// Mirrors the Rust shapes in src-tauri/src/wire.rs. Kept manually in sync
// because the two surfaces are small enough that a code generator would
// be more friction than benefit at Phase 1.

export type FrameKind =
  | { kind: "classic" }
  | { kind: "fd"; brs: boolean; esi: boolean }
  | { kind: "remote"; dlc: number }
  | { kind: "error" };

export interface SignalRecord {
  name: string;
  value: number;
  unit: string;
}

export interface DecodedRecord {
  name: string;
  signals: SignalRecord[];
}

export interface FrameRecord {
  timestamp_seconds: number;
  channel: number;
  id: number;
  extended: boolean;
  direction: "Rx" | "Tx";
  kind: FrameKind;
  data: number[];
  decoded: DecodedRecord | null;
}

export interface FrameBatch {
  frames: FrameRecord[];
}

export type LogFinished =
  | { status: "ok"; total: number }
  | { status: "error"; message: string };

export interface OpenLogResult {
  blf_path: string;
  dbc_path: string | null;
  dbc_message_count: number | null;
}
