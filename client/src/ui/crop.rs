use super::*;
use crate::crop::Crop;
use std::path::PathBuf;

impl Client {
    pub(super) fn crop_image(
        self: &App,
        kind: String,
        file: PathBuf,
        preview: crate::images::Preview,
    ) {
        let dialog = self.dialog("Обрезка изображения", 640, 610);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 12);
        margins(&box_, 20);
        box_.append(&label(
            "Перетащите изображение и выберите масштаб",
            "heading",
        ));
        let crop = Rc::new(RefCell::new(Crop::new(kind == "banner")));
        let width = preview.width;
        let height = preview.height;
        let frame = &preview.frames[0];
        // Cairo ARGB32 stores native-endian premultiplied channels.
        let mut pixels = vec![0; frame.rgba.len()];
        for (out, rgba) in pixels
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(frame.rgba.as_chunks::<4>().0.iter())
        {
            let a = rgba[3] as u32;
            let argb = (a << 24)
                | (((rgba[0] as u32 * a + 127) / 255) << 16)
                | (((rgba[1] as u32 * a + 127) / 255) << 8)
                | ((rgba[2] as u32 * a + 127) / 255);
            out.copy_from_slice(&argb.to_ne_bytes());
        }
        let Ok(surface) = gtk::cairo::ImageSurface::create_for_data(
            pixels,
            gtk::cairo::Format::ARgb32,
            width as i32,
            height as i32,
            width as i32 * 4,
        ) else {
            self.toast("Не удалось открыть редактор изображения");
            return;
        };
        let area = gtk::DrawingArea::builder()
            .content_width(560)
            .content_height(340)
            .vexpand(true)
            .build();
        let state = crop.clone();
        area.set_draw_func(move |_, cr, w, h| {
            let crop = *state.borrow();
            let (x, y, cw, ch) = crop.rect(width, height);
            let scale = (w as f64 / cw as f64).min(h as f64 / ch as f64) * 0.85;
            let left = (w as f64 - cw as f64 * scale) / 2.;
            let top = (h as f64 - ch as f64 * scale) / 2.;
            cr.set_source_rgb(0.08, 0.08, 0.1);
            let _ = cr.paint();
            let _ = cr.save();
            cr.rectangle(left, top, cw as f64 * scale, ch as f64 * scale);
            cr.clip();
            cr.translate(left - x as f64 * scale, top - y as f64 * scale);
            cr.scale(scale, scale);
            let _ = cr.set_source_surface(&surface, 0., 0.);
            let _ = cr.paint();
            let _ = cr.restore();
            cr.set_source_rgb(0.5, 0.6, 1.);
            cr.set_line_width(2.);
            cr.rectangle(left, top, cw as f64 * scale, ch as f64 * scale);
            let _ = cr.stroke();
        });
        let drag = gtk::GestureDrag::new();
        let origin = Rc::new(RefCell::new((0., 0.)));
        let start = origin.clone();
        let state = crop.clone();
        drag.connect_drag_begin(move |_, _, _| {
            let c = state.borrow();
            *start.borrow_mut() = (c.x, c.y);
        });
        let state = crop.clone();
        let redraw = area.downgrade();
        drag.connect_drag_update(move |_, dx, dy| {
            if let Some(area) = redraw.upgrade() {
                let mut c = state.borrow_mut();
                let (_, _, cw, ch) = c.rect(width, height);
                let scale =
                    (area.width() as f64 / cw as f64).min(area.height() as f64 / ch as f64) * 0.85;
                let (x, y) = *origin.borrow();
                c.x = (x - dx / scale / (width - cw).max(1) as f64).clamp(0., 1.);
                c.y = (y - dy / scale / (height - ch).max(1) as f64).clamp(0., 1.);
                area.queue_draw();
            }
        });
        area.add_controller(drag);
        box_.append(&area);
        let zoom = gtk::Scale::with_range(gtk::Orientation::Horizontal, 1., 8., 0.05);
        zoom.set_value(1.);
        zoom.set_digits(2);
        let state = crop.clone();
        let redraw = area.downgrade();
        zoom.connect_value_changed(move |s| {
            state.borrow_mut().zoom = s.value();
            if let Some(a) = redraw.upgrade() {
                a.queue_draw();
            }
        });
        box_.append(&label("Масштаб", "muted"));
        box_.append(&zoom);
        if preview.frames.len() > 1 {
            box_.append(&label(
                "GIF: обрезка применится ко всем кадрам анимации.",
                "muted",
            ));
        }
        let buttons = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let original = button("Загрузить оригинал", "");
        let save = button("Обрезать и загрузить", "suggested-action");
        let cancel = button("Отмена", "");
        buttons.append(&cancel);
        buttons.append(&original);
        buttons.append(&save);
        box_.append(&buttons);
        let win = dialog.downgrade();
        cancel.connect_clicked(move |_| {
            if let Some(w) = win.upgrade() {
                w.close();
            }
        });
        let weak = Rc::downgrade(self);
        let win = dialog.downgrade();
        let input = file.clone();
        let k = kind.clone();
        original.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.send(Command::UploadImage {
                    kind: k.clone(),
                    file: input.clone(),
                });
            }
            if let Some(w) = win.upgrade() {
                w.close();
            }
        });
        let weak = Rc::downgrade(self);
        let win = dialog.downgrade();
        save.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.send(Command::UploadCrop {
                    kind: kind.clone(),
                    file: file.clone(),
                    crop: *crop.borrow(),
                });
                a.toast("Обрабатываю изображение…");
            }
            if let Some(w) = win.upgrade() {
                w.close();
            }
        });
        dialog.set_child(Some(&box_));
        dialog.present();
    }
}
