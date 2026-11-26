//! Bounded aggregation of already-redacted numeric report dimensions.
use std::collections::BTreeMap;
const MAX_ROWS:usize=16384;
pub struct Aggregation{
    pub total:u32,pub undated:u32,pub areas:u32,pub buckets:BTreeMap<u32,u32>,
}
pub fn aggregate(bytes:&[u8],workflow:u32,stage:u32,outcome:u32,group:u32,from:u32,to:u32)->Option<Aggregation>{
    if bytes.len()%16!=0||bytes.len()/16>MAX_ROWS||group>4{return None;}
    let mut result=Aggregation{total:0,undated:0,areas:0,buckets:BTreeMap::new()};
    for row in bytes.chunks_exact(16){
        let mut values=[0u32;4];
        for (target,word) in values.iter_mut().zip(row.chunks_exact(4)){
            *target=u32::from_le_bytes(word.try_into().ok()?);
        }
        let [w,s,o,d]=values;
        if w==0||w>31||s>255||o>255{return None;}
        if (workflow!=0&&workflow!=w)||(stage!=0&&stage!=s)||(outcome!=0&&outcome!=o){continue;}
        if (from!=0&&(d==0||d<from))||(to!=0&&(d==0||d>to)){continue;}
        let key=match group{0=>w,1=>s,2=>o,3=>d,4=>d/100,_=>return None};
        *result.buckets.entry(key).or_insert(0)+=1;
        result.areas|=1u32<<(w-1);result.total+=1;
        if d==0{result.undated+=1;}
    }
    Some(result)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn filters_buckets_and_undated(){
        let rows=[[1u32,1,0,20260102],[2,2,0,20260203],[1,2,0,0]];
        let bytes:Vec<u8>=rows.iter().flatten().flat_map(|n|n.to_le_bytes()).collect();
        let all=aggregate(&bytes,0,0,0,4,0,0).unwrap();
        assert_eq!(all.total,3);assert_eq!(all.undated,1);assert_eq!(all.areas,3);
        assert_eq!(all.buckets.get(&202601),Some(&1));
        let filter=aggregate(&bytes,1,0,0,0,20260101,20261231).unwrap();
        assert_eq!(filter.total,1);assert_eq!(filter.undated,0);assert_eq!(filter.areas,1);
        assert!(aggregate(&[1,2],0,0,0,0,0,0).is_none());
    }
}
