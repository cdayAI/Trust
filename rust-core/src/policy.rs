//! Exact segment route matching and workspace role decisions.
use std::cell::RefCell;

#[derive(Clone,Debug)]
enum Segment{Literal(String),Uuid,Key,Version,Task}
#[derive(Clone,Debug)]
struct Rule{method:u32,roles:u32,segments:Vec<Segment>}
thread_local!{static RULES:RefCell<Vec<Rule>>=const{RefCell::new(Vec::new())};}

fn hex(value:&[u8])->bool{value.iter().all(|b|b.is_ascii_digit()||matches!(*b,b'a'..=b'f'))}
fn uuid(value:&str)->bool{
    let bytes=value.as_bytes();
    bytes.len()==36&&bytes.iter().enumerate().all(|(i,b)|{
        if matches!(i,8|13|18|23){*b==b'-'}else{hex(std::slice::from_ref(b))}
    })
}
fn segment(value:&str,pattern:&Segment)->bool{
    let b=value.as_bytes();
    match pattern{
        Segment::Literal(expected)=>value==expected,
        Segment::Uuid=>uuid(value),
        Segment::Task=>b.len()==64&&hex(b),
        Segment::Key=>!b.is_empty()&&b.len()<=128&&b[0].is_ascii_alphanumeric()&&
            b.iter().all(|x|x.is_ascii_alphanumeric()||*x==b'-'),
        Segment::Version=>!b.is_empty()&&matches!(b[0],b'1'..=b'9')&&b.iter().all(u8::is_ascii_digit),
    }
}
fn parse(source:&str)->Option<Vec<Rule>>{
    if source.len()>512*1024{return None;}
    let mut rules=Vec::new();
    for line in source.lines(){
        if rules.len()>=2048{return None;}
        let mut fields=line.split('\t');
        let method=fields.next()?.parse::<u32>().ok()?;
        let roles=fields.next()?.parse::<u32>().ok()?;
        let path=fields.next()?.strip_prefix("/api/")?;
        if fields.next().is_some()||!matches!(method,1|2)||roles==0||roles>127{return None;}
        let mut segments=Vec::new();
        for part in path.split('/'){
            if segments.len()>=32{return None;}
            segments.push(match part{
                "@uuid"=>Segment::Uuid,"@key"=>Segment::Key,"@version"=>Segment::Version,"@task"=>Segment::Task,
                literal if !literal.is_empty()&&literal.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'-')=>
                    Segment::Literal(literal.to_owned()),
                _=>return None,
            });
        }
        rules.push(Rule{method,roles,segments});
    }
    (!rules.is_empty()).then_some(rules)
}
pub fn install(bytes:&[u8])->bool{
    let parsed=std::str::from_utf8(bytes).ok().and_then(parse);
    RULES.with(|cell|{
        let mut rules=cell.borrow_mut();
        match parsed{Some(next)=>{*rules=next;true},None=>{rules.clear();false}}
    })
}
fn restricted(method:u32,role:u32,path:&str)->bool{
    if role!=2{return false;}
    if method==1{return matches!(path,"/api/state"|"/api/governance-documents");}
    if method!=2{return false;}
    let Some(tail)=path.strip_prefix("/api/governance-documents/records/")else{return false;};
    let parts:Vec<_>=tail.split('/').take(5).collect();
    parts.len()==4&&uuid(parts[0])&&parts[1]=="revisions"&&uuid(parts[2])&&
        matches!(parts[3],"read"|"return"|"publish")
}
// 0=allowed, 1=no route, 2=denied, 3=restricted reviewer seat.
pub fn authorize(method:u32,role:u32,limited:bool,path:&[u8])->u32{
    let Ok(path)=std::str::from_utf8(path)else{return if limited{3}else{1};};
    if limited&&!restricted(method,role,path){return 3;}
    let Some(tail)=path.strip_prefix("/api/")else{return 1;};
    let parts:Vec<_>=tail.split('/').take(33).collect();
    if parts.len()>32{return 1;}
    RULES.with(|cell|{
        for rule in cell.borrow().iter(){
            if rule.method==method&&rule.segments.len()==parts.len()&&
                parts.iter().zip(&rule.segments).all(|(value,pattern)|segment(value,pattern)){
                return if role!=0&&role.is_power_of_two()&&rule.roles&role!=0{0}else{2};
            }
        }
        1
    })
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn exact_paths_roles_and_reviewer_seat(){
        assert!(install(b"1\t3\t/api/state\n2\t2\t/api/governance-documents/records/@uuid/revisions/@uuid/publish\n"));
        assert_eq!(authorize(1,1,false,b"/api/state"),0);
        assert_eq!(authorize(1,4,false,b"/api/state"),2);
        assert_eq!(authorize(1,2,false,b"/api/state/"),1);
        assert_eq!(authorize(1,2,false,b"/api/state\n"),1);
        assert_eq!(authorize(1,1,true,b"/api/state"),3);
        assert_eq!(authorize(1,2,true,b"/api/state"),0);
        assert_eq!(authorize(1,2,true,b"/api/other"),3);
        assert!(!install(b"1\t128\t/api/state"));
        assert_eq!(authorize(1,1,false,b"/api/state"),1);
    }
}
