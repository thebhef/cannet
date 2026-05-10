fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Use the vendored protoc binary so contributors don't need to install
    // it system-wide.
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);
    tonic_build::compile_protos("proto/cannet.proto")?;
    println!("cargo:rerun-if-changed=proto/cannet.proto");
    Ok(())
}
