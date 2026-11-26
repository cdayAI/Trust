//! Pure workflow mutation planning and questionnaire validation.
//! Strings use UTF-16 code units to preserve JavaScript length and trim semantics,
//! including unpaired surrogates. The host retains record storage and event I/O.
use std::collections::BTreeSet;
use crate::domain;

const MAX_FIELDS:usize=20;
const MAX_SAFE:f64=9_007_199_254_740_991.0;
const NULL:u32=u32::MAX;

struct Reader<'a>{bytes:&'a [u8],at:usize}
impl<'a> Reader<'a>{
    fn new(bytes:&'a [u8])->Self{Self{bytes,at:0}}
    fn take(&mut self,n:usize)->Option<&'a [u8]>{
        let end=self.at.checked_add(n)?;
        let part=self.bytes.get(self.at..end)?;
        self.at=end;
        Some(part)
    }
    fn word(&mut self)->Option<u32>{Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))}
    fn units(&mut self)->Option<Vec<u16>>{
        let len=self.word()?;
        if len==NULL{return None;}
        let part=self.take((len as usize).checked_mul(2)?)?;
        Some(part.chunks_exact(2).map(|c|u16::from_le_bytes([c[0],c[1]])).collect())
    }
    fn done(&self)->bool{self.at==self.bytes.len()}
}

fn white(x:u16)->bool{
    matches!(x,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|
        0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn trim(value:&[u16])->(usize,usize){
    let start=value.iter().position(|&x|!white(x)).unwrap_or(value.len());
    let end=value.iter().rposition(|&x|!white(x)).map(|n|n+1).unwrap_or(start);
    (start,end)
}
fn lower(x:u16)->bool{(0x61..=0x7a).contains(&x)}
fn digit(x:u16)->bool{(0x30..=0x39).contains(&x)}
fn ascii_equal(value:&[u16],text:&[u8])->bool{
    value.len()==text.len()&&value.iter().zip(text).all(|(&a,&b)|a==u16::from(b))
}
fn field_key(value:&[u16])->bool{
    !value.is_empty()&&value.len()<=64&&lower(value[0])&&
        value.iter().all(|&x|lower(x)||(0x41..=0x5a).contains(&x)||digit(x)||x==0x5f)&&
        ![b"constructor".as_slice(),b"prototype",b"__proto__"].iter().any(|s|ascii_equal(value,s))
}
fn integer(value:&[u16])->bool{
    if value==[0x30]{return true;}
    let digits=if value.first()==Some(&0x2d){&value[1..]}else{value};
    !digits.is_empty()&&digits.len()<=9&&(0x31..=0x39).contains(&digits[0])&&digits.iter().all(|&x|digit(x))
}

// 0 accepted; 1 invalid expected revision; 2 stale; 3 invalid stored revision.
pub fn revision(expected:f64,actual:f64,min:u32)->u32{
    let valid=|v:f64|v.is_finite()&&v.fract()==0.0&&v>=f64::from(min)&&v<=MAX_SAFE;
    if !valid(expected){1}else if !valid(actual){3}else if expected!=actual{2}else{0}
}

pub struct Plan{pub status:u32,pub missing:u32,pub ranges:Vec<(u32,u32)>,pub contributors:Vec<u32>}
fn refused(status:u32)->Plan{Plan{status,missing:0,ranges:Vec::new(),contributors:Vec::new()}}

// status: 1 unavailable, 2 role, 3 independence, 4 invalid fields, 5 missing.
// The only successful output is a complete transition plan.
pub fn plan(input:&[u8],available:bool,role:u32,allowed:u32,independent:bool,
    actor:u32,legacy:u32,creator:u32)->Option<Plan>{
    let mut reader=Reader::new(input);
    let n=reader.word()? as usize;
    if n>1_000_000||n>input.len()/4{return None;}
    let mut contributors=Vec::with_capacity(n);
    for _ in 0..n{contributors.push(reader.word()?);}
    if !available{return Some(refused(1));}
    let permission=domain::permission(role,allowed,independent,actor,legacy,creator,&contributors);
    if permission!=0{return Some(refused(permission+1));}
    let count=reader.word()? as usize;
    let required=reader.word()? as usize;
    if count>MAX_FIELDS{return Some(refused(4));}
    if required>MAX_FIELDS{return None;}
    let mut keys=BTreeSet::new();
    let mut ranges=Vec::with_capacity(count);
    for _ in 0..count{
        let Some(key)=reader.units()else{return Some(refused(4));};
        let Some(value)=reader.units()else{return Some(refused(4));};
        if !field_key(&key)||!keys.insert(key){return Some(refused(4));}
        let (start,end)=trim(&value);
        if start==end||end-start>2000{return Some(refused(4));}
        ranges.push((start as u32,end as u32));
    }
    let mut missing=0;
    for i in 0..required{
        let key=reader.units()?;
        if !field_key(&key){return None;}
        if !keys.contains(&key){missing|=1<<i;}
    }
    if !reader.done(){return None;}
    if missing!=0{
        let mut result=refused(5);result.missing=missing;return Some(result);
    }
    if independent{contributors.clear();}
    else{
        let mut seen=BTreeSet::new();
        contributors.push(actor);
        contributors.retain(|id|seen.insert(*id));
    }
    Some(Plan{status:0,missing:0,ranges,contributors})
}

// flags: active=1, explicitly updated=2, required=4, submitting=8.
// status: 0 accepted, 1 hidden input, 2 invalid text, 3 invalid integer,
// 4 invalid choice, 5 missing required answer, 6 inactive branch.
pub fn answer(input:&[u8],flags:u32,kind:u32)->Option<(u32,u32,u32)>{
    let mut reader=Reader::new(input);
    let len=reader.word()?;
    let value=if len==NULL{None}else{
        Some(reader.take((len as usize).checked_mul(2)?)?.chunks_exact(2)
            .map(|c|u16::from_le_bytes([c[0],c[1]])).collect::<Vec<_>>())
    };
    if flags&1==0{
        return Some((if flags&2!=0&&len!=0{1}else{6},0,0));
    }
    let Some(value)=value else{return Some((2,0,0));};
    if value.len()>2000{return Some((2,0,0));}
    let (start,end)=trim(&value);
    let trimmed=&value[start..end];
    if kind==1&&!trimmed.is_empty()&&!integer(trimmed){return Some((3,0,0));}
    let n=reader.word()? as usize;
    if n>input.len()/4{return None;}
    let mut match_choice=false;
    for _ in 0..n{
        if reader.units()?.as_slice()==trimmed{match_choice=true;}
    }
    if !reader.done(){return None;}
    if kind==2&&!trimmed.is_empty()&&!match_choice{return Some((4,0,0));}
    if flags&4!=0&&flags&8!=0&&trimmed.is_empty(){return Some((5,0,0));}
    Some((0,start as u32,end as u32))
}

#[cfg(test)]
mod tests{
    use super::*;
    fn words(out:&mut Vec<u8>,values:&[u32]){for x in values{out.extend(x.to_le_bytes());}}
    fn string(out:&mut Vec<u8>,value:&str){
        let units:Vec<u16>=value.encode_utf16().collect();
        words(out,&[units.len() as u32]);for x in units{out.extend(x.to_le_bytes());}
    }
    #[test]
    fn workflow_plan_permissions_fields_and_contributors(){
        let mut input=Vec::new();
        words(&mut input,&[2,3,3,1,1]);
        string(&mut input,"reason");string(&mut input,"\u{feff}Yes 😀 \u{00a0}");string(&mut input,"reason");
        let result=plan(&input,true,2,2,false,4,0,1).unwrap();
        assert_eq!(result.status,0);assert_eq!(result.ranges,vec![(1,7)]);
        assert_eq!(result.contributors,vec![3,4]);
        let reviewed=plan(&input,true,2,2,true,4,0,1).unwrap();
        assert!(reviewed.contributors.is_empty());
        assert_eq!(plan(&input,true,2,2,true,4,3,1).unwrap().status,3);
        assert_eq!(plan(&input,false,2,2,false,4,0,1).unwrap().status,1);
    }
    #[test]
    fn questionnaire_utf16_and_revision_bounds(){
        let mut input=Vec::new();string(&mut input," -123 ");words(&mut input,&[0]);
        assert_eq!(answer(&input,1,1),Some((0,1,5)));
        assert_eq!(answer(&input,2,1),Some((1,0,0)));
        assert_eq!(revision(2.0,1.0,1),2);
        assert_eq!(revision(f64::NAN,1.0,1),1);
        assert_eq!(revision(1.0,f64::INFINITY,1),3);
    }
}
