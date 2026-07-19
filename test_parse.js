import fs from 'fs';

// Look for any mock data or cached data in frontend
const files = fs.readdirSync('./packages/frontend/src/data');
console.log(files);
