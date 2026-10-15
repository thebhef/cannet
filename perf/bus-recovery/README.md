# Fault-recovery bench runs

Each run of `cannet_local_sidecar.bench.fault_recovery` writes `<UTC>-<strategy>/` here: `events.jsonl` and `table.md`.
Transient: runs are committed while the recovery work is open and removed at its close.
