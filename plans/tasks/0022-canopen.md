# Task 22 — CANopen

EDS ingestion (CANopen Electronic Data Sheet — library TBD when this
task becomes current) and SDO / PDO decoding on top of the Task 5
value-table machinery.

**ADR cleanup:** scrub task-number references out of
[ADR 0021](../../docs/adr/0021-virtual-bus-server.md) (its CANopen
"participant vs. node" note) and the CANopen mention in
[ADR 0017](../../docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md)
— ADRs describe what *is*; task tracking lives here, not in the ADR.
