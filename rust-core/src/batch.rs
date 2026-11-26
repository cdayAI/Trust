//! Binary batch framing and contiguous byte ranges; JSON fields remain in Node.
pub const MAX_FILES: usize = 4;
const MAX_MANIFEST: u32 = 4096;
const MAX_BYTES: u32 = 4 * 1024 * 1024;
const REQUEST_LIMIT: u32 = 4 + MAX_MANIFEST + MAX_BYTES;
pub const INVALID: i32 = -1;
pub const TOO_LARGE: i32 = -2;

pub fn header(frame_len: u32, bytes: &[u8]) -> i32 {
    if frame_len < 5 { return INVALID; }
    if frame_len > REQUEST_LIMIT { return TOO_LARGE; }
    let size = match bytes.try_into() {
        Ok(raw) => u32::from_be_bytes(raw),
        Err(_) => return INVALID,
    };
    if size == 0 || size > MAX_MANIFEST || 4+size > frame_len { return INVALID; }
    size as i32
}

pub fn layout(frame_len: u32, manifest: u32, sizes: &[u32]) -> Result<Vec<u32>,i32> {
    if frame_len > REQUEST_LIMIT { return Err(TOO_LARGE); }
    if sizes.is_empty() || sizes.len() > MAX_FILES || manifest == 0 || manifest > MAX_MANIFEST {
        return Err(INVALID);
    }
    let mut offset = 4+manifest;
    let mut total = 0;
    let mut offsets = Vec::with_capacity(sizes.len());
    for &size in sizes {
        if size > MAX_BYTES || offset > frame_len || size > frame_len-offset { return Err(INVALID); }
        total += size;
        if total > MAX_BYTES { return Err(TOO_LARGE); }
        offsets.push(offset);
        offset += size;
    }
    if offset != frame_len { return Err(INVALID); }
    Ok(offsets)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_bounds_and_exact_payload() {
        assert_eq!(header(12,&[0,0,0,4]),4);
        assert_eq!(header(6,&[0,0,0,4]),INVALID);
        assert_eq!(header(REQUEST_LIMIT+1,&[0,0,0,4]),TOO_LARGE);
        assert_eq!(layout(12,4,&[1,3]),Ok(vec![8,9]));
        assert_eq!(layout(12,4,&[1,2]),Err(INVALID));
        assert_eq!(layout(12,4,&[u32::MAX]),Err(INVALID));
        assert_eq!(layout(REQUEST_LIMIT,4095,&[MAX_BYTES,1]),Err(TOO_LARGE));
    }
}
