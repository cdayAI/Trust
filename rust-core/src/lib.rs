//! Bounded, deterministic domain primitives. No host I/O, dependencies, or unsafe Rust.
#![deny(unsafe_op_in_unsafe_fn)]
use std::cell::RefCell;
mod graph;
mod raster;

const MAX_BUFFER: usize = 8 * 1024 * 1024;
const INVALID: i32 = i32::MIN;

thread_local! {
    static BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn trust_abi() -> u32 { 1 }

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
