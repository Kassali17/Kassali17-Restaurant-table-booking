const fs = require('fs');
const path = require('path');

async function downloadImage(url, filepath) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
    if (!res.ok) throw new Error(`bad status ${res.status}`);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(filepath, Buffer.from(buffer));
    return filepath;
}

async function fetchWikiImage(query, filename) {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&pithumbsize=600`;
    
    try {
        const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
        const json = await res.json();
        
        if (json.query && json.query.pages) {
            const pages = json.query.pages;
            const pageId = Object.keys(pages)[0];
            const imageUrl = pages[pageId].thumbnail?.source;
            
            if (imageUrl) {
                await downloadImage(imageUrl, path.join('./public/images', filename));
                console.log(`[SUCCESS] Downloaded ${filename} using query "${query}"`);
                return true;
            }
        }
        console.log(`[NOT FOUND] No image for "${query}"`);
        return false;
    } catch(e) {
        throw e;
    }
}

async function run() {
    const items = [
        { q: 'Orange juice', f: 'orange_juice.jpg' },
        { q: 'Watermelon juice', f: 'watermelon_juice.jpg' },
        { q: 'Mango smoothie', f: 'mango_shake.jpg' },
        { q: 'Pineapple juice', f: 'pineapple_juice.jpg' },
        { q: 'Mint lemonade', f: 'lemon_mint_cooler.jpg' }
    ];

    for (let item of items) {
        try {
            await fetchWikiImage(item.q, item.f);
        } catch(e) {
            console.error(`Error on ${item.f}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

run();
