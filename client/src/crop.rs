//! Crop coordinates are shared by the editor and encoder, including every GIF frame.
use anyhow::{ensure, Result};
use image::{AnimationDecoder, ImageDecoder};
use std::{io::Cursor, path::Path};

#[derive(Clone, Copy, Debug)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
    pub banner: bool,
}
impl Crop {
    pub fn new(banner: bool) -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            zoom: 1.,
            banner,
        }
    }
    pub fn rect(self, width: u32, height: u32) -> (u32, u32, u32, u32) {
        if width == 0 || height == 0 {
            return (0, 0, 0, 0);
        }
        let ratio = if self.banner { 3. } else { 1. };
        let zoom = if self.zoom.is_finite() {
            self.zoom.clamp(1., 8.)
        } else {
            1.
        };
        let w = (width as f64).min(height as f64 * ratio) / zoom;
        let h = w / ratio;
        let w = (w.round() as u32).clamp(1, width.max(1));
        let h = (h.round() as u32).clamp(1, height.max(1));
        let pos = |v: f64| if v.is_finite() { v.clamp(0., 1.) } else { 0.5 };
        (
            ((width - w) as f64 * pos(self.x)).round() as u32,
            ((height - h) as f64 * pos(self.y)).round() as u32,
            w,
            h,
        )
    }
    fn apply(self, image: &image::RgbaImage) -> image::RgbaImage {
        let (x, y, w, h) = self.rect(image.width(), image.height());
        let (out_w, out_h) = if self.banner { (1200, 400) } else { (512, 512) };
        image::imageops::resize(
            &image::imageops::crop_imm(image, x, y, w, h).to_image(),
            out_w,
            out_h,
            image::imageops::FilterType::Lanczos3,
        )
    }
}
pub fn read(path: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    ensure!(
        file.metadata()?.len() <= 25 * 1024 * 1024,
        "Изображение должно быть не больше 25 МБ"
    );
    let mut bytes = Vec::new();
    file.take(25 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 25 * 1024 * 1024,
        "Изображение слишком большое"
    );
    Ok(bytes)
}
pub fn encode(bytes: Vec<u8>, crop: Crop) -> Result<(Vec<u8>, &'static str)> {
    let mut output = Vec::new();
    if bytes.starts_with(b"GIF8") {
        let mut decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes))?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(64 * 1024 * 1024);
        decoder.set_limits(limits)?;
        let loop_count = decoder.loop_count();
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(Limited(&mut output), 10);
        encoder.set_repeat(match loop_count {
            image::metadata::LoopCount::Infinite => image::codecs::gif::Repeat::Infinite,
            image::metadata::LoopCount::Finite(n) => {
                image::codecs::gif::Repeat::Finite(n.get().min(u16::MAX as u32) as u16)
            }
        })?;
        let mut count = 0;
        for frame in decoder.into_frames() {
            count += 1;
            ensure!(
                count <= 300,
                "Для обрезки выберите GIF не длиннее 300 кадров или загрузите оригинал"
            );
            let frame = frame?;
            let delay = frame.delay();
            encoder.encode_frame(image::Frame::from_parts(
                crop.apply(frame.buffer()),
                0,
                0,
                delay,
            ))?;
        }
        ensure!(count > 0, "Пустая GIF-анимация");
        drop(encoder);
        ensure!(
            output.len() <= 10 * 1024 * 1024,
            "После обрезки GIF превышает 10 МБ. Уменьшите анимацию или загрузите оригинал"
        );
        Ok((output, "image/gif"))
    } else {
        let preview = crate::images::decode(bytes)?;
        let image = image::RgbaImage::from_raw(
            preview.width,
            preview.height,
            preview.frames.into_iter().next().unwrap().rgba,
        )
        .unwrap();
        image::DynamicImage::ImageRgba8(crop.apply(&image))
            .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)?;
        Ok((output, "image/png"))
    }
}
struct Limited<'a>(&'a mut Vec<u8>);
impl std::io::Write for Limited<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len() + bytes.len() > 10 * 1024 * 1024 {
            return Err(std::io::Error::other("Обрезанная GIF превышает 10 МБ. Выберите более короткую анимацию или загрузите оригинал"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edges_zoom_and_animated_crop() {
        let mut crop = Crop::new(false);
        crop.x = 1.;
        assert_eq!(crop.rect(200, 100), (100, 0, 100, 100));
        crop.zoom = 2.;
        assert_eq!(crop.rect(200, 100), (150, 25, 50, 50));
        let mut bytes = vec![];
        {
            let mut enc = image::codecs::gif::GifEncoder::new(&mut bytes);
            enc.set_repeat(image::codecs::gif::Repeat::Infinite)
                .unwrap();
            for (color, delay) in [([255, 0, 0, 255], 100), ([0, 0, 255, 255], 200)] {
                enc.encode_frame(image::Frame::from_parts(
                    image::RgbaImage::from_pixel(20, 10, image::Rgba(color)),
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(delay, 1),
                ))
                .unwrap();
            }
        }
        let (bytes, mime) = encode(bytes, crop).unwrap();
        assert_eq!(mime, "image/gif");
        let result = crate::images::decode(bytes).unwrap();
        assert_eq!((result.width, result.height), (512, 512));
        assert_eq!(result.frames.len(), 2);
        assert_eq!(result.frames[1].delay_ms, 200);
        assert_ne!(result.frames[0].rgba, result.frames[1].rgba);
    }
}
