//! Storage-format validation only. SQLite, filesystem I/O and authenticated
//! encryption remain host responsibilities. Never handle encryption keys.
const MAX_FILE_BYTES:u32=128*1024*1024;
const MAX_SAFE:f64=9_007_199_254_740_991.0;

// 0 invalid; 1 demo; 2 isolated. Scope strings are intentionally ASCII.
pub fn scope(value:&[u8])->u32{
    if value==b"demo"{return 1;}
    let Some(id)=value.strip_prefix(b"workspace:")else{return 0;};
    if id.is_empty()||id.len()>48||!id[0].is_ascii_lowercase()||
        !id.iter().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||*b==b'-'){return 0;}
    2
}
pub fn positive_generation(value:f64)->bool{
    value.is_finite()&&value.fract()==0.0&&value>0.0&&value<=MAX_SAFE
}
// kind=1 workbench, 2 workflow. The host encodes the presence of each
// required JSON array in the fixed schema order, never the record contents.
pub fn payload_shape(kind:u32,version:f64,arrays:u32)->bool{
    version==1.0&&match kind{1=>arrays==0b11_1111,2=>arrays==0b111,_=>false}
}
// Returns plaintext length only after exact envelope framing is verified.
// GCM authentication remains mandatory before the host reads any plaintext.
pub fn encrypted_size(header:&[u8],archive_size:f64)->Option<u32>{
    if header.len()!=26||header.get(..8)?!=b"MVWTRSTE"||header[8]!=1||header[9]!=1{return None;}
    let length=u32::from_be_bytes(header.get(22..26)?.try_into().ok()?);
    if length==0||length>MAX_FILE_BYTES||archive_size!=f64::from(length)+42.0{return None;}
    Some(length)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn scope_generation_and_schema(){
        assert_eq!(scope(b"demo"),1);
        assert_eq!(scope(b"workspace:alpha-1"),2);
        for value in [b"workspace:".as_slice(),b"workspace:Alpha",b"workspace:a/../b",b"workspace:a\n"]{
            assert_eq!(scope(value),0);
        }
        assert!(!positive_generation(0.0));
        assert!(!positive_generation(1.5));
        assert!(!positive_generation(MAX_SAFE+1.0));
        assert!(positive_generation(MAX_SAFE));
        assert!(payload_shape(1,1.0,63));
        assert!(!payload_shape(1,1.0,31));
        assert!(payload_shape(2,1.0,7));
        assert!(!payload_shape(2,2.0,7));
    }
    #[test]
    fn backup_exact_framing(){
        let mut header=[0u8;26];header[..8].copy_from_slice(b"MVWTRSTE");header[8]=1;header[9]=1;
        header[22..].copy_from_slice(&123u32.to_be_bytes());
        assert_eq!(encrypted_size(&header,165.0),Some(123));
        assert_eq!(encrypted_size(&header,166.0),None);
        assert_eq!(encrypted_size(&header[..25],165.0),None);
        header[9]=2;assert_eq!(encrypted_size(&header,165.0),None);
        header[9]=1;header[22..].copy_from_slice(&(MAX_FILE_BYTES+1).to_be_bytes());
        assert_eq!(encrypted_size(&header,f64::from(MAX_FILE_BYTES)+43.0),None);
    }
}
