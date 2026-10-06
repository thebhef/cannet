# Fault-recovery bench runs

Each run of `cannet_local_sidecar.bench.fault_recovery` writes `<UTC>-<strategy>/` here: `events.jsonl` and `table.md`.
Transient: runs are read, then deleted; they are not committed.
