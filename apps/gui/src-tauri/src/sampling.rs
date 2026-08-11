//! Signal-sampling commands for the plot panels.
//!
//! `sample_signals` serves a plot's visible-window slice from the
//! per-signal decimation pyramids (ADR 0002 DS-5), packed into the
//! compact binary layout the frontend decodes; `signal_min_max` answers
//! the host-owned y-extent (ADR 0025). Both catch the caches up to the
//! store tip, so per-tick cost is `O(new matches)`.

use tauri::{AppHandle, Manager, State};

use cannet_dbc::Database;

use crate::app_state::AppState;
use crate::ipc::{DecimatedRange, SampledPoints, SignalExtent, SignalQuery};
use crate::signal_cache::CacheQuery;
use crate::signal_sampler;

/// Sample a batch of DBC signals over a slice `[from_index, window_end)`
/// of the capture (frame-index range — a plot panel backed by a trace
/// element passes it), returning one [`SampledPoints`] per query (same
/// order) plus the slice's first/last frame timestamps so a live plot
/// can place its x-origin and "follow live" edge without a second
/// round-trip. A signal's points are empty if no DBC is attached or the
/// id / signal is unknown / unseen in the slice.
///
/// One trace-store lock acquisition cleans out *all* the queried
/// signals' frames at once (via [`TraceStore::slice_matching_many`], so
/// the per-tick lock hold is `O(Σ matches)`, not `O(|signals| ·
/// window)`); the DBC lock is then taken once for the whole batch's
/// decode. A live plot re-samples this frequently and **incrementally**
/// — each tick `from_index` is just past the last frame it already has,
/// so `[from_index, window_end)` is one tick's worth of new frames, not
/// the whole capture. (The first call after the plot opens / its window
/// re-anchors passes `from_index` = the window start, decoding the
/// backlog once.)
///
/// `max_points` (`0` ⇒ no limit): the caller passes roughly the pixel
/// width of the plot (times a small factor) on a full / backlog fetch so
/// that fetch is min/max-decimated rather than shipping a point per
/// frame; on an incremental tick it passes `0` (the slice is already
/// small, and the caller re-decimates its own accumulated series).
/// Min/max decimation preserves per-bucket extrema, so spikes survive.
///
/// The returned `from_seconds` / `last_seconds` are facts about the
/// *window*, read off the store's anchors — they do not depend on which
/// signals were asked for. **An empty `signals` list is therefore the
/// extent-only form of this query**: the window's bounds with no
/// per-signal slicing or decode at all. A view that must know where the
/// capture currently ends, without pulling a slice it is not going to
/// draw, calls it that way.
///
/// `async` for the same reason as `fetch_trace_range`: the slice +
/// decode can briefly contend with a fast pump thread, so it runs off
/// the UI thread. The trace-store slice is taken before the DBC lock to
/// keep the lock order (DBC ⊃ nothing) consistent with the other
/// commands. The body itself runs on the blocking pool
/// ([`off_async_workers`]) — the first serve of a signal rebuilds its
/// whole pyramid, which is capture-scaled work an async worker must not
/// be holding.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sample_signals(
    app: AppHandle,
    from_index: u32,
    window_end: u32,
    from_seconds: Option<f64>,
    to_seconds: Option<f64>,
    signals: Vec<SignalQuery>,
    max_points: u32,
) -> tauri::ipc::Response {
    let encoded = off_async_workers(move || {
        let sample = sample_signals_inner(
            &app,
            from_index,
            window_end,
            from_seconds,
            to_seconds,
            &signals,
            max_points,
        );
        encode_signals_sample(&sample)
    })
    .await;
    tauri::ipc::Response::new(encoded)
}

/// Run a command's synchronous, capture-scaled body on the blocking pool
/// instead of on an async-runtime worker (ADR 0048).
///
/// The sampling commands are `async fn`s that never await: the first
/// serve of a signal rebuilds its pyramid, which is minutes of decoding
/// over a long capture, and it happened on the worker thread that polled
/// the future. With one plotted area per worker the runtime ran out of
/// them, and the close path's own command — the `rbs_dirty` the window's
/// close handler awaits before it may destroy the window — was never
/// dispatched. Handing the body to the blocking pool frees the worker
/// for the duration.
async fn off_async_workers<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        // The body panicked on the blocking thread and the panic was
        // caught there; re-raise it here so the command fails exactly as
        // it did when the body ran inline.
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

/// Pack a [`DecimatedRange`] into the compact binary layout the frontend
/// decodes via `DataView` / `Float64Array`. Replaces the JSON encode of
/// the same data — at 10 panels × a few signals × thousands of points
/// the JSON path was 100-200 ms of every per-tick wall clock, and
/// almost all of that was spent encoding f64 arrays to base-10 text
/// just for the JS side to parse them straight back to floats.
///
/// Layout (little-endian throughout):
/// ```text
/// magic   8 bytes  "SIGSAMP\x01"
/// from_s  f64      capture-window first timestamp, NaN ⇒ null
/// last_s  f64      capture-window last timestamp, NaN ⇒ null
/// slice   f64      diagnostic: lock-held slice ms
/// decode  f64      diagnostic: decode + decimate ms
/// nsig    u32      number of signals
/// for each signal:
///   n     u32      sample count
///   t[n]  f64×n    timestamps (absolute seconds)
///   v[n]  f64×n    values
/// ```
fn encode_signals_sample(s: &DecimatedRange) -> Vec<u8> {
    let total_points: usize = s.series.iter().map(|p| p.t.len()).sum();
    let mut buf = Vec::with_capacity(8 + 32 + 4 + s.series.len() * 4 + total_points * 16);
    buf.extend_from_slice(b"SIGSAMP\x01");
    buf.extend_from_slice(&s.from_seconds.unwrap_or(f64::NAN).to_le_bytes());
    buf.extend_from_slice(&s.last_seconds.unwrap_or(f64::NAN).to_le_bytes());
    buf.extend_from_slice(&s.slice_ms.to_le_bytes());
    buf.extend_from_slice(&s.decode_ms.to_le_bytes());
    #[allow(clippy::cast_possible_truncation)]
    buf.extend_from_slice(&(s.series.len() as u32).to_le_bytes());
    for p in &s.series {
        debug_assert_eq!(p.t.len(), p.v.len());
        #[allow(clippy::cast_possible_truncation)]
        buf.extend_from_slice(&(p.t.len() as u32).to_le_bytes());
        for &t in &p.t {
            buf.extend_from_slice(&t.to_le_bytes());
        }
        for &v in &p.v {
            buf.extend_from_slice(&v.to_le_bytes());
        }
    }
    buf
}

fn sample_signals_inner(
    app: &AppHandle,
    from_index: u32,
    window_end: u32,
    from_seconds: Option<f64>,
    to_seconds: Option<f64>,
    signals: &[SignalQuery],
    max_points: u32,
) -> DecimatedRange {
    let state: State<'_, AppState> = app.state();

    #[allow(clippy::cast_precision_loss)]
    let ns_to_seconds = |ns: u64| (ns as f64) / 1e9;

    let t_slice = std::time::Instant::now();
    // One coherent read: the window's floor, the capture's live edge, and
    // the store length they describe. `window_end` bounds the window but
    // does *not* pick the edge — the edge is a store-level fact
    // (`max_ts`), because the last row in a range is not the newest frame
    // in it once several buses interleave their arrivals.
    let anchors = state.trace_store.window_anchors(from_index as usize);
    let from_ts = anchors.first_ns;
    let last_ts = if (window_end as usize) >= anchors.len {
        anchors.live_edge_ns
    } else {
        // A window deliberately short of the tip keeps its own right
        // edge; the live edge would be outside it.
        state
            .trace_store
            .frame_timestamps(from_index as usize, window_end as usize)
            .1
    };
    // Time bounds for the per-signal slice. When the caller didn't
    // supply them (first fetch on a fresh panel — it doesn't have a
    // base / fps yet), fall back to the window's actual timestamps so
    // the slice still covers the full window. Sending the times
    // directly (rather than reusing `from_index` / `window_end` to
    // partition the cache by frame index) is what fixes the "fencepost"
    // offset on zoomed-in panels: the frontend's `frame_index =
    // floor(t * fps)` is biased by the average-rate approximation, and
    // the returned samples ended up tens of seconds inside the
    // requested left edge whenever the per-id rate wasn't uniform.
    let slice_from = from_seconds.unwrap_or_else(|| from_ts.map_or(f64::MIN, ns_to_seconds));
    let slice_to = to_seconds.unwrap_or_else(|| {
        // `last_ts` is the timestamp of the *last* frame in the window
        // — the cache slice's right edge is exclusive, so widen by one
        // second so that last sample isn't lost. (One tick of float
        // precision would be cleaner but at 1 e9 ns scale the next
        // representable float is multiple ns away.)
        last_ts.map_or(f64::MAX, |ns| ns_to_seconds(ns) + 1.0)
    });
    // Catch the per-signal decoded-sample caches up to the trace
    // store's current tip and pull the slice each plot wants. Catch-up
    // is `O(new matches)` rather than `O(matches in window)`, which is
    // the win at long captures + high rate: per-tick host work no
    // longer scales with capture length.
    let dbs_guard = state.databases();
    let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| l.db.as_ref()).collect();
    // The cache decimates internally now: it reads the coarsest pyramid
    // level above `max_points` (ADR 0002 DS-5), so a "fit data" over a
    // huge capture serves `O(max_points)` points instead of
    // materializing and decimating the whole raw window here every tick.
    let sliced: Vec<Vec<signal_sampler::SamplePoint>> = state.signal_caches.slice_many(
        &cache_queries(signals),
        slice_from,
        slice_to,
        max_points as usize,
        &state.trace_store,
        &db_refs,
    );
    drop(dbs_guard);
    let slice_ms = t_slice.elapsed().as_secs_f64() * 1000.0;

    let t_decode = std::time::Instant::now();
    let series: Vec<SampledPoints> = sliced
        .into_iter()
        .map(|points| {
            let mut t = Vec::with_capacity(points.len());
            let mut v = Vec::with_capacity(points.len());
            for p in points {
                t.push(p.t_seconds);
                v.push(p.value);
            }
            SampledPoints { t, v }
        })
        .collect();
    let decode_ms = t_decode.elapsed().as_secs_f64() * 1000.0;

    DecimatedRange {
        from_seconds: from_ts.map(ns_to_seconds),
        last_seconds: last_ts.map(ns_to_seconds),
        series,
        slice_ms,
        decode_ms,
    }
}

/// Each requested signal's all-time value extent — the host-owned
/// y-extent the plot's auto-normalisation reads (ADR 0025: a scalar
/// model fact, queried directly rather than latched in a React ref).
/// One [`SignalExtent`] per query in the same order, `None` for a
/// signal nothing has decoded yet. Like `sample_signals` it catches the
/// per-signal caches up to the store tip (so cost is `O(new matches)`)
/// and runs its body off the async workers ([`off_async_workers`]).
#[tauri::command]
pub(crate) async fn signal_min_max(
    app: AppHandle,
    signals: Vec<SignalQuery>,
) -> Vec<Option<SignalExtent>> {
    off_async_workers(move || signal_min_max_inner(&app, &signals)).await
}

fn signal_min_max_inner(app: &AppHandle, signals: &[SignalQuery]) -> Vec<Option<SignalExtent>> {
    let state: State<'_, AppState> = app.state();
    let dbs_guard = state.databases();
    let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| l.db.as_ref()).collect();
    let out = state
        .signal_caches
        .min_max_many(&cache_queries(signals), &state.trace_store, &db_refs)
        .into_iter()
        .map(|extent| extent.map(|(lo, hi)| SignalExtent { lo, hi }))
        .collect();
    drop(dbs_guard);
    out
}

/// The wire queries as the signal cache's borrowed form, in order — the
/// batch it groups by message to catch up in one decode pass.
fn cache_queries(signals: &[SignalQuery]) -> Vec<CacheQuery<'_>> {
    signals
        .iter()
        .map(|q| CacheQuery {
            bus_id: q.bus_id.as_deref(),
            message_id: q.message_id,
            extended: q.extended,
            signal_name: &q.signal_name,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::off_async_workers;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn a_command_body_that_never_yields_does_not_park_an_async_worker() {
        // The exit-hang mechanism, at the seam (ADR 0048): a sampling
        // command whose body is a cold pyramid rebuild used to hold the
        // async worker that polled it for the whole rebuild, so the
        // close handler's own command was never dispatched. Modelled
        // with one worker and one never-returning body — a second
        // command still has to run. A would-block probe: the body is
        // released either way, so a regression fails the assertion
        // rather than hanging the suite.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .build()
            .unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (dispatched_tx, dispatched_rx) = mpsc::channel();
        rt.block_on(async move {
            let long = tokio::spawn(off_async_workers(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }));
            // The long body is running before the second command is
            // queued, so the outcome doesn't depend on scheduling order.
            started_rx.recv().unwrap();
            let close_path = tokio::spawn(async move { dispatched_tx.send(()).unwrap() });
            let dispatched = dispatched_rx.recv_timeout(Duration::from_secs(30)).is_ok();
            release_tx.send(()).unwrap();
            long.await.unwrap();
            close_path.await.unwrap();
            assert!(
                dispatched,
                "a command running a capture-scaled body held the only async worker",
            );
        });
    }
}
