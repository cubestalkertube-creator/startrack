use anyhow::{bail, Context, Result};
use reqwest::{Client, Method};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{path::Path, time::Duration};

#[derive(Debug)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
}
impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (HTTP {})", self.message, self.status)
    }
}
impl std::error::Error for HttpError {}

#[derive(Clone)]
pub struct Api {
    pub server: url::Url,
    pub token: String,
    client: Client,
}
impl Api {
    pub fn new(server: &str, token: String) -> Result<Self> {
        let mut server = url::Url::parse(server.trim())?;
        if !matches!(server.scheme(), "http" | "https") || server.host_str().is_none() {
            bail!("Укажите http:// или https:// адрес сервера");
        }
        if !server.username().is_empty() || server.password().is_some() {
            bail!("Адрес не должен содержать логин или пароль");
        }
        server.set_path("/");
        server.set_query(None);
        server.set_fragment(None);
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("Startrack/", env!("CARGO_PKG_VERSION"), " native"))
            .build()?;
        Ok(Self {
            server,
            token,
            client,
        })
    }
    pub fn url(&self, path: &str) -> Result<url::Url> {
        if !path.starts_with('/') || path.starts_with("//") {
            bail!("Недопустимый путь API");
        }
        Ok(self.server.join(path)?)
    }
    pub fn websocket_url(&self) -> Result<url::Url> {
        let mut url = self.url("/ws")?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("Неверный адрес WebSocket"))?;
        url.query_pairs_mut().append_pair("token", &self.token);
        Ok(url)
    }
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.request(Method::GET, path, None).await
    }
    pub async fn post<T: DeserializeOwned>(&self, path: &str, body: &Value) -> Result<T> {
        self.request(Method::POST, path, Some(body)).await
    }
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T> {
        let mut request = self
            .client
            .request(method, self.url(path)?)
            .bearer_auth(&self.token);
        if path.starts_with("/api/verity") {
            request = request.timeout(Duration::from_secs(250));
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let res = request
            .send()
            .await
            .context("Не удалось связаться с сервером")?;
        Self::decode(res).await
    }
    async fn decode<T: DeserializeOwned>(res: reqwest::Response) -> Result<T> {
        let status = res.status();
        if !status.is_success() {
            let data: Value = res.json().await.unwrap_or(Value::Null);
            return Err(HttpError {
                status: status.as_u16(),
                message: data["error"].as_str().unwrap_or("Ошибка сервера").into(),
            }
            .into());
        }
        res.json().await.context("Сервер вернул некорректный ответ")
    }
    pub async fn upload<T: DeserializeOwned>(&self, path: &str, file: &Path) -> Result<T> {
        let mime = mime_guess::from_path(file).first_or_octet_stream();
        let file = tokio::fs::File::open(file)
            .await
            .context("Не удалось прочитать файл")?;
        let size = file.metadata().await?.len();
        if size == 0 || size > 500 * 1024 * 1024 {
            bail!("Размер файла должен быть от 1 байта до 500 МБ");
        }
        let res = self
            .client
            .post(self.url(path)?)
            .bearer_auth(&self.token)
            .header("Content-Type", mime.as_ref())
            .header("Content-Length", size)
            .timeout(Duration::from_secs(600))
            .body(reqwest::Body::wrap_stream(
                tokio_util::io::ReaderStream::new(file),
            ))
            .send()
            .await?;
        Self::decode(res).await
    }
    pub async fn upload_sound(
        &self,
        name: &str,
        emoji: &str,
        volume: f32,
        wav: Vec<u8>,
    ) -> Result<Value> {
        if wav.len() > 1024 * 1024 || wav.is_empty() {
            bail!("Звук должен быть не больше 1 МБ");
        }
        let mut url = self.url("/api/sounds/upload")?;
        url.query_pairs_mut()
            .append_pair("name", name)
            .append_pair("emoji", emoji)
            .append_pair("vol", &volume.to_string());
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.token)
            .header("Content-Type", "audio/wav")
            .body(wav)
            .send()
            .await?;
        Self::decode(response).await
    }
    pub async fn upload_image(&self, kind: &str, bytes: Vec<u8>, mime: &str) -> Result<Value> {
        anyhow::ensure!(
            matches!(kind, "avatar" | "banner"),
            "Недопустимый тип изображения"
        );
        let response = self
            .client
            .post(self.url(&format!("/api/me/image?kind={kind}"))?)
            .bearer_auth(&self.token)
            .header("Content-Type", mime)
            .body(bytes)
            .send()
            .await?;
        Self::decode(response).await
    }
    pub async fn download(&self, id: &str, dest: &Path) -> Result<()> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut url = self.url(&format!(
            "/api/files/{}",
            url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
        ))?;
        url.query_pairs_mut().append_pair("download", "1");
        let res = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(600))
            .send()
            .await?
            .error_for_status()?;
        let temp = dest.with_extension("startrack-part");
        let result: Result<()> = async {
            let mut file = tokio::fs::File::create(&temp).await?;
            let mut stream = res.bytes_stream();
            while let Some(data) = stream.next().await {
                file.write_all(&data?).await?;
            }
            file.flush().await?;
            drop(file);
            tokio::fs::rename(&temp, dest).await?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        result
    }
    pub async fn bytes(&self, path: &str, limit: usize) -> Result<Vec<u8>> {
        use futures_util::StreamExt;
        let response = self
            .client
            .get(self.url(path)?)
            .bearer_auth(&self.token)
            .send()
            .await?
            .error_for_status()?;
        if response.content_length().is_some_and(|n| n > limit as u64) {
            bail!("Файл слишком большой для предпросмотра");
        }
        let mut stream = response.bytes_stream();
        let mut data = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if data.len() + chunk.len() > limit {
                bail!("Файл слишком большой для предпросмотра");
            }
            data.extend_from_slice(&chunk);
        }
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_server_and_encodes_websocket_token() {
        assert!(Api::new("file:///tmp/secret", String::new()).is_err());
        let api = Api::new("https://localhost:8080", "a&b?c".into()).unwrap();
        let url = api.websocket_url().unwrap();
        assert_eq!(url.scheme(), "wss");
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "token").unwrap().1,
            "a&b?c"
        );
        assert!(api.url("//example.com").is_err());
    }
}
