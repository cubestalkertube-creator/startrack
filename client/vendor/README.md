# Local LiveKit audio binding patch

Sources: the published Apache-2.0 crates `libwebrtc 0.3.55` and `webrtc-sys 0.3.52`
from [LiveKit rust-sdks](https://github.com/livekit/rust-sdks).
Upstream copyright notices, NOTICE files and Apache license texts are preserved.

Startrack exposes the existing native WebRTC AudioTrackInterface SetVolume/GetVolume
through the CXX bridge and RtcAudioTrack. No WebRTC binary, audio engine, native ownership,
observer registration or device lifetime is changed. Gain stays in WebRTC's normal
playout pipeline, including its echo cancellation reference.

Modified upstream files:

- `webrtc-sys-0.3.52/include/livekit/audio_track.h`
- `webrtc-sys-0.3.52/src/audio_track.cpp`
- `webrtc-sys-0.3.52/src/audio_track.rs`
- `libwebrtc-0.3.55/src/native/audio_track.rs`
- `libwebrtc-0.3.55/src/audio_track.rs`

Both crates are pinned by client/Cargo.toml's patch table. On an SDK upgrade, check
whether upstream exposes this API, remove the local patch if possible, and rerun
the synthetic media test (including repeated room setup/teardown and gain checks).
