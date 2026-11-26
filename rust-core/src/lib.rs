//! Bounded, deterministic domain primitives. No host I/O, dependencies, or unsafe Rust.
#![deny(unsafe_op_in_unsafe_fn)]
use std::cell::RefCell;
mod graph;
mod raster;
mod archive;
mod batch;
mod domain;
mod report;
mod policy;
mod workflow;
mod storage;
mod lifecycle;
mod http_boundary;

const MAX_BUFFER: usize = 8 * 1024 * 1024;
const INVALID: i32 = i32::MIN;

thread_local! {
    static BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn trust_abi() -> u32 { 8 }

// The host borrows this byte range only until the next reserve call. Each
// invocation is synchronous, and Rust only accesses the owned Vec via slices.
#[no_mangle]
pub extern "C" fn trust_reserve(len: u32) -> u32 {
    if len as usize > MAX_BUFFER { return 0; }
    BUFFER.with(|cell| {
        let mut data = cell.borrow_mut();
        data.resize(len as usize, 0);
        data.as_mut_ptr() as usize as u32
    })
}

#[no_mangle]
pub extern "C" fn trust_raster(kind: u32) -> u32 {
    BUFFER.with(|cell| raster::inspect(kind, &cell.borrow()))
}

#[no_mangle]
pub extern "C" fn trust_trace(nodes: u32, edges: u32, start: u32) -> i32 {
    BUFFER.with(|cell| {
        let mut data = cell.borrow_mut();
        let input = match (edges as usize).checked_mul(8) {
            Some(n) => n, None => return -1
        };
        let output = match data.get(..input) {
            Some(bytes) => graph::trace(nodes as usize, bytes, start as usize),
            None => None,
        };
        let output = match output { Some(v) => v, None => return -1 };
        let tail = match data.get_mut(input..) { Some(t) => t, None => return -1 };
        if tail.len() < output.len() * 4 { return -1; }
        for (dst, value) in tail.chunks_exact_mut(4).zip(&output) {
            dst.copy_from_slice(&(*value as u32).to_le_bytes());
        }
        output.len() as i32
    })
}

#[no_mangle]
pub extern "C" fn trust_acyclic(nodes: u32) -> i32 {
    BUFFER.with(|cell| match graph::acyclic(nodes as usize, &cell.borrow()) {
        Some(true) => 1, Some(false) => 0, None => -1
    })
}

fn due_day(from: i32, days: u32, business: bool, closed: &[i32]) -> Option<i32> {
    if days > 100_000 || closed.len() > 64 { return None; }
    if !business { return from.checked_add(days as i32); }
    let mut day = from;
    let mut count = 0;
    while count < days {
        day = day.checked_add(1)?;
        // Unix epoch was Thursday. Sunday=0, Saturday=6, including pre-1970.
        let weekday = (i64::from(day) + 4).rem_euclid(7);
        if weekday != 0 && weekday != 6 && !closed.contains(&day) { count += 1; }
    }
    Some(day)
}

#[no_mangle]
pub extern "C" fn trust_due_day(from: i32, days: u32, business: u32) -> i32 {
    BUFFER.with(|cell| {
        let bytes = cell.borrow();
        if business > 1 || bytes.len() % 4 != 0 || bytes.len() > 64 * 4 { return INVALID; }
        let closed: Vec<i32> = bytes.chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        due_day(from, days, business == 1, &closed).unwrap_or(INVALID)
    })
}

#[no_mangle]
pub extern "C" fn trust_zip(input: u32) -> i32 {
    BUFFER.with(|cell| {
        let mut bytes = cell.borrow_mut();
        let count_bytes = input as usize;
        let rows = match bytes.get(..count_bytes).and_then(archive::parse) {
            Some(rows) => rows, None => return -1,
        };
        let output = match bytes.get_mut(count_bytes..) {
            Some(output) => output, None => return -1,
        };
        if output.len() < rows.len()*archive::ENTRY_WORDS*4 { return -1; }
        for (dst,value) in output.chunks_exact_mut(4).zip(rows.iter().flatten()) {
            dst.copy_from_slice(&value.to_le_bytes());
        }
        rows.len() as i32
    })
}

#[no_mangle]
pub extern "C" fn trust_batch_header(frame_len: u32) -> i32 {
    BUFFER.with(|cell| batch::header(frame_len,&cell.borrow()))
}

#[no_mangle]
pub extern "C" fn trust_batch_layout(frame_len: u32, manifest: u32) -> i32 {
    BUFFER.with(|cell| {
        let mut bytes = cell.borrow_mut();
        if bytes.len() % 4 != 0 || bytes.len() > batch::MAX_FILES*4 { return batch::INVALID; }
        let sizes: Vec<u32> = bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0],c[1],c[2],c[3]])).collect();
        let offsets = match batch::layout(frame_len,manifest,&sizes) {
            Ok(offsets) => offsets, Err(status) => return status,
        };
        for (dst,value) in bytes.chunks_exact_mut(4).zip(&offsets) {
            dst.copy_from_slice(&value.to_le_bytes());
        }
        offsets.len() as i32
    })
}

#[no_mangle]
pub extern "C" fn trust_workflow_permission(role:u32,allowed:u32,independent:u32,actor:u32,legacy:u32,creator:u32)->u32{
    BUFFER.with(|cell|{
        let bytes=cell.borrow();
        if bytes.len()%4!=0{return 3;}
        let contributors:Vec<u32>=bytes.chunks_exact(4).map(|c|u32::from_le_bytes([c[0],c[1],c[2],c[3]])).collect();
        domain::permission(role,allowed,independent!=0,actor,legacy,creator,&contributors)
    })
}
#[no_mangle]
pub extern "C" fn trust_risk_score(profile:u32,likelihood:u32,impact:u32,extras:u32)->i32{
    domain::score(profile,likelihood,impact,extras).map(|v|v as i32).unwrap_or(-1)
}
#[no_mangle]
pub extern "C" fn trust_link_status(flags:u32,review:u32)->u32{domain::link_status(flags,review)}
#[no_mangle]
pub extern "C" fn trust_reductions()->i32{
    BUFFER.with(|cell|domain::reductions(&cell.borrow()).map(|v|v as i32).unwrap_or(-1))
}
#[no_mangle]
pub extern "C" fn trust_account_live(disabled:u32,has_expiry:u32,now:f64,valid_until:f64)->u32{
    domain::account_live(disabled!=0,has_expiry!=0,now,valid_until) as u32
}
#[no_mangle]
pub extern "C" fn trust_cookie(name_len:u32,header_len:u32)->i32{
    BUFFER.with(|cell|{
        let mut bytes=cell.borrow_mut();
        let name_len=name_len as usize;
        let Some(input_len)=name_len.checked_add(header_len as usize) else{return -1;};
        let token={
            let Some(name)=bytes.get(..name_len).and_then(|b|std::str::from_utf8(b).ok()) else{return -1;};
            let Some(header)=bytes.get(name_len..input_len).and_then(|b|std::str::from_utf8(b).ok()) else{return -1;};
            let Some(token)=domain::cookie(name,header) else{return 0;};
            let Ok(token)=<&[u8;43]>::try_from(token.as_bytes()) else{return -1;};
            *token
        };
        let Some(output)=bytes.get_mut(input_len..) else{return -1;};
        if output.len()!=43{return -1;}
        output.copy_from_slice(&token);1
    })
}

#[no_mangle]
pub extern "C" fn trust_report(input:u32,workflow:u32,stage:u32,outcome:u32,group:u32,from:u32,to:u32)->i32{
    BUFFER.with(|cell|{
        let mut bytes=cell.borrow_mut();
        let input=input as usize;
        let result=match bytes.get(..input).and_then(|b|report::aggregate(b,workflow,stage,outcome,group,from,to)){
            Some(result)=>result,None=>return -1
        };
        let Some(output)=bytes.get_mut(input..) else{return -1;};
        let count=result.buckets.len();
        if output.len()<12+count*8{return -1;}
        let words=[result.total,result.undated,result.areas].into_iter()
            .chain(result.buckets.into_iter().flat_map(|(key,count)|[key,count]));
        for (dst,word) in output.chunks_exact_mut(4).zip(words){dst.copy_from_slice(&word.to_le_bytes());}
        count as i32
    })
}

#[no_mangle]
pub extern "C" fn trust_routes_init()->u32{
    BUFFER.with(|cell|policy::install(&cell.borrow()) as u32)
}
#[no_mangle]
pub extern "C" fn trust_authorize(method:u32,role:u32,limited:u32)->u32{
    BUFFER.with(|cell|policy::authorize(method,role,limited!=0,&cell.borrow()))
}
#[no_mangle]
pub extern "C" fn trust_revision(expected:f64,actual:f64,min:u32)->u32{
    workflow::revision(expected,actual,min)
}
#[no_mangle]
pub extern "C" fn trust_transition(input:u32,available:u32,role:u32,allowed:u32,
    independent:u32,actor:u32,legacy:u32,creator:u32)->i32{
    BUFFER.with(|cell|{
        let mut bytes=cell.borrow_mut();
        let length=input as usize;
        let result=match bytes.get(..length).and_then(|b|workflow::plan(b,available!=0,role,allowed,independent!=0,actor,legacy,creator)){
            Some(plan)=>plan,None=>return -1
        };
        let Some(output)=bytes.get_mut(length..)else{return -1;};
        let required=8+result.ranges.len()*8+result.contributors.len()*4;
        if output.len()<required{return -1;}
        let words=[result.missing,result.contributors.len() as u32].into_iter()
            .chain(result.ranges.into_iter().flat_map(|(a,b)|[a,b]))
            .chain(result.contributors);
        for (dst,word) in output.chunks_exact_mut(4).zip(words){dst.copy_from_slice(&word.to_le_bytes());}
        result.status as i32
    })
}
#[no_mangle]
pub extern "C" fn trust_answer(input:u32,flags:u32,kind:u32)->i32{
    BUFFER.with(|cell|{
        let mut bytes=cell.borrow_mut();
        let length=input as usize;
        let (status,start,end)=match bytes.get(..length).and_then(|b|workflow::answer(b,flags,kind)){
            Some(result)=>result,None=>return -1
        };
        let Some(output)=bytes.get_mut(length..)else{return -1;};
        if output.len()!=8{return -1;}
        output[..4].copy_from_slice(&start.to_le_bytes());
        output[4..].copy_from_slice(&end.to_le_bytes());
        status as i32
    })
}
#[no_mangle]
pub extern "C" fn trust_storage_scope()->u32{
    BUFFER.with(|cell|storage::scope(&cell.borrow()))
}
#[no_mangle]
pub extern "C" fn trust_storage_generation(value:f64)->u32{
    storage::positive_generation(value) as u32
}
#[no_mangle]
pub extern "C" fn trust_storage_payload(kind:u32,version:f64,arrays:u32)->u32{
    storage::payload_shape(kind,version,arrays) as u32
}
#[no_mangle]
pub extern "C" fn trust_backup_header(archive_size:f64)->i32{
    BUFFER.with(|cell|storage::encrypted_size(&cell.borrow(),archive_size).map(|size|size as i32).unwrap_or(-1))
}
#[no_mangle]
pub extern "C" fn trust_incident_ready(flags:u32,evidence_count:u32)->u32{
    lifecycle::incident_ready(flags,evidence_count) as u32
}
#[no_mangle]
pub extern "C" fn trust_retention_reason(flags:u32)->u32{
    lifecycle::retention_reason(flags)
}
#[no_mangle]
pub extern "C" fn trust_http_connection(flags:u32)->u32{
    BUFFER.with(|cell|http_boundary::connection(&cell.borrow(),flags))
}
#[no_mangle]
pub extern "C" fn trust_http_post(flags:u32)->u32{
    BUFFER.with(|cell|http_boundary::post(&cell.borrow(),flags))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_and_business_days() {
        assert_eq!(due_day(0, 1, true, &[]), Some(1));
        assert_eq!(due_day(1, 1, true, &[]), Some(4));
        assert_eq!(due_day(1, 1, true, &[4]), Some(5));
        assert_eq!(due_day(-3, 1, true, &[]), Some(-2));
        assert_eq!(due_day(1, 3, false, &[2]), Some(4));
        assert_eq!(due_day(i32::MAX, 1, false, &[]), None);
    }
}
