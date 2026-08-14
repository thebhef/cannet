use vergen::EmitBuilder;

fn main() {
    // Emit `VERGEN_GIT_DESCRIBE` (`git describe --tags --dirty`) so the
    // running app can report the exact tag/commit it was built from.
    // Best-effort: a build outside a git checkout (e.g. from a source
    // tarball) simply doesn't set the var, and the app falls back to the
    // Cargo crate version — see `build_version` in `lib.rs`.
    let _ = EmitBuilder::builder().git_describe(true, true, None).emit();
    // A dev build must compile before the sidecar has ever been frozen:
    // `tauri.conf.json` declares `sidecar-dist/cannet-python-can` as a
    // resource, and tauri-build fails on a missing resource path. Create
    // the (gitignored) directory so a fresh checkout can `tauri dev` —
    // at runtime dev builds prefer the sidecar source tree anyway (see
    // `sidecar::plan_launch`). Release builds keep the hard failure as a
    // backstop — `tauri build`'s beforeBuildCommand freezes the sidecar
    // first, so hitting it means the freeze was bypassed (e.g. a direct
    // `cargo build --release`), and bundling an empty resource dir would
    // ship an installer with no sidecar.
    // The same holds for `server-dist`, which carries the release
    // `cannet-server` every install ships (staged by
    // `scripts/stage-server.py` from `tauri build`'s
    // beforeBuildCommand): a dev build has no reason to have built the
    // release server, and nothing in the app launches it anyway.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        let _ = std::fs::create_dir_all("sidecar-dist/cannet-python-can");
        let _ = std::fs::create_dir_all("server-dist");
        if !std::path::Path::new("licenses.json").exists() {
            let _ = std::fs::write("licenses.json", "{\"components\":[]}\n");
        }
    }
    tauri_build::build();
}
