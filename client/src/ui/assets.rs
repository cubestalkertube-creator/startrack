use super::*;
pub(super) struct CachedImage {
    frames: Vec<(gdk::MemoryTexture, u64)>,
    duration: u64,
    bytes: usize,
    loops: Option<u16>,
    start: Instant,
}
struct Animation {
    picture: glib::WeakRef<gtk::Picture>,
    image: Rc<CachedImage>,
    frame: usize,
}
#[derive(Default)]
pub(super) struct Assets {
    textures: BTreeMap<String, Rc<CachedImage>>,
    pub waiting: BTreeMap<String, Vec<glib::WeakRef<gtk::Picture>>>,
    animations: Vec<Animation>,
}
impl Assets {
    pub fn clear(&mut self) {
        self.textures.clear();
        self.waiting.clear();
        self.animations.clear();
    }
    fn attach(&mut self, picture: &gtk::Picture, image: Rc<CachedImage>) {
        picture.set_paintable(Some(&image.frames[0].0));
        if image.frames.len() > 1 {
            self.animations.push(Animation {
                picture: picture.downgrade(),
                image,
                frame: 0,
            });
        }
    }
    pub fn animate(&mut self, enabled: bool) {
        self.animations.retain_mut(|a| {
            let Some(picture) = a.picture.upgrade() else {
                return false;
            };
            if picture.is_mapped() {
                let elapsed = a.image.start.elapsed().as_millis() as u64;
                let frame = if !enabled {
                    0
                } else if a
                    .image
                    .loops
                    .is_some_and(|n| elapsed >= a.image.duration * n as u64)
                {
                    a.image.frames.len() - 1
                } else {
                    let time = elapsed % a.image.duration;
                    a.image
                        .frames
                        .iter()
                        .position(|(_, end)| time < *end)
                        .unwrap_or(0)
                };
                if frame != a.frame {
                    picture.set_paintable(Some(&a.image.frames[frame].0));
                    a.frame = frame;
                }
            }
            true
        });
    }
}
impl Client {
    pub(super) fn image(&self, path: &str, width: i32, height: i32) -> gtk::Picture {
        let picture = gtk::Picture::new();
        picture.set_size_request(width, height);
        picture.set_can_shrink(true);
        picture.set_content_fit(gtk::ContentFit::Contain);
        let mut assets = self.assets.borrow_mut();
        if let Some(image) = assets.textures.get(path).cloned() {
            assets.attach(&picture, image);
        } else {
            let first = !assets.waiting.contains_key(path);
            assets
                .waiting
                .entry(path.into())
                .or_default()
                .push(picture.downgrade());
            if first {
                self.send(Command::Asset(path.into()));
            }
        }
        picture
    }
    pub(super) fn received_image(&self, path: String, preview: crate::images::Preview) {
        let mut duration = 0;
        let bytes = preview.bytes();
        let frames = preview
            .frames
            .into_iter()
            .map(|frame| {
                duration += frame.delay_ms;
                (
                    gdk::MemoryTexture::new(
                        preview.width as i32,
                        preview.height as i32,
                        gdk::MemoryFormat::R8g8b8a8,
                        &glib::Bytes::from_owned(frame.rgba),
                        preview.width as usize * 4,
                    ),
                    duration,
                )
            })
            .collect();
        let image = Rc::new(CachedImage {
            frames,
            duration,
            bytes,
            loops: preview.loops,
            start: Instant::now(),
        });
        let mut assets = self.assets.borrow_mut();
        if let Some(waiting) = assets.waiting.remove(&path) {
            for picture in waiting.into_iter().filter_map(|p| p.upgrade()) {
                assets.attach(&picture, image.clone());
            }
        }
        if assets.textures.len() >= 128
            || assets.textures.values().map(|i| i.bytes).sum::<usize>() + bytes > 64 * 1024 * 1024
        {
            assets.textures.clear();
        }
        assets.textures.insert(path, image);
    }
}
