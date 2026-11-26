//! Local HTTP policy. The host still owns sockets, TLS, parsing, and I/O.
//! Only bounded request-envelope strings are passed into this module.
use std::str;

const MAX_FIELD: usize = 32 * 1024;
fn fields<const N: usize>(bytes: &[u8]) -> Option<[&str; N]> {
    let mut result = [""; N];
    let mut remaining = bytes;
    for value in &mut result {
        let len = u32::from_le_bytes(remaining.get(..4)?.try_into().ok()?) as usize;
        remaining = remaining.get(4..)?;
        if len > MAX_FIELD { return None; }
        *value = str::from_utf8(remaining.get(..len)?).ok()?;
        remaining = remaining.get(len..)?;
    }
    remaining.is_empty().then_some(result)
}

fn local_host(host: &str) -> bool {
    ["127.0.0.1", "localhost", "[::1]"].iter().any(|name| {
        let Some(prefix) = host.get(..name.len()) else { return false; };
        if !prefix.eq_ignore_ascii_case(name) { return false; }
        let rest = &host[name.len()..];
        if rest.is_empty() { return true; }
        rest.strip_prefix(':').is_some_and(|port|
            (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit()))
    })
}

// 0 permitted; 1 non-loopback connection/host; 2 corporate origin mismatch;
// 255 malformed ABI input.
pub fn connection(input: &[u8], flags: u32) -> u32 {
    if flags & !7 != 0 { return 255; }
    let Some([remote, host, target, corporate_host]) = fields::<4>(input) else { return 255; };
    if !matches!(remote, "127.0.0.1" | "::1" | "::ffff:127.0.0.1") { return 1; }
    if flags & 1 != 0 {
        let encrypted = flags & 2 != 0;
        let secure = flags & 4 != 0;
        if host != corporate_host || encrypted != secure || !target.starts_with('/')
            || target.starts_with("//") || target.contains('\\') {
            return 2;
        }
    } else if !local_host(host) {
        return 1;
    }
    0
}

fn js_space(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn json_media_type(value: &str) -> bool {
    const PREFIX: &str = "application/json";
    let Some(prefix) = value.get(..PREFIX.len()) else { return false; };
    if !prefix.eq_ignore_ascii_case(PREFIX) { return false; }
    let rest = &value[PREFIX.len()..];
    rest.is_empty() || rest.trim_start_matches(js_space).starts_with(';')
}

fn origin_matches(origin: &str, host: &str, scheme: &str) -> bool {
    origin.strip_prefix(scheme).is_some_and(|value| value == host)
}

// 0 permitted; 1 cross-origin; 2 wrong binary media/encoding; 3 wrong JSON
// media; 255 malformed ABI input. Keep the host's status and messages intact.
pub fn post(input: &[u8], flags: u32) -> u32 {
    if flags & !7 != 0 { return 255; }
    let Some([host, origin, corporate_origin, content_type, content_encoding, binary_type]) =
        fields::<6>(input) else { return 255; };
    let isolated = flags & 1 != 0;
    let corporate = flags & 2 != 0;
    let binary = flags & 4 != 0;
    let http = origin_matches(origin, host, "http://");
    let https = origin_matches(origin, host, "https://");
    let expected = if corporate { origin == corporate_origin } else { http };
    if isolated && !expected || !origin.is_empty() && !http && !https { return 1; }
    if binary {
        if content_type != binary_type || !content_encoding.is_empty() { return 2; }
    } else if !json_media_type(content_type) {
        return 3;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(values: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        for value in values {
            buf.extend_from_slice(&(value.len() as u32).to_le_bytes());
            buf.extend_from_slice(value.as_bytes());
        }
        buf
    }
    #[test]
    fn peer_and_origin_policy() {
        for host in ["localhost", "LOCALHOST:1234", "[::1]:443", "127.0.0.1:0"] {
            assert_eq!(connection(&encode(&["::1", host, "/", ""]), 0), 0);
        }
        for host in ["localhost.evil", "localhost:", "127.0.0.1:123456", "localhost\n", "[::2]"] {
            assert_eq!(connection(&encode(&["::1", host, "/", ""]), 0), 1);
        }
        assert_eq!(connection(&encode(&["192.0.2.1", "localhost", "/", ""]), 0), 1);
        for target in ["//remote", "/\\remote", "https://localhost/"] {
            assert_eq!(connection(&encode(&["127.0.0.1", "local.example", target, "local.example"]), 7), 2);
        }
        assert_eq!(connection(&encode(&["127.0.0.1", "local.example", "/api/state", "local.example"]), 7), 0);
        assert_eq!(connection(&encode(&["127.0.0.1", "local.example", "/", "local.example"]), 5), 2);
    }
    #[test]
    fn post_policy_and_malformed_envelopes() {
        let body = |origin, kind, encoding| encode(&["localhost:3000", origin, "", kind, encoding, "application/vnd.mvw"]);
        assert_eq!(post(&body("", "application/json", ""), 0), 0);
        assert_eq!(post(&body("", "application/json", ""), 1), 1);
        assert_eq!(post(&body("http://localhost:3000", "APPLICATION/JSON\u{feff}; charset=utf-8", ""), 1), 0);
        assert_eq!(post(&body("http://localhost:3000", "application/json ", ""), 1), 3);
        assert_eq!(post(&body("https://localhost:3000", "application/vnd.mvw", ""), 4), 0);
        assert_eq!(post(&body("https://localhost:3000", "application/vnd.mvw", "gzip"), 4), 2);
        assert_eq!(post(&body("http://remote.invalid", "text/plain", ""), 0), 1);
        assert_eq!(post(&[255; 4], 0), 255);
        assert_eq!(connection(&[0; 17], 0), 255);
    }
}
