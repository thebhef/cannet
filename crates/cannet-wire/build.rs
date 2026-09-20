fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Use the vendored protoc binary so contributors don't need to install
    // it system-wide.
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);
    // Two packages, two files: `cannet.v1` is the protocol major, and
    // `cannet` carries the unversioned `ServerInfo` a server answers
    // whichever majors it serves (ADR 0059). prost emits one module per
    // package, so `src/lib.rs` includes both.
    tonic_build::configure().compile_protos(
        &["proto/cannet.proto", "proto/cannet_info.proto"],
        &["proto"],
    )?;
    println!("cargo:rerun-if-changed=proto/cannet.proto");
    println!("cargo:rerun-if-changed=proto/cannet_info.proto");
    Ok(())
}
