//! Structural allowlist checks; not a renderer, decoder, or malware scanner.
const INVALID: u32 = 0;
const VALID: u32 = 1;
const WEBP_PROFILE: u32 = 2;

fn bytes<const N: usize>(b: &[u8], at: usize) -> Option<[u8; N]> {
    b.get(at..at.checked_add(N)?)?.try_into().ok()
}
fn le16(b: &[u8], at: usize) -> Option<u16> { Some(u16::from_le_bytes(bytes(b, at)?)) }
fn be16(b: &[u8], at: usize) -> Option<u16> { Some(u16::from_be_bytes(bytes(b, at)?)) }
fn le32(b: &[u8], at: usize) -> Option<u32> { Some(u32::from_le_bytes(bytes(b, at)?)) }
fn be32(b: &[u8], at: usize) -> Option<u32> { Some(u32::from_be_bytes(bytes(b, at)?)) }
fn le24(b: &[u8], at: usize) -> Option<u32> {
    let [a,c,d] = bytes(b, at)?;
    Some(u32::from_le_bytes([a,c,d,0]))
}
fn bounds(w: u32, h: u32) -> bool {
    w > 0 && h > 0 && w <= 20_000 && h <= 20_000 && u64::from(w)*u64::from(h) <= 50_000_000
}
const fn crc_table() -> [u32; 256] {
    let mut table = [0; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut k = 0;
        while k < 8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb88320 } else { crc >> 1 };
            k += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}
const CRC_TABLE: [u32; 256] = crc_table();
fn crc32(b: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &v in b { crc = CRC_TABLE[((crc ^ u32::from(v)) & 255) as usize] ^ (crc >> 8); }
    !crc
}

fn png(b: &[u8]) -> Option<()> {
    if b.len() < 45 || !b.starts_with(b"\x89PNG\r\n\x1a\n") { return None; }
    let mut at = 8usize;
    let mut idat = false;
    for count in 1..=1024 {
        if at.checked_add(12)? > b.len() { return None; }
        let len = be32(b, at)? as usize;
        let end = at.checked_add(8)?.checked_add(len)?;
        let chunk_end = end.checked_add(4)?;
        let kind: [u8; 4] = bytes(b, at + 4)?;
        if chunk_end > b.len() || !kind.iter().all(u8::is_ascii_alphabetic)
            || crc32(b.get(at+4..end)?) != be32(b, end)? { return None; }
        if count == 1 && (kind != *b"IHDR" || len != 13 || !bounds(be32(b, at+8)?,be32(b,at+12)?)) { return None; }
        if count != 1 && kind == *b"IHDR" { return None; }
        if kind == *b"IDAT" && len > 0 { idat = true; }
        if kind == *b"IEND" { return (idat && len == 0 && chunk_end == b.len()).then_some(()); }
        at = chunk_end;
    }
    None
}

fn jpeg(b: &[u8]) -> Option<()> {
    if b.len() < 16 || !b.starts_with(&[0xff,0xd8]) || !b.ends_with(&[0xff,0xd9]) { return None; }
    let mut at = 2usize;
    let mut frame = false;
    while at + 4 < b.len() {
        if *b.get(at)? != 0xff { return None; }
        at += 1;
        while b.get(at) == Some(&0xff) { at += 1; }
        let marker = *b.get(at)?;
        at += 1;
        if matches!(marker,0|0xd8|0xd9) || at+2 >= b.len() { return None; }
        let len = be16(b,at)? as usize;
        if len < 2 || at.checked_add(len)? >= b.len()-2 { return None; }
        if matches!(marker,0xc0..=0xc2) {
            if len < 8 || !bounds(be16(b,at+5)? as u32,be16(b,at+3)? as u32) { return None; }
            frame = true;
        }
        if marker == 0xda { return (frame && len >= 6).then_some(()); }
        at += len;
    }
    None
}

fn subblocks(b: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let len = *b.get(at)? as usize;
        at += 1;
        if len == 0 { return Some(at); }
        at = at.checked_add(len)?;
        if at > b.len() { return None; }
    }
}
fn gif(b: &[u8]) -> Option<()> {
    if b.len() < 14 || !(b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a"))
        || !bounds(le16(b,6)? as u32,le16(b,8)? as u32) { return None; }
    let mut at = 13usize;
    let mut images = 0;
    if b[10] & 128 != 0 { at += 3 * (1usize << ((b[10] & 7) + 1)); }
    while at < b.len() {
        let kind = b[at];
        at += 1;
        match kind {
            0x3b => return (images > 0 && at == b.len()).then_some(()),
            0x21 => {
                b.get(at)?;
                at = subblocks(b, at+1)?;
            }
            0x2c => {
                if at + 10 >= b.len() || !bounds(le16(b,at+4)? as u32,le16(b,at+6)? as u32) { return None; }
                let flags = *b.get(at+8)?;
                at += 9;
                if flags & 128 != 0 { at += 3 * (1usize << ((flags & 7) + 1)); }
                if !(2..=8).contains(b.get(at)?) { return None; }
                at = subblocks(b, at+1)?;
                images += 1;
            }
            _ => return None,
        }
    }
    None
}

fn webp(b: &[u8]) -> Option<u32> {
    if b.len() < 25 || !b.starts_with(b"RIFF") || b.get(8..12)? != b"WEBP" || le32(b,4)? as usize != b.len()-8 { return None; }
    let mut at = 12usize;
    let mut image = false;
    for _ in 0..1024 {
        if at + 8 > b.len() { break; }
        let tag: [u8;4] = bytes(b,at)?;
        let len = le32(b,at+4)? as usize;
        let start = at+8;
        let end = start.checked_add(len)?;
        let padded = end.checked_add(len%2)?;
        if padded > b.len() || (len%2 != 0 && b.get(end) != Some(&0)) { return None; }
        match &tag {
            b"VP8 " => {
                if len < 11 || b.get(start+3..start+6)? != [0x9d,0x01,0x2a]
                    || !bounds((le16(b,start+6)? & 0x3fff) as u32,(le16(b,start+8)? & 0x3fff) as u32) { return None; }
                image = true;
            }
            b"VP8L" => {
                if len < 6 || b.get(start) != Some(&0x2f) { return None; }
                let details = le32(b,start+1)?;
                if details >> 29 != 0 || !bounds((details & 0x3fff)+1,((details >> 14)&0x3fff)+1) { return None; }
                image = true;
            }
            b"VP8X" => {
                if len != 10 || at != 12 || *b.get(start)? & 2 != 0
                    || !bounds(le24(b,start+4)?+1,le24(b,start+7)?+1) { return Some(WEBP_PROFILE); }
            }
            b"ALPH" | b"ICCP" | b"EXIF" | b"XMP " => {},
            _ => return None,
        }
        at = padded;
    }
    (image && at == b.len()).then_some(VALID)
}

fn bmp(b: &[u8]) -> Option<()> {
    if b.len() < 54 || !b.starts_with(b"BM") || le32(b,2)? as usize != b.len() || le32(b,6)? != 0 { return None; }
    let offset = u64::from(le32(b,10)?);
    let header = le32(b,14)?;
    let width = i32::from_le_bytes(bytes(b,18)?);
    let height = i32::from_le_bytes(bytes(b,22)?).unsigned_abs();
    let planes = le16(b,26)?;
    let bits = le16(b,28)?;
    if width <= 0 || !matches!(header,40|108|124) || offset < 14+u64::from(header)
        || !bounds(width as u32,height) || planes != 1 || !matches!(bits,1|4|8|16|24|32)
        || le32(b,30)? != 0 { return None; }
    let stride = 4 * (u64::from(width as u32)*u64::from(bits)).div_ceil(32);
    (offset+stride*u64::from(height) == b.len() as u64).then_some(())
}

fn tiff(b: &[u8]) -> Option<()> {
    if b.len() < 14 { return None; }
    let little = b.starts_with(b"II\x2a\x00");
    if !little && !b.starts_with(b"MM\x00\x2a") { return None; }
    let u16_at = |at| if little { le16(b,at) } else { be16(b,at) };
    let u32_at = |at| if little { le32(b,at) } else { be32(b,at) };
    let widths: [u64;13] = [0,1,1,2,4,8,1,1,2,4,8,4,8];
    let mut at = u32_at(4)? as usize;
    let mut images = 0;
    while at != 0 && images < 32 {
        images += 1;
        if at < 8 || at.checked_add(6)? > b.len() || at%2 != 0 { return None; }
        let n = u16_at(at)? as usize;
        let end = at.checked_add(2)?.checked_add(n*12)?;
        if n == 0 || n > 256 || end.checked_add(4)? > b.len() { return None; }
        let (mut width,mut height,mut pixels) = (0,0,false);
        for i in (at+2..end).step_by(12) {
            let tag = u16_at(i)?;
            let kind = u16_at(i+2)?;
            let items = u32_at(i+4)?;
            let size = u64::from(items)*widths.get(kind as usize)?;
            if size == 0 || size > b.len() as u64 { return None; }
            if size > 4 {
                let offset = u64::from(u32_at(i+8)?);
                if offset < 8 || offset+size > b.len() as u64 { return None; }
            }
            if items == 1 && matches!(kind,3|4) {
                let datum = if kind == 3 { u16_at(i+8)? as u32 } else { u32_at(i+8)? };
                if tag == 256 { width = datum; }
                if tag == 257 { height = datum; }
            }
            if matches!(tag,273|324) && matches!(kind,3|4) {
                let start = if size <= 4 { i+8 } else { u32_at(i+8)? as usize };
                if items > 8192 { return None; }
                for j in 0..items as usize {
                    let pixel = if kind == 3 { u16_at(start+j*2)? as u32 } else { u32_at(start+j*4)? };
                    if pixel < 8 || pixel as usize >= b.len() { return None; }
                }
                pixels = true;
            }
        }
        if !pixels || !bounds(width,height) { return None; }
        let next = u32_at(end)? as usize;
        if next != 0 && next <= at { return None; }
        at = next;
    }
    (images > 0 && at == 0).then_some(())
}

pub fn inspect(kind: u32, b: &[u8]) -> u32 {
    if b.len() > 1024*1024 { return INVALID; }
    if kind == 4 { return webp(b).unwrap_or(INVALID); }
    let result = match kind {
        1 => png(b), 2 => jpeg(b), 3 => gif(b), 5 => bmp(b), 6 => tiff(b), _ => None,
    };
    if result.is_some() { VALID } else { INVALID }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn standard_crc_and_short_inputs() {
        assert_eq!(crc32(b"123456789"),0xcbf43926);
        for kind in 0..=7 {
            for length in 0..128 { assert_eq!(inspect(kind,&vec![0xff;length]),INVALID); }
        }
    }
}
