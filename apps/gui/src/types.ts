// Mirrors the Rust shapes in src-tauri/src/ipc.rs. Kept manually in sync
// because the two surfaces are small enough that a code generator would
// be more friction than benefit at Phase 1.

export type CanFrameKind =
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

export interface CanFrameRecord {
  timestamp_seconds: number;
  channel: number;
  id: number;
  extended: boolean;
  direction: "Rx" | "Tx";
  kind: CanFrameKind;
  data: number[];
  decoded: DecodedRecord | null;
}

export interface CanFrameBatch {
  frames: CanFrameRecord[];
}

export type LogFinished =
  | { status: "ok"; total: number }
  | { status: "error"; message: string };

export interface OpenLogResult {
  blf_path: string;
}

export interface DbcInfo {
  dbc_path: string;
  message_count: number;
}

export interface DecodeRequest {
  channel: number;
  id: number;
  extended: boolean;
  data: number[];
}
