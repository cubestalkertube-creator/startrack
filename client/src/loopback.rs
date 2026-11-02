//! System output capture has its own lifetime and is never mixed into the microphone.
use anyhow::Result;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub fn start(stop: Arc<AtomicBool>) -> Result<tokio::sync::mpsc::Receiver<Vec<i16>>> {
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let (ready, result) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("system-audio".into())
        .spawn(move || {
            let result = capture(&stop, &tx, &ready);
            if let Err(e) = result {
                let _ = ready.send(Err(e.to_string()));
            }
        })?;
    result
        .recv_timeout(std::time::Duration::from_secs(5))?
        .map_err(anyhow::Error::msg)?;
    Ok(rx)
}
#[cfg(windows)]
fn capture(
    stop: &AtomicBool,
    tx: &tokio::sync::mpsc::Sender<Vec<i16>>,
    ready: &std::sync::mpsc::SyncSender<Result<(), String>>,
) -> Result<()> {
    use wasapi::*;
    initialize_mta().ok()?;
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            deinitialize();
        }
    }
    let _com = Com;
    // Exclude our process tree: otherwise the other participant hears their own voice back.
    let mut client = AudioClient::new_application_loopback_client(std::process::id(), false)?;
    let format = WaveFormat::new(16, 16, &SampleType::Int, 48000, 2, None);
    client.initialize_client(
        &format,
        &Direction::Capture,
        &StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 0,
        },
    )?;
    let event = client.set_get_eventhandle()?;
    let capture: windows::Win32::Media::Audio::IAudioCaptureClient =
        unsafe { client.as_iaudioclient().GetService()? };
    client.start_stream()?;
    if ready.send(Ok(())).is_err() {
        client.stop_stream()?;
        return Ok(());
    }
    let mut queue = std::collections::VecDeque::new();
    while !stop.load(Ordering::Relaxed) && !tx.is_closed() {
        // WASAPI permits a null pointer for silent packets. Fill those with zeros
        // before constructing any slice (the convenience wrapper assumes a buffer).
        let mut ptr = std::ptr::null_mut();
        let mut frames = 0;
        let mut flags = 0;
        unsafe {
            capture.GetBuffer(&mut ptr, &mut frames, &mut flags, None, None)?;
        }
        if frames > 0 {
            let size = frames as usize * 4;
            if size > 4 * 48000 {
                unsafe {
                    capture.ReleaseBuffer(frames)?;
                }
                anyhow::bail!("Слишком большой пакет системного звука");
            }
            if flags & windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0
                || ptr.is_null()
            {
                queue.resize(queue.len() + size, 0);
            } else {
                // The packet remains owned by WASAPI until ReleaseBuffer below.
                queue.extend(unsafe { std::slice::from_raw_parts(ptr, size) });
            }
            unsafe {
                capture.ReleaseBuffer(frames)?;
            }
        }
        while queue.len() >= 1920 {
            let mut samples = Vec::with_capacity(960);
            for _ in 0..960 {
                samples.push(i16::from_le_bytes([
                    queue.pop_front().unwrap(),
                    queue.pop_front().unwrap(),
                ]));
            }
            let _ = tx.try_send(samples);
        }
        let _ = event.wait_for_event(50);
    }
    client.stop_stream()?;
    Ok(())
}
#[cfg(target_os = "linux")]
fn capture(
    stop: &AtomicBool,
    tx: &tokio::sync::mpsc::Sender<Vec<i16>>,
    ready: &std::sync::mpsc::SyncSender<Result<(), String>>,
) -> Result<()> {
    use libpulse_binding::{
        def::BufferAttr,
        sample::{Format, Spec},
        stream::Direction,
    };
    let spec = Spec {
        format: Format::S16le,
        channels: 2,
        rate: 48000,
    };
    // PulseAudio and PipeWire-Pulse expose a monitor of the current default sink.
    let stream = libpulse_simple_binding::Simple::new(
        None,
        "Startrack",
        Direction::Record,
        Some("@DEFAULT_MONITOR@"),
        "Демонстрация экрана",
        &spec,
        None,
        Some(&BufferAttr {
            maxlength: u32::MAX,
            tlength: u32::MAX,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize: 1920,
        }),
    )?;
    if ready.send(Ok(())).is_err() {
        return Ok(());
    }
    let mut bytes = [0; 1920];
    while !stop.load(Ordering::Relaxed) && !tx.is_closed() {
        stream.read(&mut bytes)?;
        let samples = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| i16::from_le_bytes(*p))
            .collect();
        let _ = tx.try_send(samples);
    }
    Ok(())
}
#[cfg(not(any(windows, target_os = "linux")))]
fn capture(
    _: &AtomicBool,
    _: &tokio::sync::mpsc::Sender<Vec<i16>>,
    _: &std::sync::mpsc::SyncSender<Result<(), String>>,
) -> Result<()> {
    anyhow::bail!("Системный звук поддерживается в Windows и Linux")
}
