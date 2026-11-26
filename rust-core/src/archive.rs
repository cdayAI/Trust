//! Bounded ZIP layout inspection. No decompression or XML processing occurs here.
use std::collections::BTreeSet;

pub const MAX_ENTRIES: usize = 256;
pub const ENTRY_WORDS: usize = 12;
const MAX_PART: usize = 2 * 1024 * 1024;
const MAX_EXPANDED: usize = 8 * 1024 * 1024;
const MAX_ARCHIVE: usize = 4 * 1024 * 1024;

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at.checked_add(2)?)?.try_into().ok()?))
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at.checked_add(4)?)?.try_into().ok()?))
}
fn extra_ok(b: &[u8], mut at: usize, end: usize) -> Option<()> {
    if end.checked_sub(at)? > 512 || end > b.len() { return None; }
    while at < end {
        if at.checked_add(4)? > end { return None; }
        let kind = u16_at(b, at)?;
        let len = u16_at(b, at+2)? as usize;
        if matches!(kind,0x0001|0x7075|0x9901) { return None; }
        at = at.checked_add(4)?.checked_add(len)?;
        if at > end { return None; }
    }
    Some(())
}
fn valid_stem(stem: &[u8]) -> bool {
    !stem.is_empty() && stem.iter().all(|b| b.is_ascii_alphanumeric() ||
        matches!(*b,b' '|b'_'|b'.'|b'['|b']'|b'/'|b'-')) &&
        stem.split(|&b| b == b'/').all(|part| !part.is_empty() &&
            part.first() != Some(&b' ') && part.last() != Some(&b' ') &&
            !part.ends_with(b"."))
}

pub fn parse(b: &[u8]) -> Option<Vec<[u32; ENTRY_WORDS]>> {
    if b.len() > MAX_ARCHIVE { return None; }
    let finish = b.len().checked_sub(22)?;
    if finish < 30 || u32_at(b,finish)? != 0x06054b50 || !b.starts_with(b"PK\x03\x04")
        || u32_at(b,finish+4)? != 0 || u16_at(b,finish+20)? != 0 { return None; }
    let n = u16_at(b,finish+10)? as usize;
    let middle = u32_at(b,finish+16)? as usize;
    if n == 0 || n > MAX_ENTRIES || u16_at(b,finish+8)? as usize != n
        || middle >= finish || middle < 30
        || middle.checked_add(u32_at(b,finish+12)? as usize)? != finish { return None; }
    let mut folded = BTreeSet::new();
    let mut spans = Vec::with_capacity(n);
    let mut rows = Vec::with_capacity(n);
    let mut at = middle;
    let mut expanded = 0usize;
    for _ in 0..n {
        if at.checked_add(46)? > finish || u32_at(b,at)? != 0x02014b50 { return None; }
        let flags = u16_at(b,at+8)?;
        let method = u16_at(b,at+10)?;
        let crc = u32_at(b,at+16)?;
        let compressed = u32_at(b,at+20)? as usize;
        let size = u32_at(b,at+24)? as usize;
        let name_bytes = u16_at(b,at+28)? as usize;
        let extras = u16_at(b,at+30)? as usize;
        let comment = u16_at(b,at+32)? as usize;
        let unix_mode = (u32_at(b,at+38)? >> 16) & 0xf000;
        let loc = u32_at(b,at+42)? as usize;
        let name_at = at+46;
        let extra_at = name_at.checked_add(name_bytes)?;
        let next = extra_at.checked_add(extras)?.checked_add(comment)?;
        if next > finish || name_bytes == 0 || name_bytes > 180 || comment > 128
            || u16_at(b,at+34)? != 0 || !matches!(unix_mode,0|0x4000|0x8000)
            || flags & !0x080e != 0 || !matches!(method,0|8) || (method == 0 && flags & 6 != 0)
            || size > MAX_PART || compressed > middle || loc.checked_add(30)? > middle { return None; }
        expanded = expanded.checked_add(size)?;
        if expanded > MAX_EXPANDED { return None; }
        extra_ok(b,extra_at,extra_at+extras)?;
        let name = b.get(name_at..extra_at)?;
        let directory = name.ends_with(b"/");
        let stem = if directory { name.get(..name.len()-1)? } else { name };
        if !valid_stem(stem) || !folded.insert(stem.to_ascii_lowercase())
            || (directory && (size != 0 || unix_mode == 0x8000))
            || (!directory && (size == 0 || unix_mode == 0x4000)) { return None; }
        if u32_at(b,loc)? != 0x04034b50 || u16_at(b,loc+6)? != flags
            || u16_at(b,loc+8)? != method || u16_at(b,loc+26)? as usize != name_bytes { return None; }
        let local_name = loc+30;
        let local_extra = local_name.checked_add(name_bytes)?;
        let local_extras = u16_at(b,loc+28)? as usize;
        let start = local_extra.checked_add(local_extras)?;
        let end = start.checked_add(compressed)?;
        if end > middle || b.get(local_name..local_extra)? != name { return None; }
        extra_ok(b,local_extra,start)?;
        for (offset,val) in [(14,crc),(18,compressed as u32),(22,size as u32)] {
            let local = u32_at(b,loc+offset)?;
            if local != val && !(flags & 8 != 0 && local == 0) { return None; }
        }
        let mut data_end = end;
        if flags & 8 != 0 {
            if data_end.checked_add(4)? <= middle && u32_at(b,data_end)? == 0x08074b50 { data_end += 4; }
            if data_end.checked_add(12)? > middle || u32_at(b,data_end)? != crc
                || u32_at(b,data_end+4)? as usize != compressed || u32_at(b,data_end+8)? as usize != size { return None; }
            data_end += 12;
        }
        if method == 0 && compressed != size { return None; }
        spans.push((loc,data_end));
        rows.push([name_at as u32,extra_at as u32,directory as u32,loc as u32,
            method as u32,flags as u32,local_extras as u32,extras as u32,
            start as u32,end as u32,size as u32,crc]);
        at = next;
    }
    spans.sort_unstable_by_key(|span| span.0);
    let mut covered = 0;
    for (start,end) in spans {
        if start != covered { return None; }
        covered = end;
    }
    if at != finish || covered != middle { return None; }
    Some(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_archives_and_unsafe_names_fail_closed() {
        for length in 0..100 { assert!(parse(&vec![0xff;length]).is_none()); }
        for stem in [b"../doc.xml".as_slice(),b"a//b",b"a/.",b"a/ b",b"a/abc."] {
            assert!(!valid_stem(stem));
        }
        assert!(valid_stem(b"word/_rels/document.xml.rels"));
    }
}
