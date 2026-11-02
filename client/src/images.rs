//! Bounded decoding off the GTK thread, including GIF frame disposal/compositing.
use anyhow::{bail, Context, Result};
use image::{AnimationDecoder, ImageDecoder};
use std::io::Cursor;

pub const MAX_PREVIEW_BYTES: usize = 32 * 1024 * 1024;
#[derive(Debug)]
pub struct Frame {
    pub rgba: Vec<u8>,
    pub delay_ms: u64,
}
#[derive(Debug)]
pub struct Preview {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<Frame>,
    pub loops: Option<u16>,
}
impl Preview {
    pub fn bytes(&self) -> usize {
        self.frames.iter().map(|f| f.rgba.len()).sum()
    }
}
pub fn decode(bytes: Vec<u8>) -> Result<Preview> {
    let limits = || {
        let mut l = image::Limits::default();
        l.max_image_width = Some(4096);
        l.max_image_height = Some(4096);
        l.max_alloc = Some(MAX_PREVIEW_BYTES as u64);
        l
    };
    if bytes.starts_with(b"GIF8") {
        let mut decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes))?;
        decoder.set_limits(limits())?;
        let (width, height) = decoder.dimensions();
        let frame_bytes = width as usize * height as usize * 4;
        if frame_bytes == 0 || frame_bytes > MAX_PREVIEW_BYTES {
            bail!("Изображение слишком большое");
        }
        let loops = match decoder.loop_count() {
            image::metadata::LoopCount::Infinite => None,
            image::metadata::LoopCount::Finite(n) => Some(n.get().min(u16::MAX as u32) as u16),
        };
        let mut frames = vec![];
        let budget = (MAX_PREVIEW_BYTES / frame_bytes).min(300);
        let mut source = decoder.into_frames();
        for frame in source.by_ref().take(budget) {
            let frame = frame?;
            let (n, d) = frame.delay().numer_denom_ms();
            let delay_ms = (n as u64 / d.max(1) as u64).max(20);
            frames.push(Frame {
                delay_ms,
                rgba: frame.into_buffer().into_raw(),
            });
        }
        if frames.is_empty() {
            bail!("Пустая GIF-анимация");
        }
        // Avoid displaying a broken partial loop when the budget is exceeded.
        if frames.len() == budget && source.next().is_some() {
            frames.truncate(1);
        }
        return Ok(Preview {
            width,
            height,
            frames,
            loops,
        });
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    reader.limits(limits());
    let image = reader
        .decode()
        .context("Не удалось открыть изображение")?
        .into_rgba8();
    Ok(Preview {
        width: image.width(),
        height: image.height(),
        frames: vec![Frame {
            rgba: image.into_raw(),
            delay_ms: 100,
        }],
        loops: Some(1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gif_preserves_distinct_frames_and_timing() {
        let mut bytes = vec![];
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            encoder
                .set_repeat(image::codecs::gif::Repeat::Infinite)
                .unwrap();
            for (color, delay) in [([255, 0, 0, 255], 100), ([0, 0, 255, 255], 200)] {
                encoder
                    .encode_frame(image::Frame::from_parts(
                        image::RgbaImage::from_pixel(2, 2, image::Rgba(color)),
                        0,
                        0,
                        image::Delay::from_numer_denom_ms(delay, 1),
                    ))
                    .unwrap();
            }
        }
        let preview = decode(bytes).unwrap();
        assert_eq!(preview.frames.len(), 2);
        assert_eq!(preview.frames[0].delay_ms, 100);
        assert_eq!(preview.frames[1].delay_ms, 200);
        assert_ne!(preview.frames[0].rgba, preview.frames[1].rgba);
        assert_eq!(preview.loops, None);
        assert!(decode(b"GIF89a\xff\xff\xff\xff".to_vec()).is_err());
    }
}
