//! Native Vector BLF format codec (Phase 9.5; see
//! `plans/phased-implementation.md`).
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
//! ## Modules
//!
//! - [`header`] — the 144-byte `FileStatistics` record every BLF
//!   opens with (object-type 0 in spirit; not in the object stream).
//! - [`object`] — the 16-byte `ObjectHeaderBase` preamble of every
//!   on-disk object. Per-type body framing lives in the per-type
//!   modules listed below.
//! - [`log_container`] — `LOG_CONTAINER` (object type 10), the
//!   outer wrapper every inner BLF object lives inside. Owns the
//!   zlib inflate path.
//! - [`can`] — per-type decoders/encoders for the CAN-class objects
//!   (`CAN_MESSAGE`, `CAN_MESSAGE2`, `CAN_FD_MESSAGE`,
//!   `CAN_FD_MESSAGE_64`, `CAN_ERROR_EXT`).
//! - [`marker`] — `GLOBAL_MARKER` (object type 96), the text
//!   annotation type that retires `<file>.blf.notes.json`.
//! - [`text`] — `EVENT_COMMENT` (92) and `APP_TEXT` (65), the two
//!   free-form-text annotation types Vector tools write. Preserves
//!   third-party annotations on read; lets us round-trip them on
//!   re-export.
//! - [`diagnostics`] — capture-integrity / diagnostic objects:
//!   `CAN_STATISTIC` (4) for periodic bus-load metrics, and the
//!   `DATA_LOST_BEGIN` (125) / `DATA_LOST_END` (126) sentinel pair
//!   bracketing recorder-dropped frame regions.
//! - [`reader`] — streaming reader that drives the above modules:
//!   parses `FileStatistics`, walks top-level `LOG_CONTAINER`s,
//!   inflates each, and yields decoded inner objects out of a
//!   carry-over buffer that handles objects crossing container
//!   boundaries.
//! - [`writer`] — streaming writer; the reader's mirror image.
//!   Accumulates encoded inner objects, periodically flushes them
//!   as zlib-compressed `LOG_CONTAINER`s, and rewrites the
//!   `FileStatistics` header in place at finish.
//!
//! [`header`]: crate::format::header
//! [`object`]: crate::format::object
//! [`log_container`]: crate::format::log_container
//! [`can`]: crate::format::can
//! [`marker`]: crate::format::marker
//! [`text`]: crate::format::text
//! [`diagnostics`]: crate::format::diagnostics
//! [`reader`]: crate::format::reader
//! [`writer`]: crate::format::writer

pub mod can;
pub mod diagnostics;
pub mod header;
pub mod log_container;
pub mod marker;
pub mod object;
pub mod reader;
pub mod text;
pub mod writer;
