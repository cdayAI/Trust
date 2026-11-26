//! Domain decisions independent of the state snapshot and storage layer.
// Incident flags: containment, findings, elevated, impact evidence,
// prior more-information decision, and investigation advanced since review.
pub fn incident_ready(flags:u32,evidence_count:u32)->bool{
    let elevated=flags&4!=0;
    flags&1!=0&&flags&2!=0&&evidence_count>=if elevated{2}else{1}&&
        (!elevated||flags&8!=0)&&(flags&16==0||flags&32!=0)
}
// Retention flags: active hold, schedule exists, trigger recorded, before due.
// Hold precedence is deliberate; never simulate disposition while held.
pub fn retention_reason(flags:u32)->u32{
    if flags&1!=0{0}else if flags&2==0{1}else if flags&4==0{2}else if flags&8!=0{3}else{4}
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn readiness_and_hold_precedence(){
        assert!(incident_ready(3,1));
        assert!(!incident_ready(7,2));
        assert!(incident_ready(15,2));
        assert!(!incident_ready(31,2));
        assert!(incident_ready(63,2));
        assert_eq!(retention_reason(15),0);
        assert_eq!(retention_reason(0),1);
        assert_eq!(retention_reason(2),2);
        assert_eq!(retention_reason(14),3);
        assert_eq!(retention_reason(6),4);
    }
}
