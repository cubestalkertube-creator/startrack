// Обход VPN для своего сервера (split tunneling).
// VPN в режиме TUN (Happ, Clash и т.п.) часто теряет соединения к нашему серверу. WebView2 не умеет
// выбирать сетевую карту, поэтому домены сервера отображаются на локальный адрес, а здесь каждое
// TCP-соединение пересылается на сервер с сокета, привязанного к физическому адаптеру — мимо туннеля.
// TLS сквозной: мы только перекладываем байты, SNI и сертификат остаются как есть.
// Без Tauri: этот же файл подключает и Linux-версия (client/linux).
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::time::timeout;

pub const DOMAINS: [&str; 2] = ["185-218-0-111.sslip.io", "turn.185-218-0-111.sslip.io"];
const SERVER: SocketAddr = SocketAddr::new(std::net::IpAddr::V4(Ipv4Addr::new(185, 218, 0, 111)), 443);

/// Запускает пересылку и возвращает адрес, на который отображать домены сервера.
/// Вызывать внутри рантайма tokio.
pub async fn start() -> String {
    // На Linux порт 443 без root не занять — берём любой свободный и указываем его в правиле
    let port = if cfg!(windows) { 443 } else { 0 };
    // Каждому запущенному экземпляру — свой loopback-адрес; всё занято — хотя бы без DNS
    let mut bound = None;
    for n in 1..=20u8 {
        let local = SocketAddr::new(Ipv4Addr::new(127, 83, 0, n).into(), port);
        if let Ok(l) = TcpListener::bind(local).await {
            bound = Some((l, local));
            break;
        }
    }
    let Some((listener, local)) = bound else {
        return SERVER.ip().to_string();
    };
    let local = listener.local_addr().unwrap_or(local);
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            tokio::spawn(async move {
                if let Ok(mut upstream) = connect().await {
                    let mut client = client;
                    let _ = client.set_nodelay(true);
                    let _ = upstream.set_nodelay(true);
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                }
            });
        }
    });
    if local.port() == 443 { local.ip().to_string() } else { local.to_string() }
}

async fn connect() -> std::io::Result<TcpStream> {
    // Сначала напрямую через физический адаптер; не вышло за 3 с — обычным путём (в т.ч. через VPN)
    if let Some((_name, ip)) = physical() {
        let socket = TcpSocket::new_v4()?;
        // Linux: одного адреса мало — VPN (sing-box, Clash, wg-quick) уводит в туннель по правилам
        // маршрутизации всё подряд. Сокет, привязанный к самой сетевой карте, маршруты через туннель
        // пропускают. Без прав (ядро старше 5.7) не выйдет — тогда как в Windows, по адресу.
        #[cfg(target_os = "linux")]
        let _ = socket.bind_device(Some(_name.as_bytes()));
        if socket.bind(SocketAddr::new(ip.into(), 0)).is_ok() {
            if let Ok(Ok(stream)) = timeout(Duration::from_secs(3), socket.connect(SERVER)).await {
                return Ok(stream);
            }
        }
    }
    timeout(Duration::from_secs(10), TcpStream::connect(SERVER))
        .await
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))?
}

/// Имя и IPv4 первого поднятого не-VPN адаптера со шлюзом (Ethernet / Wi-Fi).
fn physical() -> Option<(String, Ipv4Addr)> {
    let vpn = |s: &str| {
        let s = s.to_lowercase();
        ["tun", "tap", "vpn", "wireguard", "xray", "v2ray", "happ", "clash", "mihomo", "sing", "hiddify", "nekobox", "outline", "amnezia", "zerotier", "hyper-v", "virtual", "loopback"]
            .iter()
            .any(|k| s.contains(k))
    };
    netdev::get_interfaces().into_iter().find_map(|i| {
        let label = format!("{} {} {}", i.name, i.friendly_name.clone().unwrap_or_default(), i.description.clone().unwrap_or_default());
        let has_gateway = i.gateway.as_ref().is_some_and(|g| g.ipv4.iter().any(|a| !a.is_unspecified()));
        if !i.is_up() || i.is_loopback() || !has_gateway || vpn(&label) || tunnel(&i.name) {
            return None;
        }
        i.ipv4.first().map(|n| (i.name.clone(), n.addr()))
    })
}

// Linux: у tun- и WireGuard-интерфейсов нет MAC-адреса (тип ARPHRD_NONE = 65534), как их ни назови
#[cfg(target_os = "linux")]
pub fn tunnel(name: &str) -> bool {
    std::fs::read_to_string(format!("/sys/class/net/{name}/type")).is_ok_and(|t| t.trim() == "65534")
}

#[cfg(not(target_os = "linux"))]
pub fn tunnel(_name: &str) -> bool {
    false
}
