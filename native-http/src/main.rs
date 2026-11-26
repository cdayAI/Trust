//! Local synthetic HTTP transport. Hyper owns HTTP framing; the application
//! remains the authoritative policy/domain handler on a private Unix socket.
#![forbid(unsafe_code)]
#[cfg(not(unix))]
compile_error!("The native HTTP listener currently requires a Unix socket.");

use std::{convert::Infallible, io::{self, BufRead, Read, Write}, net::Ipv4Addr,
    path::{Path, PathBuf}, sync::Arc, time::Duration};
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{Request, Response, Method, StatusCode, Version, body::{Bytes, Incoming},
    header::{self, HeaderMap, HeaderValue}, server::conn::http1 as server,
    client::conn::http1 as client, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::{net::{TcpListener, UnixStream}, sync::{Semaphore, oneshot}, time::timeout};

const PRIVATE: &str = "x-mvw-trust-internal";
const MAX_CONNECTIONS: usize = 64;
const REQUEST_DEADLINE: Duration = Duration::from_secs(60);
type Body = UnsyncBoxBody<Bytes, hyper::Error>;

fn error(status: StatusCode, message: &'static str) -> Response<Body> {
    let body = Full::new(Bytes::from_static(message.as_bytes()))
        .map_err(|never| match never {}).boxed_unsync();
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"));
    response
}

fn valid_connection_headers(headers: &HeaderMap) -> bool {
    headers.get_all(header::CONNECTION).iter().all(|value| {
        value.to_str().is_ok_and(|value| value.split(',').all(|token| {
            matches!(token.trim().to_ascii_lowercase().as_str(), "close" | "keep-alive")
        }))
    })
}

fn remove_hop_headers(headers: &mut HeaderMap) {
    // Connection can nominate additional hop-by-hop headers. Drop them for
    // trusted backend responses as well as the fixed RFC header names.
    let names: Vec<_> = headers.get_all(header::CONNECTION).iter()
        .filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(','))
        .filter_map(|n| header::HeaderName::from_bytes(n.trim().as_bytes()).ok()).collect();
    for name in names { headers.remove(name); }
    for name in ["connection", "keep-alive", "proxy-connection", "proxy-authenticate",
        "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"] {
        headers.remove(name);
    }
}

fn valid_request(req: &Request<Incoming>) -> bool {
    let headers = req.headers();
    let uri = req.uri();
    req.method() != Method::CONNECT && req.version() == Version::HTTP_11
        && uri.scheme().is_none() && uri.authority().is_none()
        && uri.path().starts_with('/') && !uri.path().starts_with("//")
        && !uri.path().contains('\\')
        && headers.get_all(header::HOST).iter().count() == 1
        && !headers.contains_key(PRIVATE) && !headers.contains_key(header::UPGRADE)
        && !headers.contains_key(header::TRAILER)
        && !(headers.contains_key(header::TRANSFER_ENCODING) && headers.contains_key(header::CONTENT_LENGTH))
        && valid_connection_headers(headers)
}

async fn forward(mut req: Request<Incoming>, socket: Arc<PathBuf>, secret: HeaderValue)
    -> Result<Response<Body>, Infallible> {
    if !valid_request(&req) {
        return Ok(error(StatusCode::BAD_REQUEST, "{\"error\":\"Invalid local HTTP request.\"}\n"));
    }
    let backend = async {
        let stream = UnixStream::connect(socket.as_ref()).await.map_err(|_| ())?;
        let (mut send, connection) = client::handshake(TokioIo::new(stream)).await.map_err(|_| ())?;
        tokio::spawn(async move { let _ = connection.await; });
        remove_hop_headers(req.headers_mut());
        // Forwarded identity is never accepted from the browser. Preserve Host,
        // Origin, Cookie, Content-Type and all application headers unchanged.
        for name in ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "expect"] {
            req.headers_mut().remove(name);
        }
        req.headers_mut().insert(PRIVATE, secret);
        req.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
        let response = send.send_request(req).await.map_err(|_| ())?;
        let (mut parts, body) = response.into_parts();
        remove_hop_headers(&mut parts.headers);
        parts.headers.remove(PRIVATE);
        Ok::<_, ()>(Response::from_parts(parts, body.boxed_unsync()))
    };
    match timeout(REQUEST_DEADLINE, backend).await {
        Ok(Ok(response)) => Ok(response),
        _ => Ok(error(StatusCode::BAD_GATEWAY, "{\"error\":\"Local application unavailable.\"}\n")),
    }
}

fn input() -> io::Result<(PathBuf, u16, HeaderValue)> {
    let mut args = std::env::args_os().skip(1);
    let socket = PathBuf::from(args.next().ok_or(io::ErrorKind::InvalidInput)?);
    let port = args.next().and_then(|p| p.into_string().ok())
        .and_then(|p| p.parse::<u16>().ok()).ok_or(io::ErrorKind::InvalidInput)?;
    if args.next().is_some() || !Path::new(&socket).is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut token = String::new();
    // A private inherited pipe, not argv or an environment variable.
    io::stdin().lock().take(66).read_line(&mut token)?;
    let token = token.strip_suffix('\n').ok_or(io::ErrorKind::InvalidInput)?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let value = HeaderValue::from_str(token).map_err(|_| io::ErrorKind::InvalidInput)?;
    Ok((socket, port, value))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let (socket, port, secret) = input()?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    println!("{}", address.port());
    io::stdout().flush()?;
    let (closed, mut shutdown) = oneshot::channel();
    // EOF occurs even if the launcher is killed. Do not keep an orphan listener.
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        let _ = closed.send(());
    });
    let socket = Arc::new(socket);
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let (stream, peer) = accepted?;
                if !peer.ip().is_loopback() { continue; }
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue; };
                let socket = socket.clone();
                let secret = secret.clone();
                tokio::spawn(async move {
                    let _slot = slot;
                    let service = service_fn(move |req| forward(req, socket.clone(), secret.clone()));
                    let mut builder = server::Builder::new();
                    builder.keep_alive(false).max_buf_size(32*1024)
                        .timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10));
                    let _ = timeout(REQUEST_DEADLINE,
                        builder.serve_connection(TokioIo::new(stream), service)).await;
                });
            }
        }
    }
    Ok(())
}
