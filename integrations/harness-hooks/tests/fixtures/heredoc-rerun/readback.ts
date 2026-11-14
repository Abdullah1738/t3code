import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
console.log(JSON.stringify({ count: rows.length }));
