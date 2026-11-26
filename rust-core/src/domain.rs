//! Deterministic workflow, risk and account decisions; no I/O or cryptography.
pub fn permission(role:u32,allowed:u32,independent:bool,actor:u32,legacy:u32,creator:u32,contributors:&[u32])->u32{
    if role==0 || !role.is_power_of_two() || role & allowed==0 { return 1; }
    if independent && (actor==creator || contributors.contains(&actor) ||
        (legacy!=0 && (legacy==creator || contributors.contains(&legacy)))) {return 2;}
    0
}
pub fn score(profile:u32,likelihood:u32,impact:u32,extras:u32)->Option<u32>{
    if !(1..=5).contains(&likelihood)||!(1..=5).contains(&impact){return None;}
    let (critical,high,moderate)=match profile{
        0 if extras==0=>(20,12,6),1 if matches!(extras,0|2|4)=>(22,14,7),_=>return None
    };
    let value=likelihood*impact+extras;
    let tier=if value>=critical{3}else if value>=high{2}else if value>=moderate{1}else{0};
    Some(value|(tier<<8))
}
pub fn link_status(flags:u32,review:u32)->u32{
    if flags&1!=0{0}else if flags&2==0{1}else if flags&4==0{2}else if flags&8!=0{3}
    else if review==1{4}else if review==2{5}else{6}
}
pub fn reductions(input:&[u8])->Option<u32>{
    if input.len()%2!=0{return None;}
    let (mut likelihood,mut impact)=(0,0);
    for pair in input.chunks_exact(2){
        if pair[0]>2||pair[1]>2{return None;}
        likelihood=likelihood.max(pair[0]);impact=impact.max(pair[1]);
    }
    Some(u32::from(likelihood)|(u32::from(impact)<<8))
}
pub fn account_live(disabled:bool,has_expiry:bool,now:f64,valid_until:f64)->bool{
    !disabled&&(!has_expiry||now<valid_until)
}
fn trim_ecma(c:char)->bool{
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|
        '\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub fn cookie<'a>(name:&str,header:&'a str)->Option<&'a str>{
    let mut found=None;
    for part in header.split(';').map(|x|x.trim_matches(trim_ecma)){
        if let Some(value)=part.strip_prefix(name).and_then(|x|x.strip_prefix('=')){
            if found.is_some(){return None;}
            found=Some(value);
        }
    }
    let token=found?;
    (token.len()==43&&token.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'_'|b'-'))).then_some(token)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn workflow_and_scores(){
        assert_eq!(permission(2,2,true,4,0,4,&[]),2);
        assert_eq!(permission(2,2,true,4,6,1,&[6]),2);
        assert_eq!(permission(1,2,false,4,0,1,&[]),1);
        assert_eq!(permission(2,2,true,4,0,1,&[3]),0);
        assert_eq!(score(0,4,5,0),Some(20|(3<<8)));
        assert_eq!(score(1,4,5,2),Some(22|(3<<8)));
        assert_eq!(score(1,0,5,2),None);
        assert_eq!(reductions(&[1,2,2,0]),Some(2|(2<<8)));
        assert_eq!(reductions(&[3,0]),None);
    }
    #[test]
    fn cookies_and_expiration(){
        let token="a".repeat(43);
        let header=format!("other=1; \u{feff}local={token} ; x=2");
        assert_eq!(cookie("local",&header),Some(token.as_str()));
        assert!(cookie("local",&format!("local={token}; local={token}")).is_none());
        assert!(!account_live(false,true,10.0,10.0));
        assert!(account_live(false,false,10.0,0.0));
        assert!(!account_live(true,false,10.0,0.0));
    }
}
