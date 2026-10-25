// Обход VPN для своего сервера (split tunneling).
// VPN в режиме TUN (Happ, Clash и т.п.) часто теряет соединения к нашему серверу. WebView2 не умеет
// выбирать сетевую карту, поэтому домены сервера отображаются на локальный адрес, а здесь каждое
// TCP-соединение пересылается на сервер с сокета, привязанного к физическому адаптеру — мимо туннеля.
// TLS сквозной: мы только перекладываем байты, SNI и сертификат остаются как есть.
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::time::timeout;

pub const DOMAINS: [&str; 2] = ["185-218-0-111.sslip.io", "turn.185-218-0-111.sslip.io"];
const SERVER: SocketAddr = SocketAddr::new(std::net::IpAddr::V4(Ipv4Addr::new(185, 218, 0, 111)), 443);

/// Запускает пересылку и возвращает адрес, на который отображать домены сервера.
pub async fn start() -> String {
    // Каждому запущенному экземпляру — свой loopback-адрес; всё занято — хотя бы без DNS
    let mut bound = None;
    for n in 1..=20u8 {
        let local = SocketAddr::new(Ipv4Addr::new(127, 83, 0, n).into(), 443);
        if let Ok(l) = TcpListener::bind(local).await {
            bound = Some((l, local));
            break;
        }
    }
    let Some((listener, local)) = bound else {
        return SERVER.ip().to_string();
    };
    tauri::async_runtime::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            tauri::async_runtime::spawn(async move {
                if let Ok(mut upstream) = connect().await {
                    let mut client = client;
                    let _ = client.set_nodelay(true);
                    let _ = upstream.set_nodelay(true);
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                }
            });
        }
    });
    local.ip().to_string()
}

async fn connect() -> std::io::Result<TcpStream> {
    // Сначала напрямую через физический адаптер; не вышло за 3 с — обычным путём (в т.ч. через VPN)
    if let Some(ip) = physical_ipv4() {
        let socket = TcpSocket::new_v4()?;
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

/// IPv4 первого поднятого не-VPN адаптера со шлюзом (Ethernet / Wi-Fi).
fn physical_ipv4() -> Option<Ipv4Addr> {
    let vpn = |s: &str| {
        let s = s.to_lowercase();
        ["tun", "tap", "vpn", "wireguard", "xray", "v2ray", "happ", "clash", "mihomo", "sing", "hiddify", "nekobox", "outline", "amnezia", "zerotier", "hyper-v", "virtual", "loopback"]
            .iter()
            .any(|k| s.contains(k))
    };
    netdev::get_interfaces().into_iter().find_map(|i| {
        let label = format!("{} {} {}", i.name, i.friendly_name.clone().unwrap_or_default(), i.description.clone().unwrap_or_default());
        let has_gateway = i.gateway.as_ref().is_some_and(|g| g.ipv4.iter().any(|a| !a.is_unspecified()));
        if !i.is_up() || i.is_loopback() || !has_gateway || vpn(&label) {
            return None;
        }
        i.ipv4.first().map(|n| n.addr())
    })
}
