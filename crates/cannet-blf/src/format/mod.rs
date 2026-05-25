//! Native Vector BLF format codec, growing under Phase 9.5
//! (`plans/phased-implementation.md`).
//!
//! This module is the on-disk format surface — it parses and emits
//! the byte sequences described in Vector's "Read Write BLF API 2018
//! Version 8" header (`binlog_objects.h`), and knows nothing about
//! cannet's domain types. The crate-level [`BlfCanFrameSource`] /
//! [`BlfCaptureWriter`] glue translates between the two.
//!
//! [`BlfCanFrameSource`]: crate::BlfCanFrameSource
//! [`BlfCaptureWriter`]: crate::BlfCaptureWriter
//!
//! ## Layout (work in progress)
//!
//! Tranches land per the phase doc. Modules present so far:
//!
//! - [`header`] — the 144-byte `FileStatistics` record every BLF
//!   opens with (object-type 0 in spirit; not in the object stream).
//! - [`object`] — the 16-byte `ObjectHeaderBase` preamble of every
//!   on-disk object. Per-type body framing lives in the per-type
//!   modules listed below.
//!
//! Subsequent tranche-1 steps add: `LOG_CONTAINER` decompression
//! (`log_container`) and the per-type CAN object decoders / encoders
//! (`can`).
//!
//! [`header`]: crate::format::header
//! [`object`]: crate::format::object

pub mod header;
pub mod object;
