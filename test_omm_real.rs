use sgp4::Elements;
use std::fs;

fn main() {
    let data = fs::read_to_string("packages/frontend/public/mock-data/visual-list.json").unwrap_or_default();
    if data.is_empty() {
        println!("No mock data found");
        return;
    }
    let els: Result<Vec<Elements>, _> = serde_json::from_str(&data);
    println!("{:?}", els.err());
}
