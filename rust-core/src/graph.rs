//! Directed graph kernels. Preserve input adjacency ordering and count parallel edges.
const MAX_NODES: usize = 100_000;
const MAX_EDGES: usize = 500_000;

fn adjacency(nodes: usize, input: &[u8]) -> Option<Vec<Vec<usize>>> {
    if nodes > MAX_NODES || input.len() % 8 != 0 || input.len() / 8 > MAX_EDGES { return None; }
    let mut rows = vec![Vec::new(); nodes];
    for edge in input.chunks_exact(8) {
        let from = u32::from_le_bytes(edge[..4].try_into().ok()?) as usize;
        let to = u32::from_le_bytes(edge[4..].try_into().ok()?) as usize;
        if from >= nodes || to >= nodes { return None; }
        rows[from].push(to);
    }
    Some(rows)
}

pub fn trace(nodes: usize, input: &[u8], start: usize) -> Option<Vec<usize>> {
    let edges = adjacency(nodes, input)?;
    if start >= nodes { return None; }
    let mut seen = vec![false; nodes];
    let mut queue = vec![start];
    seen[start] = true;
    let mut cursor = 0;
    while cursor < queue.len() {
        for &next in &edges[queue[cursor]] {
            if !seen[next] {
                seen[next] = true;
                queue.push(next);
            }
        }
        cursor += 1;
    }
    queue.remove(0);
    Some(queue)
}

pub fn acyclic(nodes: usize, input: &[u8]) -> Option<bool> {
    let edges = adjacency(nodes, input)?;
    let mut incoming = vec![0usize; nodes];
    for row in &edges {
        for &next in row { incoming[next] += 1; }
    }
    let mut queue: Vec<usize> = (0..nodes).filter(|&i| incoming[i] == 0).collect();
    let mut cursor = 0;
    while cursor < queue.len() {
        for &next in &edges[queue[cursor]] {
            incoming[next] -= 1;
            if incoming[next] == 0 { queue.push(next); }
        }
        cursor += 1;
    }
    Some(queue.len() == nodes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(edges: &[(u32,u32)]) -> Vec<u8> {
        edges.iter().flat_map(|&(a,b)| [a.to_le_bytes(), b.to_le_bytes()].concat()).collect()
    }
    #[test]
    fn order_duplicates_cycles_and_invalid_endpoints() {
        let edges = input(&[(0,2),(0,1),(2,3),(1,3),(0,2)]);
        assert_eq!(trace(4,&edges,0),Some(vec![2,1,3]));
        assert_eq!(acyclic(4,&edges),Some(true));
        assert_eq!(acyclic(3,&input(&[(0,1),(1,0)])),Some(false));
        assert_eq!(trace(2,&input(&[(0,2)]),0),None);
        assert_eq!(acyclic(0,&[]),Some(true));
    }
}
