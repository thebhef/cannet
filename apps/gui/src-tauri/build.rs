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
    // `sidecar::plan_launch`). Release builds keep the hard failure:
    // bundling an empty resource dir would ship an installer with no
    // sidecar.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        let _ = std::fs::create_dir_all("sidecar-dist/cannet-python-can");
    }
    tauri_build::build();
}
