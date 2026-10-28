fn main() {
    // libcef.so и остальные файлы CEF лежат рядом с бинарником (в AppImage тоже)
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    // интерфейс встраивается из client/dist — пересобираем, когда его пересобрали
    println!("cargo:rerun-if-changed=../dist");
}
