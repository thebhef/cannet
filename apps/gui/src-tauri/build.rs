use vergen::EmitBuilder;

fn main() {
    // Emit `VERGEN_GIT_DESCRIBE` (`git describe --tags --dirty`) so the
    // running app can report the exact tag/commit it was built from.
    // Best-effort: a build outside a git checkout (e.g. from a source
    // tarball) simply doesn't set the var, and the app falls back to the
    // Cargo crate version — see `build_version` in `lib.rs`.
    let _ = EmitBuilder::builder().git_describe(true, true, None).emit();
    tauri_build::build();
}
